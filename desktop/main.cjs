// Electron main process — a thin desktop shell for Shepherd.
//
// It owns nothing important: the daemon is a separate, detached process that a
// browser and this app both connect to. On launch it health-checks the daemon
// and starts it only if it isn't already up; on quit it leaves it running, so
// closing the app never drops the daemon or the live session PTYs it holds.
//
// Two modes:
//  - dev (not packaged): starts services via the repo's pnpm scripts and loads
//    the vite dev server at http://localhost:5173.
//  - packaged: runs the bundled daemon with Electron's own Node runtime
//    (ELECTRON_RUN_AS_NODE) so no system Node is needed, and loads the built
//    web UI from disk. Also checks GitHub Releases for updates (ever-green).

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const { spawn, execSync } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const DAEMON_PORT = 4177; // ws daemon (server/src/index.ts)
const CONTROL_PORT = 4178; // this process's own restart-daemon endpoint (see startControlServer)
const WEB_PORT = 5173; // vite dev server (dev mode only)
const REPO_ROOT = path.resolve(__dirname, '..');
/** How often the packaged app checks GitHub Releases for a newer build. The
 *  first check fires one interval AFTER launch (never at startup). */
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
/** Bound on how many times ensureDaemon retries a spawn that never bound the
 *  port (crashed instantly, or a wedged predecessor holding it hostage). */
const MAX_START_ATTEMPTS = 3;
const START_ATTEMPT_TIMEOUT_MS = 12_000;
const LOG_MAX_BYTES = 2 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Append a timestamped line to userData/shepherd.log AND stdout. This is the
 *  only record of daemon lifecycle events in a packaged build (stdio is
 *  'ignore' on the child, and there's no console to read console.log from),
 *  so anything that can explain "the daemon never came up" belongs here. */
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try {
    const logPath = path.join(app.getPath('userData'), 'shepherd.log');
    const { size } = fs.existsSync(logPath) ? fs.statSync(logPath) : { size: 0 };
    fs.appendFileSync(logPath, (size > LOG_MAX_BYTES ? '--- log truncated ---\n' : '') + line + '\n', {
      flag: size > LOG_MAX_BYTES ? 'w' : 'a',
    });
  } catch {
    /* best-effort — a logging failure must never block daemon startup */
  }
}

/** Resolve true when a TCP connect to localhost:port succeeds. */
function isPortUp(port) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    const done = (up) => {
      sock.destroy();
      resolve(up);
    };
    sock.setTimeout(500);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => resolve(false));
  });
}

/** Poll until the port answers (or give up after timeoutMs). */
async function waitForPort(port, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortUp(port)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** Like waitForPort, but also bails out early if `child` exits with a
 *  non-zero code first — no point polling for the rest of timeoutMs when the
 *  process that was supposed to bind the port already died. */
function waitForPortOrExit(child, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      child.removeListener('exit', onExit);
      resolve(result);
    };
    const onExit = (code) => {
      if (code !== 0) finish(false);
    };
    child.on('exit', onExit);
    waitForPort(port, timeoutMs).then(finish);
  });
}

/** Opens (creating/truncating as needed) userData/daemon-output.log and
 *  returns a raw fd for the daemon's stdout+stderr. A raw fd — not a JS
 *  Stream — is required here: the daemon is spawned `detached` specifically
 *  so it outlives this Electron process (including the case where THIS
 *  process crashes, confirmed to happen under exactly the load this is
 *  meant to help diagnose), and only a raw OS-level fd keeps receiving the
 *  child's writes once nothing on the Node/JS side is left running to pump
 *  a Stream. Previously this was `stdio: 'ignore'`, which meant every
 *  uncaught exception, chokidar error, and crash reason the daemon ever hit
 *  was silently discarded — undiagnosable without literally reproducing it
 *  under a manual, foreground run. */
function openDaemonLogFd() {
  const logPath = path.join(app.getPath('userData'), 'daemon-output.log');
  try {
    const { size } = fs.existsSync(logPath) ? fs.statSync(logPath) : { size: 0 };
    if (size > LOG_MAX_BYTES) fs.writeFileSync(logPath, '--- log truncated ---\n');
  } catch {
    /* best-effort — falls through to opening (and likely creating) the file below */
  }
  try {
    fs.appendFileSync(logPath, `\n--- daemon spawn ${new Date().toISOString()} ---\n`);
  } catch {
    /* best-effort */
  }
  return fs.openSync(logPath, 'a');
}

/** Start the daemon detached so it outlives this app. Returns the child so
 *  callers can race port-up against an early crash instead of only polling. */
function startDaemon() {
  let child;
  const daemonLogFd = openDaemonLogFd();
  try {
    if (app.isPackaged) {
      // Run the bundled daemon with Electron's own Node runtime — no system Node
      // required. It ships as real files under resources/daemon (not asar) so its
      // native node-pty resolves from a sibling node_modules at runtime.
      const daemonDir = path.join(process.resourcesPath, 'daemon');
      const daemonEntry = path.join(daemonDir, 'daemon.cjs');
      log('[desktop] starting bundled daemon:', daemonEntry);
      child = spawn(process.execPath, [daemonEntry], {
        cwd: daemonDir,
        // SHEPHERD_VERSION stamps the daemon with the app version that spawned it,
        // so a later app launch can tell (via GET /version) whether this daemon is
        // stale after an update and must be recycled — see ensureDaemon.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SHEPHERD_VERSION: app.getVersion() },
        detached: true,
        stdio: ['ignore', daemonLogFd, daemonLogFd],
        windowsHide: true,
      });
    } else {
      // Dev: launch the daemon via the repo script (plain-Node tsx).
      log('[desktop] starting dev daemon: pnpm dev:server');
      child = spawn('pnpm', ['--filter', '@shepherd/server', 'dev'], {
        cwd: REPO_ROOT,
        env: { ...process.env, SHEPHERD_VERSION: app.getVersion() },
        detached: true,
        stdio: ['ignore', daemonLogFd, daemonLogFd],
        windowsHide: true,
        shell: process.platform === 'win32',
      });
    }
  } finally {
    // The child (via CreateProcess/fork) has its own duplicated handle to
    // the same file by now — safe to close our copy immediately rather than
    // hold it open for this long-lived process's whole lifetime.
    fs.closeSync(daemonLogFd);
  }
  child.on('error', (e) => log('[desktop] daemon failed to spawn:', e.message));
  child.on('exit', (code, signal) => {
    if (code !== 0) log(`[desktop] daemon exited early (code=${code}, signal=${signal}) — see daemon-output.log`);
  });
  child.unref();
  return child;
}

/** Dev only: ensure the vite dev server is up (the packaged app loads from disk). */
function startWebDev() {
  console.log('[desktop] starting dev web: pnpm dev:web');
  const child = spawn('pnpm', ['--filter', '@shepherd/web', 'dev'], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  child.on('error', (e) => console.error('[desktop] dev web failed to start:', e.message));
  child.unref();
}

/** Parse a leading `major.minor.patch` from a version string, or null. */
function parseVer(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True iff `a` is a strictly older release than `b`. Anything unparseable
 *  (e.g. a `dev` daemon) returns false — we never force-restart on a version we
 *  can't confidently compare; only a genuinely older, or an entirely
 *  unversioned (see caller), daemon gets recycled. */
function isOlderVersion(a, b) {
  const pa = parseVer(a);
  const pb = parseVer(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return true;
    if (pa[i] > pb[i]) return false;
  }
  return false;
}

/** Read the running daemon's version via its HTTP control endpoint. Returns
 *  null if it doesn't answer (pre-feature daemon, or not actually a daemon). */
function daemonVersion() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: DAEMON_PORT, path: '/version', timeout: 1500 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body).version ?? null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** Force-kill whatever process tree is listening on `port`, regardless of
 *  whose it is or what version it's running — the graceful path is POST
 *  /shutdown; this is the fallback for a daemon that predates the endpoint,
 *  is wedged, or is a stray/duplicate instance left over from a crash or a
 *  race with another Shepherd launch. */
function killByPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano -p tcp | findstr :${port}`, { encoding: 'utf8' });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(/LISTENING\s+(\d+)\s*$/);
        if (m) pids.add(m[1]);
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /F /T /PID ${pid}`); // /T: take the claude children with it
          log(`[desktop] killed stale process on :${port} (pid ${pid})`);
        } catch {
          /* already gone */
        }
      }
    } else {
      const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf8' });
      for (const pid of out.split(/\s+/).filter(Boolean)) {
        try {
          execSync(`kill -9 ${pid}`);
          log(`[desktop] killed stale process on :${port} (pid ${pid})`);
        } catch {
          /* already gone */
        }
      }
    }
  } catch (e) {
    // Both netstat/findstr and lsof exit with status 1 when nothing matches —
    // that's the common "nothing to kill" case, not a real failure worth logging.
    if (e?.status !== 1) log('[desktop] killByPort failed:', e?.message ?? e);
  }
}

/** Stop the daemon: ask it to exit gracefully (so it runs its own PTY cleanup),
 *  and if it won't (pre-feature daemon without /shutdown, or wedged), force it. */
async function stopDaemon() {
  await new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: DAEMON_PORT, path: '/shutdown', method: 'POST', timeout: 1500 },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('error', () => resolve());
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.end();
  });
  for (let i = 0; i < 20; i++) {
    if (!(await isPortUp(DAEMON_PORT))) return;
    await sleep(250);
  }
  killByPort(DAEMON_PORT);
  for (let i = 0; i < 20; i++) {
    if (!(await isPortUp(DAEMON_PORT))) return;
    await sleep(250);
  }
}

/** Bring up a daemon this app owns: reuse a current-version one already
 *  running, recycle anything stale or unversioned, and if starting a fresh
 *  one doesn't pan out (crashes instantly, or leaves a wedged process
 *  squatting the port), kill whatever's there and retry rather than leaving
 *  the UI stuck on "waiting" forever with nothing to explain why. */
async function ensureDaemon() {
  if (await isPortUp(DAEMON_PORT)) {
    const running = await daemonVersion();
    // Reuse only a daemon that answers AND isn't older than this app — so live
    // sessions survive ordinary app restarts, but an app that just auto-updated
    // never keeps talking to the pre-update daemon (that's how server-side fixes
    // actually land). A daemon that doesn't report a version (null) predates
    // this feature and is always recycled.
    if (running !== null && !isOlderVersion(running, app.getVersion())) {
      log(`[desktop] daemon v${running} on ${DAEMON_PORT} is current — reusing it`);
      return;
    }
    log(`[desktop] daemon (${running ?? 'unversioned'}) is stale vs app v${app.getVersion()} — recycling`);
    await stopDaemon();
  }

  for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
    log(`[desktop] starting daemon — attempt ${attempt}/${MAX_START_ATTEMPTS}`);
    const child = startDaemon();
    if (await waitForPortOrExit(child, DAEMON_PORT, START_ATTEMPT_TIMEOUT_MS)) {
      log(`[desktop] daemon is up on :${DAEMON_PORT}`);
      return;
    }
    log(`[desktop] attempt ${attempt} did not bring the daemon up — clearing :${DAEMON_PORT} and retrying`);
    killByPort(DAEMON_PORT);
    await sleep(500 * attempt);
  }
  log(`[desktop] daemon failed to start after ${MAX_START_ATTEMPTS} attempts — giving up (see shepherd.log; try Restart daemon)`);
}

/** Unconditional recycle for the "Restart daemon" button: stop whatever's on
 *  the port (if anything) and start fresh, regardless of version. */
async function forceRestartDaemon() {
  if (await isPortUp(DAEMON_PORT)) await stopDaemon();
  for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
    const child = startDaemon();
    if (await waitForPortOrExit(child, DAEMON_PORT, START_ATTEMPT_TIMEOUT_MS)) return true;
    killByPort(DAEMON_PORT);
    await sleep(500 * attempt);
  }
  return false;
}

/** Serve the same `POST /restart-daemon` control endpoint the web UI's
 *  "Restart daemon" button already calls (hardcoded to :4178) — previously
 *  only `scripts/serve.mjs`'s dev-only supervisor answered on that port, so
 *  the button was dead in every Electron build (dev and packaged). Binding
 *  it here makes it actually work everywhere the button is shown. */
function startControlServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'POST' && req.url === '/restart-daemon') {
      log('[desktop] restart requested via control endpoint');
      forceRestartDaemon().then((ok) => {
        res
          .writeHead(ok ? 200 : 500, { 'content-type': 'application/json' })
          .end(JSON.stringify(ok ? { ok: true } : { ok: false, error: 'daemon did not come back up — see shepherd.log' }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  server.on('error', (e) => log('[desktop] control server failed to start:', e?.message ?? e));
  server.listen(CONTROL_PORT, () => log(`[desktop] control endpoint on :${CONTROL_PORT}`));
}

async function loadUI(win) {
  if (app.isPackaged) {
    // Built web UI shipped under resources/web (vite base './' → relative assets).
    await win.loadFile(path.join(process.resourcesPath, 'web', 'index.html'));
  } else {
    if (!(await isPortUp(WEB_PORT))) startWebDev();
    const up = await waitForPort(WEB_PORT);
    if (up) await win.loadURL(`http://localhost:${WEB_PORT}`);
    else await win.loadURL('data:text/html,' + encodeURIComponent('<h1>Shepherd</h1><p>Web dev server did not start on 5173.</p>'));
  }
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'Shepherd',
    backgroundColor: '#080b10',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });
  await loadUI(win);
}

/** Which downloaded version we've already prompted for, so a periodic re-check
 *  that re-emits `update-downloaded` for the SAME build doesn't nag. A genuinely
 *  newer build has a different version and prompts again. */
let promptedVersion = null;

/** Ask the user to install a downloaded update. On consent, quit + install;
 *  the relaunched app's ensureDaemon recycles the now-stale daemon, so app and
 *  daemon come back together on the new version. On "Later", nothing happens —
 *  autoInstallOnAppQuit is off, so no silent install slips in on quit either. */
async function promptInstall(autoUpdater, info) {
  const version = info?.version ? `Shepherd ${info.version}` : 'A new version of Shepherd';
  const { response } = await dialog.showMessageBox({
    type: 'info',
    buttons: ['Update now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update ready',
    message: `${version} is ready to install.`,
    detail:
      'Updating restarts Shepherd and its daemon. Any in-progress turn is interrupted; your conversations are preserved and resume automatically.',
  });
  if (response !== 0) return; // Later — leave everything running untouched
  autoUpdater.quitAndInstall();
}

/** Lazily creates and configures the `electron-updater` singleton exactly
 *  once, so the periodic background check and a manual "check now" click
 *  share the same instance and listeners instead of each registering its
 *  own — repeated menu clicks would otherwise pile up duplicate
 *  `update-downloaded` handlers. Packaged only (the updater needs the
 *  app-update.yml electron-builder emits); returns null in dev builds or
 *  if the module fails to load, and every caller must handle that. */
let sharedUpdater;
let updaterInitAttempted = false;
function getUpdater() {
  if (updaterInitAttempted) return sharedUpdater ?? null;
  updaterInitAttempted = true;
  if (!app.isPackaged) return null;
  try {
    ({ autoUpdater: sharedUpdater } = require('electron-updater'));
  } catch (e) {
    console.error('[desktop] updater unavailable:', e?.message ?? e);
    return null;
  }
  sharedUpdater.autoDownload = true;
  sharedUpdater.autoInstallOnAppQuit = false; // nothing installs without explicit consent
  sharedUpdater.on('error', (e) => console.error('[desktop] update error:', e?.message ?? e));
  sharedUpdater.on('update-downloaded', (info) => {
    if (info?.version && info.version === promptedVersion) return; // don't nag for the same build
    promptedVersion = info?.version ?? null;
    void promptInstall(sharedUpdater, info);
  });
  return sharedUpdater;
}

/** Ever-green: PERIODICALLY (not at launch) check GitHub Releases, download
 *  newer builds in the background, and prompt for consent before installing —
 *  never install silently. Failures are non-fatal — offline just skips a tick. */
function startUpdateChecks() {
  const updater = getUpdater();
  if (!updater) return;
  // First check one interval in — deliberately nothing at startup.
  setInterval(() => {
    updater.checkForUpdates().catch((e) => console.error('[desktop] update check failed:', e?.message ?? e));
  }, UPDATE_CHECK_INTERVAL_MS);
}

/** True while a manually-triggered check is in flight — guards against a
 *  double-click (or repeated menu selection) stacking overlapping checks
 *  and overlapping "you're up to date" dialogs. */
let manualCheckInFlight = false;

/** Menu-triggered "Check for Updates Now". Reuses the same shared updater
 *  and its existing `update-downloaded` → install-prompt flow, but adds
 *  one-shot feedback the silent background check doesn't need: a user who
 *  just clicked a menu item deserves to know the click did something, so
 *  "nothing new" gets an explicit notice instead of quietly doing nothing. */
async function checkForUpdatesNow() {
  if (manualCheckInFlight) return;
  const updater = getUpdater();
  if (!updater) {
    await dialog.showMessageBox({
      type: 'info',
      title: 'Check for Updates',
      message: 'Updates are only available in packaged builds, not this dev build.',
    });
    return;
  }

  manualCheckInFlight = true;
  let notified = false;
  // `update-available` needs no handler of its own here — the shared
  // `update-downloaded` listener (registered once in getUpdater) picks up
  // from there and shows the existing install prompt once the download
  // finishes; this call just needs to not ALSO show "up to date" in that
  // case, which not attaching an update-available listener here ensures.
  const onNotAvailable = () => {
    notified = true;
    void dialog.showMessageBox({
      type: 'info',
      title: 'Check for Updates',
      message: `You're up to date (Shepherd ${app.getVersion()}).`,
    });
  };
  updater.once('update-not-available', onNotAvailable);

  try {
    const result = await updater.checkForUpdates();
    // Some platforms/versions don't emit update-not-available at all — a
    // result with no update info means nothing was found regardless, and
    // `notified` avoids double-showing the notice if it already fired.
    if (!notified && result && !result.updateInfo) {
      await dialog.showMessageBox({
        type: 'info',
        title: 'Check for Updates',
        message: `You're up to date (Shepherd ${app.getVersion()}).`,
      });
    }
  } catch (e) {
    console.error('[desktop] manual update check failed:', e?.message ?? e);
    await dialog.showMessageBox({
      type: 'error',
      title: 'Check for Updates',
      message: `Couldn't check for updates: ${e?.message ?? String(e)}`,
    });
  } finally {
    updater.removeListener('update-not-available', onNotAvailable);
    manualCheckInFlight = false;
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Check for Updates Now',
          enabled: app.isPackaged,
          click: () => void checkForUpdatesNow(),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  return Menu.buildFromTemplate(template);
}

// Only one Shepherd instance may drive daemon startup at a time — without
// this, a double-launch (impatient double-click, a relaunch racing a still-
// starting instance) spawns two ensureDaemon() runs that fight over the same
// port, and one side's spawn losing to EADDRINUSE looks identical to "the
// daemon never starts". A second launch just focuses the existing window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(buildMenu());
    startControlServer();
    await ensureDaemon();
    await createWindow();
    startUpdateChecks();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // Closing the app must NOT stop the daemon — it's a shared, detached service
  // (keeps browser clients and live session PTYs alive).
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
