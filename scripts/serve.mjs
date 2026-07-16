#!/usr/bin/env node
// Starts the daemon and the web dev server together, skipping whichever one
// is already listening instead of crashing on EADDRINUSE (safe to run
// repeatedly) — and, unlike a one-shot start, supervises the daemon for the
// rest of this process's life: if it dies (a bad spawn under load, any bug
// that slips past its own crash guards), it's restarted automatically rather
// than leaving every session silently unable to send until someone notices.
// Also exposes a tiny control endpoint the web UI's "Restart daemon" button
// calls for an on-demand restart, since auto-restart alone can't cover every
// case (e.g. a daemon that's up but wedged, not actually crashed).
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';

const DAEMON_PORT = 4177;
const WEB_PORT = 5173;
const CONTROL_PORT = 4178;

// 'localhost' — not a hardcoded 127.0.0.1 — because Vite/ws may resolve it to
// ::1 on a dual-stack machine, and checking the wrong family reads as closed
// even when the real server is up (would spawn a colliding duplicate).
function isListening(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: 'localhost' });
    const finish = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

// shell: true — spawning the bare `pnpm` name (its Windows shim is a .cmd)
// without a shell throws EINVAL in some parent-process contexts (e.g. no
// inherited console); routing through the shell resolves it reliably.
function spawnPnpm(args) {
  return spawn('pnpm', args, { stdio: 'inherit', shell: true });
}

let webChild = null;
if (await isListening(WEB_PORT)) {
  console.log(`[serve] web already up on :${WEB_PORT} — leaving it alone`);
} else {
  console.log(`[serve] starting web (:${WEB_PORT})`);
  webChild = spawnPnpm(['--filter', '@shepherd/web', 'dev']);
  webChild.on('exit', (code) => {
    if (code) console.error(`[serve] web exited with code ${code}`);
  });
}

// --- daemon supervision -----------------------------------------------
// Not "start once and log if it dies" — actively kept alive for as long as
// this script runs. A crash restarts it after a short backoff; a burst of
// crashes (a real, persistent bug, not a one-off) backs off further instead
// of spinning a tight respawn loop, and gives up after enough consecutive
// failures rather than hammering forever.
let daemonChild = null;
let daemonManagedHere = false; // false if some other process already owns :4177
let restartTimer = null;
let consecutiveCrashes = 0;
let intentionalKill = false;
const MAX_CONSECUTIVE_CRASHES = 6;
const BACKOFF_MS = (n) => Math.min(1_000 * 2 ** n, 20_000);

function startDaemon() {
  console.log(`[serve] starting daemon (:${DAEMON_PORT})`);
  daemonManagedHere = true;
  intentionalKill = false;
  daemonChild = spawnPnpm(['--filter', '@shepherd/server', 'dev']);
  daemonChild.on('exit', (code, signal) => {
    if (intentionalKill) return; // we killed it ourselves (restart-on-demand or shutdown)
    if (code === 0) {
      consecutiveCrashes = 0;
      return;
    }
    console.error(`[serve] daemon exited (code=${code}, signal=${signal}) — restarting`);
    consecutiveCrashes += 1;
    if (consecutiveCrashes > MAX_CONSECUTIVE_CRASHES) {
      console.error(
        `[serve] daemon crashed ${consecutiveCrashes} times in a row — giving up auto-restart. ` +
          'Something is persistently broken; fix it and re-run `pnpm serve:web`.',
      );
      return;
    }
    const delay = BACKOFF_MS(consecutiveCrashes - 1);
    console.log(`[serve] retrying in ${Math.round(delay / 1000)}s…`);
    restartTimer = setTimeout(startDaemon, delay);
  });
}

function restartDaemonNow() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  consecutiveCrashes = 0;
  if (daemonChild && daemonManagedHere) {
    intentionalKill = true;
    daemonChild.kill();
  }
  // Give the OS a beat to release the port before rebinding.
  setTimeout(startDaemon, 300);
}

if (await isListening(DAEMON_PORT)) {
  console.log(`[serve] daemon already up on :${DAEMON_PORT} — leaving it alone (not supervised by this process)`);
} else {
  startDaemon();
}

// --- control endpoint for the UI's "Restart daemon" button -------------
const control = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', `http://localhost:${WEB_PORT}`);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  if (req.method === 'POST' && req.url === '/restart-daemon') {
    if (!daemonManagedHere) {
      res.writeHead(409, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          ok: false,
          error: 'daemon was already running before this supervisor started, so it is not managed here',
        }),
      );
      return;
    }
    console.log('[serve] restart requested via control endpoint');
    restartDaemonNow();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404).end();
});
control.listen(CONTROL_PORT, () => {
  console.log(`[serve] control endpoint on :${CONTROL_PORT} (POST /restart-daemon)`);
});

const shutdown = () => {
  intentionalKill = true;
  if (restartTimer) clearTimeout(restartTimer);
  control.close();
  webChild?.kill();
  daemonChild?.kill();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
