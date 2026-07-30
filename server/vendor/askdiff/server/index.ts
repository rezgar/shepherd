import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
} from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { ClaudeCliError, streamAnswer } from "./claude.js";
import { DiffError, getDiff } from "./util/diff.js";
import { checkStaleness } from "./util/staleness.js";
import { captureWorkingTreeDiff } from "./util/working-tree-diff.js";
import { watchWorkingTree } from "./util/watch.js";
import { PROTOCOL_VERSION, parseClientMessage, type AskMessage } from "../protocol/index.js";
import { DEFAULT_HOST, DEFAULT_IDLE_SHUTDOWN_MS } from "./util/constants.js";
import { send } from "./util/ws.js";

export const WS_PATH = "/ws";

export interface ServerState {
  cwd: string;
  claudeSessionId: string;
  clients: Set<WebSocket>;
  diffFile: string;
  diffLabel?: string;
  // True when the diff is captured from the working tree (i.e. its
  // contents can drift as the user edits files). Triggers the
  // staleness check on every diff push.
  volatile: boolean;
  // Overrides the working-tree diff's base (default `HEAD`) on every
  // recompute. Ignored when `volatile` is false — history-based diffs are
  // whatever `diffFile` already contains.
  baseRef?: string;
}

export interface StartServerOptions {
  cwd: string;
  sessionId: string;
  // Path to a unified diff file the skill produced (e.g. via `git diff
  // HEAD~1 HEAD > $diffFile`). The server treats this as the single source
  // of truth for history-based diffs — it never invokes git itself for
  // those. The one exception is the working-tree (`volatile`) case below,
  // where the server keeps this file (and connected clients) in sync on
  // its own.
  diffFile: string;
  // Short human description of the diff for the UI badge.
  diffLabel?: string;
  // Whether the diff was captured from the working tree. Defaults to
  // false (history-based diffs are immutable). When true, the server
  // watches the working tree and automatically recomputes + rewrites
  // `diffFile` and broadcasts the refreshed diff on every change, so
  // mtime-based staleness should stay perpetually resolved outside of a
  // brief in-flight window.
  volatile?: boolean;
  // Overrides the working-tree diff's base (default `HEAD`) — see
  // `ServerState.baseRef`. Only meaningful alongside `volatile: true`.
  baseRef?: string;
  // Standalone mode: pass `port` (and optionally `host`) and the server
  // creates its own HTTP listener.
  port?: number;
  host?: string;
  // Mount mode: pass an already-constructed HTTP server (e.g. one that
  // also serves static files) and the WebSocket upgrade is attached to it.
  // When set, `port` and `host` are ignored — the caller owns lifecycle.
  httpServer?: HttpServer;
  idleShutdownMs?: number;
  onListening?: (port: number) => void;
}

export interface ServerHandle {
  port: number;
  close: () => Promise<void>;
}

async function sendDiff(ws: WebSocket, state: ServerState): Promise<void> {
  try {
    const { raw, files } = await getDiff(state.diffFile);
    const staleness = state.volatile
      ? await checkStaleness(state.diffFile, state.cwd, files)
      : { stale: false, staleFiles: [] };
    send(ws, {
      type: "diff",
      raw,
      files,
      ...(state.diffLabel !== undefined ? { label: state.diffLabel } : {}),
      ...(staleness.stale
        ? { stale: true, staleFiles: staleness.staleFiles }
        : {}),
    });
  } catch (err) {
    const message =
      err instanceof DiffError ? err.message : `unexpected diff error: ${String(err)}`;
    send(ws, { type: "error", message });
  }
}

// Recomputes the working-tree diff and, if it actually changed, rewrites
// `diffFile` and pushes the fresh diff to every connected client. Errors
// (e.g. a transient git failure mid-edit) are reported to clients the
// same way a bad `diffFile` read is, rather than crashing the watcher.
async function refreshWorkingTree(state: ServerState): Promise<void> {
  let raw: string;
  try {
    raw = await captureWorkingTreeDiff(state.cwd, state.baseRef);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : `unexpected working-tree diff error: ${String(err)}`;
    for (const ws of state.clients) send(ws, { type: "error", message });
    return;
  }

  const previous = await readFile(state.diffFile, "utf8").catch(() => null);
  if (raw === previous) return; // nothing actually changed — skip the churn

  await writeFile(state.diffFile, raw, "utf8");
  for (const ws of state.clients) void sendDiff(ws, state);
}

async function handleAsk(
  ws: WebSocket,
  state: ServerState,
  ask: AskMessage,
  controllers: Map<string, AbortController>,
): Promise<void> {
  if (controllers.has(ask.id)) {
    send(ws, { type: "error", id: ask.id, message: `duplicate ask id: ${ask.id}` });
    return;
  }

  const controller = new AbortController();
  controllers.set(ask.id, controller);

  try {
    for await (const delta of streamAnswer({
      cwd: state.cwd,
      sessionId: state.claudeSessionId,
      ask,
      signal: controller.signal,
    })) {
      if (controller.signal.aborted) return;
      send(ws, { type: "chunk", id: ask.id, delta });
    }

    if (!controller.signal.aborted) {
      send(ws, { type: "done", id: ask.id });
    }
  } catch (err) {
    if (controller.signal.aborted) return;
    send(ws, { type: "error", id: ask.id, message: errorMessage(err) });
  } finally {
    controllers.delete(ask.id);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof ClaudeCliError) return err.message;
  if (err instanceof DiffError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function startServer(opts: StartServerOptions): Promise<ServerHandle> {
  const idleShutdownMs = opts.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;

  const state: ServerState = {
    cwd: opts.cwd,
    claudeSessionId: opts.sessionId,
    clients: new Set(),
    diffFile: opts.diffFile,
    ...(opts.diffLabel !== undefined ? { diffLabel: opts.diffLabel } : {}),
    volatile: opts.volatile ?? false,
    ...(opts.baseRef !== undefined ? { baseRef: opts.baseRef } : {}),
  };

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });

  const ownsHttpServer = !opts.httpServer;
  const httpServer: HttpServer =
    opts.httpServer ??
    createHttpServer((_req, res) => {
      // Standalone mode: this HTTP server only exists to host the WS
      // upgrade. Any actual GET request gets a 404.
      res.statusCode = 404;
      res.end();
    });

  // Idle shutdown: when the last client disconnects, exit after this many
  // ms of inactivity. Set to 0 to disable.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const armIdleTimer = () => {
    clearIdleTimer();
    if (idleShutdownMs <= 0) return;
    idleTimer = setTimeout(() => {
      console.log(
        `no clients for ${String(Math.round(idleShutdownMs / 1000))}s; shutting down.`,
      );
      // Best-effort close, then exit. The CLI/script entry point relies on
      // this to release the port; tests that use this library directly can
      // pass `idleShutdownMs: 0` to opt out.
      void workingTreeWatcher?.close();
      wss.close();
      if (ownsHttpServer) httpServer.close();
      setTimeout(() => process.exit(0), 100).unref();
      setTimeout(() => process.exit(1), 5000).unref();
    }, idleShutdownMs);
  };

  // Working-tree sessions keep themselves live: watch the project for
  // filesystem changes and recompute the diff instead of waiting for the
  // user to re-run `/askdiff`. A simple in-flight/pending pair coalesces
  // bursts of change events into "run once more after the current run
  // finishes" rather than racing overlapping recomputes.
  let workingTreeWatcher: { close: () => Promise<void> } | null = null;
  if (state.volatile) {
    let refreshing = false;
    let refreshPending = false;
    const runRefresh = () => {
      void (async () => {
        if (refreshing) {
          refreshPending = true;
          return;
        }
        refreshing = true;
        try {
          await refreshWorkingTree(state);
        } finally {
          refreshing = false;
          if (refreshPending) {
            refreshPending = false;
            runRefresh();
          }
        }
      })();
    };
    workingTreeWatcher = watchWorkingTree(state.cwd, runRefresh);
  }

  wss.on("connection", (ws) => {
    const connectionId = randomUUID();
    const controllers = new Map<string, AbortController>();

    clearIdleTimer();
    state.clients.add(ws);

    send(ws, {
      type: "hello",
      protocol: PROTOCOL_VERSION,
      project: opts.cwd,
    });

    // Read-only advertisement: tell the UI which session asks will land
    // in. The session is locked at startup; no runtime change path.
    send(ws, { type: "session", session_id: state.claudeSessionId });

    void sendDiff(ws, state);

    ws.on("message", (data) => {
      const text = Buffer.isBuffer(data)
        ? data.toString("utf8")
        : Array.isArray(data)
          ? Buffer.concat(data).toString("utf8")
          : Buffer.from(data).toString("utf8");
      const parsed = parseClientMessage(text);

      if (!parsed.ok) {
        send(ws, { type: "error", message: parsed.error });
        return;
      }

      const msg = parsed.value;

      switch (msg.type) {
        case "ask":
          void handleAsk(ws, state, msg, controllers);
          return;
        case "cancel": {
          const controller = controllers.get(msg.id);
          if (controller) {
            controller.abort();
            controllers.delete(msg.id);
          }
          return;
        }
        case "diff_request":
          void sendDiff(ws, state);
          return;
        case "ping":
          send(ws, { type: "pong" });
          return;
      }
    });

    ws.on("close", () => {
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
      state.clients.delete(ws);
      if (state.clients.size === 0) armIdleTimer();
    });

    ws.on("error", (err) => {
      console.error(`[${connectionId}] socket error:`, err);
    });
  });

  const upgradeHandler = (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (req.url !== WS_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  };
  httpServer.on("upgrade", upgradeHandler);

  let resolvedPort: number;
  if (ownsHttpServer) {
    const desiredPort = opts.port ?? 0;
    const host = opts.host ?? DEFAULT_HOST;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        httpServer.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        httpServer.off("error", onError);
        resolve();
      };
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(desiredPort, host);
    });
    const addr = httpServer.address();
    if (addr === null || typeof addr === "string") {
      throw new Error("httpServer.address() returned unexpected value");
    }
    resolvedPort = addr.port;
  } else {
    const addr = httpServer.address();
    if (addr === null || typeof addr === "string") {
      throw new Error(
        "httpServer must be listening before being passed to startServer()",
      );
    }
    resolvedPort = addr.port;
  }

  opts.onListening?.(resolvedPort);
  // Arm the idle timer immediately so a server with zero connects also retires.
  armIdleTimer();

  return {
    port: resolvedPort,
    close: async () => {
      clearIdleTimer();
      await workingTreeWatcher?.close();
      httpServer.off("upgrade", upgradeHandler);
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      if (ownsHttpServer) {
        await new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
        });
      }
    },
  };
}

