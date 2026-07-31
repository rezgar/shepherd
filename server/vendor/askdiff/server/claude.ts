import { spawn } from "node:child_process";
import type { AskMessage } from "../protocol/index.js";
import { createIdleTimeout } from "./util/idleTimeout.js";
import { ASK_IDLE_TIMEOUT_MS } from "./util/constants.js";
import { resolveClaudeExecutable } from "../../../src/claudeExecutable.js";

export class ClaudeCliError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "ClaudeCliError";
  }
}

export interface StreamAnswerParams {
  cwd: string;
  sessionId: string;
  ask: AskMessage;
  signal: AbortSignal;
}

export async function* streamAnswer(
  params: StreamAnswerParams,
): AsyncGenerator<string, void, void> {
  const prompt = buildPrompt(params.ask);
  const model = params.ask.model ?? process.env["ASKDIFF_MODEL"];
  const args = buildArgs(params.sessionId, model);

  const child = spawn(resolveClaudeExecutable(), args, {
    cwd: params.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv(),
  });

  const onAbort = () => {
    if (!child.killed) child.kill("SIGTERM");
  };
  params.signal.addEventListener("abort", onAbort);

  // spawn() reports failures to launch the process at all (bad executable
  // path, permissions, …) via an async `error` event, not a thrown
  // exception — and Node's EventEmitter throws an UNCAUGHT exception if
  // nothing is listening for `error`, well past this function's own
  // try/catch below (confirmed live: a bare `spawn("claude", ...)` here
  // ENOENT'd inside the packaged desktop app, whose process PATH doesn't
  // resolve the CLI's shim the way a normal terminal does, and it crashed
  // straight to the daemon's top-level uncaughtException handler — no
  // `chunk`/`done`/`error` WS message ever went out, so the ask sat in
  // "streaming" state forever). Listening here converts that into an
  // ordinary, reportable failure, independent of whatever else the
  // executable-path fix above already prevents — any other reason spawn
  // might fail follows this same path instead of taking the daemon's
  // console down with it.
  let spawnError: Error | null = null;
  child.on("error", (err) => {
    spawnError = err;
    if (!child.killed) child.kill("SIGTERM");
  });

  // Nothing here previously bounded how long an ask would wait for the next
  // byte of output — a stalled `claude -p --resume` child (hung CLI,
  // colliding concurrent `--resume` against a session with a live
  // interactive process attached, network stall, whatever) left the async
  // generator's `for await (const chunk of child.stdout)` below waiting
  // forever, so the WS side never got a `chunk`, `done`, or `error` and the
  // ask sat in "streaming" state permanently with no feedback. Armed
  // immediately (covers a child that never writes anything at all) and
  // touched on every raw stdout chunk, not just successfully parsed lines,
  // so a slow-but-alive stream never trips it.
  let timedOut = false;
  const idleTimeout = createIdleTimeout(ASK_IDLE_TIMEOUT_MS, () => {
    timedOut = true;
    if (!child.killed) child.kill("SIGTERM");
  });

  const stderrChunks: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrChunks.push(chunk);
  });
  // A process that never actually spawned can also surface the failure as
  // an `error` on its own stdio streams (e.g. writing to `stdin` below) —
  // same unhandled-throw hazard as the child's own `error` event above.
  // The failure itself is already captured there; these just need to not
  // be silently-unlistened-to.
  child.stdin.on("error", () => {});
  child.stderr.on("error", () => {});

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on("close", (code, sig) => resolve({ code, signal: sig }));
    },
  );

  child.stdin.end(prompt);

  // The CLI reports API errors (billing, auth, invalid session, …) as a
  // `result` event with `is_error: true` — usually before exit. Capture
  // the message so the WS error is actionable instead of "exited 1".
  let apiError: string | null = null;
  const handleLine = (line: string): string | null => {
    const delta = extractTextDelta(line);
    if (delta !== null) return delta;
    const err = extractApiError(line);
    if (err !== null) apiError = err;
    return null;
  };

  try {
    child.stdout.setEncoding("utf8");
    let buffer = "";
    for await (const chunk of child.stdout) {
      idleTimeout.touch();
      buffer += chunk as string;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const delta = handleLine(line);
        if (delta !== null) yield delta;
        newline = buffer.indexOf("\n");
      }
    }
    if (buffer.length > 0) {
      const delta = handleLine(buffer);
      if (delta !== null) yield delta;
    }

    if (params.signal.aborted) return;
    // Checked before awaiting exitPromise below, not after: a process that
    // never actually spawned isn't guaranteed to ever emit `close` on every
    // platform, and this failure is already definitive — no need to wait
    // on (or risk hanging on) an event that a real process would emit but
    // this one might not.
    if (spawnError !== null) {
      const err: Error = spawnError;
      throw new ClaudeCliError(`Couldn't start claude: ${err.message}`, err);
    }

    const { code } = await exitPromise;
    if (timedOut) {
      throw new ClaudeCliError(
        `No response from Claude within ${String(Math.round(ASK_IDLE_TIMEOUT_MS / 1000))}s — the CLI process stalled and was stopped. This can happen if the session has another active process attached (e.g. its terminal). Try again.`,
      );
    }
    if (apiError !== null) {
      throw new ClaudeCliError(apiError);
    }
    if (code !== 0) {
      const stderr = stderrChunks.join("").trim().slice(-500);
      throw new ClaudeCliError(
        `claude exited with code ${code}${stderr ? `: ${stderr}` : ""}`,
      );
    }
  } finally {
    idleTimeout.cancel();
    params.signal.removeEventListener("abort", onAbort);
    if (!child.killed) child.kill("SIGTERM");
  }
}

// The parent Claude Code session is auth'd via subscription, but
// `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) in the env makes the
// spawned CLI silently switch to API billing. Strip those so the
// subprocess falls back to whichever cached auth the user already has.
const childEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env["ANTHROPIC_API_KEY"];
  delete env["ANTHROPIC_AUTH_TOKEN"];
  return env;
};

const buildArgs = (sessionId: string, model: string | undefined): string[] => {
  const args = [
    "-p",                          // print mode: non-interactive, exits after one response
    "--resume", sessionId,         // re-hydrate the session that wrote the code; new turns append to it
    "--output-format", "stream-json", // emit one JSON event per line for streaming parse
    "--include-partial-messages",  // emit content_block_delta events with token-by-token text
    "--verbose",                   // required by --output-format=stream-json under -p
  ];
  if (model) args.push("--model", model); // optional override; otherwise inherits the session's model
  return args;
}

const buildPrompt = (ask: AskMessage): string => {
  return `You are answering a question in askdiff, a read-only code-review diff viewer. This is a discussion turn, not an implementation turn.

**Do not modify the code.** Do not call Edit, Write, NotebookEdit, MultiEdit, or any Bash command that mutates the filesystem (no \`sed -i\`, \`>\`, \`mv\`, \`rm\`, \`git commit\`, \`git checkout\`, etc.). If the user asks you to "fix", "apply", "change", "refactor", "rename", "implement", or otherwise edit something, describe what the change should look like in your reply (prose, or a code block they can copy) but do not perform it. The user will apply changes themselves outside askdiff if they want to act on your suggestion.

Read-only inspection (Read, Grep, Glob, git read commands) is fine when needed, but your prior edits in this session are already in your context, so usually you can answer from memory.

Question about \`${ask.file}\` lines ${ask.from_line}-${ask.to_line}:

\`\`\`
${ask.chunk}
\`\`\`

${ask.question}`;
}

const extractTextDelta = (line: string): string | null => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(obj)) return null;
  if (obj["type"] !== "stream_event") return null;
  const event = obj["event"];
  if (!isRecord(event)) return null;
  if (event["type"] !== "content_block_delta") return null;
  const delta = event["delta"];
  if (!isRecord(delta)) return null;
  if (delta["type"] !== "text_delta") return null;
  const text = delta["text"];
  return typeof text === "string" ? text : null;
};

const extractApiError = (line: string): string | null => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(obj)) return null;
  if (obj["type"] !== "result") return null;
  if (obj["is_error"] !== true) return null;
  const result = obj["result"];
  if (typeof result !== "string" || result.length === 0) return null;
  const status = obj["api_error_status"];
  return typeof status === "number" ? `${result} (api ${String(status)})` : result;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
