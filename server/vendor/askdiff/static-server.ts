import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// esbuild strips `import.meta` to `{}` when bundling this to CJS for the
// packaged desktop app (desktop/scripts/bundle-daemon.mjs), so
// `fileURLToPath(import.meta.url)` throws on `undefined` and kills the
// daemon at require-time. The CJS `__dirname` global esbuild shims in is
// tried first; the ESM path only applies under a real `tsx` dev run — same
// problem/fix as rawParsePool.ts's resolveHere().
function resolveHere(): string {
  if (typeof __dirname === "string" && __dirname) return __dirname;
  return dirname(fileURLToPath(import.meta.url));
}
const here = resolveHere();
const UI_DIR = resolve(here, "ui-dist");
const INDEX_HTML = join(UI_DIR, "index.html");

// Adapted from the fork's packages/cli/src/server-bundle.ts — see
// VENDORED.md for what changed and why (X-Frame-Options / CSP, to allow
// embedding in Shepherd's own <iframe>).
//
// frame-ancestors is scoped to Shepherd's two actual parent origins, not a
// `localhost:*` wildcard — the wildcard would let ANY localhost-bound page
// or process on the machine iframe a live diff server (a UI-redress risk
// caught in review). The two real parents: the Vite dev server, pinned to
// a fixed port in web/vite.config.ts (not arbitrary), and the packaged
// desktop app, which loads via `win.loadFile(...)` (desktop/main.cjs) —
// an opaque `file:` origin, matched by the literal `file:` scheme-source.
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src ws://localhost:* wss://localhost:*; frame-ancestors http://localhost:5173 file:",
};

// Escape typed while focus is anywhere inside the iframe fires in THIS
// document/window, not the parent's — a parent-side `window.addEventListener
// ('keydown', ...)` never sees it; iframes are a separate browsing context,
// and that's true regardless of capture/bubble phase or same-origin-ness.
// This relays it to the embedding page via postMessage instead, since
// that's the only channel that crosses the iframe boundary. Injected only
// into the served HTML (not the vendored React source) so re-vendoring a
// later fork commit doesn't need to reapply a source patch.
const ESCAPE_RELAY_SCRIPT = `
<script>
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && window.parent !== window) {
      window.parent.postMessage({ type: 'askdiff-escape' }, '*');
    }
  });
</script>`;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * HTTP server that serves the vendored, pre-built askdiff UI (`ui-dist/`)
 * from disk and leaves WS upgrades to the caller (askdiff's own
 * `startServer({ httpServer })` attaches its own `upgrade` listener).
 * Falls back to `index.html` for paths that don't map to a file, so
 * client-side routing keeps working.
 */
export function createAskdiffUiHttpServer(): HttpServer {
  return createServer((req, res) => {
    void handle(req, res);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return;
  }

  const urlPath = (req.url ?? "/").split("?")[0] ?? "/";
  const safe = safeJoin(UI_DIR, urlPath);
  if (safe === null) {
    res.writeHead(403);
    res.end();
    return;
  }

  const filePath = await resolveFile(safe);
  if (filePath === null) {
    res.writeHead(404);
    res.end();
    return;
  }

  const ext = extname(filePath).toLowerCase();
  const type = MIME[ext] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, ...SECURITY_HEADERS });
  if (req.method === "HEAD") {
    res.end();
    return;
  }

  if (filePath === INDEX_HTML) {
    const html = await readFile(filePath, "utf8");
    res.end(html.replace("</body>", `${ESCAPE_RELAY_SCRIPT}\n</body>`));
    return;
  }
  createReadStream(filePath).pipe(res);
}

function safeJoin(base: string, urlPath: string): string | null {
  // Strip any leading slashes, then normalize to prevent `..` escapes.
  const decoded = (() => {
    try {
      return decodeURIComponent(urlPath);
    } catch {
      return null;
    }
  })();
  if (decoded === null) return null;
  const cleaned = decoded.replace(/^\/+/, "");
  const joined = normalize(join(base, cleaned));
  if (joined !== base && !joined.startsWith(base + sep)) return null;
  return joined;
}

async function resolveFile(candidate: string): Promise<string | null> {
  try {
    const s = await stat(candidate);
    if (s.isFile()) return candidate;
    if (s.isDirectory()) {
      const indexed = join(candidate, "index.html");
      const sIdx = await stat(indexed).catch(() => null);
      if (sIdx?.isFile()) return indexed;
    }
  } catch {
    // not found — fall through to SPA fallback
  }
  // SPA fallback
  try {
    const s = await stat(INDEX_HTML);
    if (s.isFile()) return INDEX_HTML;
  } catch {
    // no UI bundle present
  }
  return null;
}
