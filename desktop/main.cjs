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

const { app, BrowserWindow, shell, dialog } = require('electron');
const { spawn, execSync } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');

const DAEMON_PORT = 4177; // ws daemon (server/src/index.ts)
const WEB_PORT = 5173; // vite dev server (dev mode only)
const REPO_ROOT = path.resolve(__dirname, '..');
/** How often the packaged app checks GitHub Releases for a newer build. The
 *  first check fires one interval AFTER launch (never at startup). */
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** Start the daemon detached so it outlives this app. */
function startDaemon() {
  if (app.isPackaged) {
    // Run the bundled daemon with Electron's own Node runtime — no system Node
    // required. It ships as real files under resources/daemon (not asar) so its
    // native node-pty resolves from a sibling node_modules at runtime.
    const daemonDir = path.join(process.resourcesPath, 'daemon');
    const daemonEntry = path.join(daemonDir, 'daemon.cjs');
    console.log('[desktop] starting bundled daemon:', daemonEntry);
    const child = spawn(process.execPath, [daemonEntry], {
      cwd: daemonDir,
      // SHEPHERD_VERSION stamps the daemon with the app version that spawned it,
      // so a later app launch can tell (via GET /version) whether this daemon is
      // stale after an update and must be recycled — see ensureDaemon.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SHEPHERD_VERSION: app.getVersion() },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', (e) => console.error('[desktop] daemon failed to start:', e.message));
    child.unref();
  } else {
    // Dev: launch the daemon via the repo script (plain-Node tsx).
    console.log('[desktop] starting dev daemon: pnpm dev:server');
    const child = spawn('pnpm', ['--filter', '@shepherd/server', 'dev'], {
      cwd: REPO_ROOT,
      env: { ...process.env, SHEPHERD_VERSION: app.getVersion() },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    child.on('error', (e) => console.error('[desktop] dev daemon failed to start:', e.message));
    child.unref();
  }
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

/** Windows only: force-kill whatever process tree is listening on `port`. The
 *  graceful path is POST /shutdown; this is the fallback for a daemon that
 *  predates the endpoint (the first update into this feature) or is wedged. */
function killByPort(port) {
  if (process.platform !== 'win32') return;
  try {
    const out = execSync(`netstat -ano -p tcp | findstr :${port}`, { encoding: 'utf8' });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/LISTENING\s+(\d+)\s*$/);
      if (m) pids.add(m[1]);
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /F /T /PID ${pid}`); // /T: take the claude children with it
      } catch {
        /* already gone */
      }
    }
  } catch (e) {
    console.error('[desktop] killByPort failed:', e?.message ?? e);
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

async function ensureDaemon() {
  if (await isPortUp(DAEMON_PORT)) {
    const running = await daemonVersion();
    // Reuse only a daemon that answers AND isn't older than this app — so live
    // sessions survive ordinary app restarts, but an app that just auto-updated
    // never keeps talking to the pre-update daemon (that's how server-side fixes
    // actually land). A daemon that doesn't report a version (null) predates
    // this feature and is always recycled.
    if (running !== null && !isOlderVersion(running, app.getVersion())) {
      console.log(`[desktop] daemon v${running} on ${DAEMON_PORT} is current — reusing it`);
      return;
    }
    console.log(`[desktop] daemon (${running ?? 'unversioned'}) is stale vs app v${app.getVersion()} — recycling`);
    await stopDaemon();
  }
  startDaemon();
  await waitForPort(DAEMON_PORT);
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

/** Ever-green: PERIODICALLY (not at launch) check GitHub Releases, download
 *  newer builds in the background, and prompt for consent before installing —
 *  never install silently. Packaged only (the updater needs the app-update.yml
 *  electron-builder emits). Failures are non-fatal — offline just skips a tick. */
function startUpdateChecks() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    console.error('[desktop] updater unavailable:', e?.message ?? e);
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false; // nothing installs without explicit consent
  autoUpdater.on('error', (e) => console.error('[desktop] update error:', e?.message ?? e));
  autoUpdater.on('update-downloaded', (info) => {
    if (info?.version && info.version === promptedVersion) return; // don't nag for the same build
    promptedVersion = info?.version ?? null;
    void promptInstall(autoUpdater, info);
  });
  // First check one interval in — deliberately nothing at startup.
  setInterval(() => {
    autoUpdater.checkForUpdates().catch((e) => console.error('[desktop] update check failed:', e?.message ?? e));
  }, UPDATE_CHECK_INTERVAL_MS);
}

app.whenReady().then(async () => {
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
