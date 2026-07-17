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

const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const DAEMON_PORT = 4177; // ws daemon (server/src/index.ts)
const WEB_PORT = 5173; // vite dev server (dev mode only)
const REPO_ROOT = path.resolve(__dirname, '..');

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
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
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

async function ensureDaemon() {
  if (await isPortUp(DAEMON_PORT)) {
    console.log('[desktop] daemon already running on', DAEMON_PORT, '— reusing it');
    return;
  }
  startDaemon();
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

/** Ever-green: check GitHub Releases and self-install newer builds. Packaged
 *  only (the updater needs the app-update.yml electron-builder emits). Failures
 *  are non-fatal — a dev build or being offline just skips it. */
function checkForUpdates() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.on('error', (e) => console.error('[desktop] update error:', e?.message ?? e));
    autoUpdater
      .checkForUpdatesAndNotify()
      .catch((e) => console.error('[desktop] update check failed:', e?.message ?? e));
  } catch (e) {
    console.error('[desktop] updater unavailable:', e?.message ?? e);
  }
}

app.whenReady().then(async () => {
  await ensureDaemon();
  await createWindow();
  checkForUpdates();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Closing the app must NOT stop the daemon — it's a shared, detached service
// (keeps browser clients and live session PTYs alive).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
