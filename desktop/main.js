'use strict';

/**
 * Wireless desktop app (Electron).
 *
 * Runs the Wireless server in-process (server.js exports startServer), opens
 * a native window on the /desktop dashboard, and keeps running in the tray so
 * the phone/laptop pages keep working even when the window is closed.
 */

const { app, BrowserWindow, Tray, Menu, clipboard, shell, nativeImage, dialog } = require('electron');
const http = require('http');
const path = require('path');
const { startServer } = require('../server.js');

let win = null;
let tray = null;
let srv = null;
let port = 0;
let pin = '';
let quitting = false;
let autoUpdater = null;
let updateReady = false;

const PUBLIC = path.join(__dirname, '..', 'public');

// A single running host per machine — focus its window instead of a second copy.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(boot);
}

/** Grab a free TCP port (the server then binds it on 0.0.0.0 for the LAN). */
function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.unref();
    s.on('error', () => resolve(0));
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function boot() {
  app.setAppUserModelId('app.wireless.keyboard');
  const fromEnv = Number(process.env.PORT);
  const requested = Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : await freePort();
  srv = await startServer({ port: requested || 0 });
  port = srv.port;
  pin = srv.pin;

  createWindow();
  createTray();
  setupAutoUpdate();
}

/**
 * Auto-update (electron-updater) — best-effort and never intrusive:
 *  - only inside a packaged build;
 *  - only when a feed is configured, either baked into the build
 *    (`build.publish`) or supplied at runtime via WIRELESS_UPDATE_URL;
 *  - downloads quietly and installs on quit, so a live host session is never
 *    interrupted mid-typing. The tray shows "Restart to update" once ready.
 */
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
    const feed = process.env.WIRELESS_UPDATE_URL;
    if (feed) autoUpdater.setFeedURL({ provider: 'generic', url: feed });
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('error', (e) => console.warn('auto-update:', e && e.message ? e.message : e));
    autoUpdater.on('update-downloaded', () => {
      updateReady = true;
      createTray(); // pick up the "Restart to update" entry
    });
    // Give the host a moment to settle, then check every 6 hours.
    setTimeout(() => checkForUpdates(false), 8000);
    setInterval(() => checkForUpdates(false), 6 * 60 * 60 * 1000);
  } catch (e) {
    console.warn('auto-update unavailable:', e && e.message ? e.message : e);
    autoUpdater = null;
  }
}

async function checkForUpdates(interactive) {
  if (!autoUpdater) {
    if (interactive) {
      dialog.showMessageBox({
        type: 'info',
        title: 'Updates',
        message: 'Auto-update is not configured for this build.',
        detail: 'Set WIRELESS_UPDATE_URL (or build with a publish feed) to enable it.',
      });
    }
    return;
  }
  try {
    const res = await autoUpdater.checkForUpdates();
    if (interactive && res && res.updateInfo && res.updateInfo.version === app.getVersion()) {
      dialog.showMessageBox({ type: 'info', title: 'Updates', message: 'Wireless is up to date.', detail: 'v' + app.getVersion() });
    }
  } catch (e) {
    if (interactive) {
      dialog.showMessageBox({ type: 'warning', title: 'Updates', message: 'Could not check for updates.', detail: String((e && e.message) || e) });
    }
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 780,
    minHeight: 560,
    title: 'Wireless',
    backgroundColor: '#14161c',
    autoHideMenuBar: true,
    icon: path.join(PUBLIC, 'icon-192.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Open page links in the user's default browser; the app window stays on
  // the dashboard.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://127.0.0.1:' + port + '/')) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  win.loadURL('http://127.0.0.1:' + port + '/desktop');

  // Closing the window hides to the tray — the host keeps running.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    win = null;
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  let img = null;
  try {
    img = nativeImage.createFromPath(path.join(PUBLIC, 'icon-192.png')).resize({ width: 16, height: 16 });
  } catch {
    img = nativeImage.createEmpty();
  }
  if (tray) {
    tray.setImage(img);
  } else {
    tray = new Tray(img);
    tray.on('click', showWindow);
  }
  tray.setToolTip('Wireless — every device controls every device');
  const items = [
    { label: 'Open Wireless', click: showWindow },
    { label: 'Copy PIN', click: () => clipboard.writeText(pin) },
    {
      label: 'Host page in browser',
      click: () => shell.openExternal('http://127.0.0.1:' + port + '/host'),
    },
    { type: 'separator' },
    { label: 'Check for updates…', click: () => checkForUpdates(true) },
  ];
  if (updateReady) {
    items.push({
      label: 'Restart to update',
      click: () => {
        quitting = true;
        autoUpdater.quitAndInstall();
      },
    });
  }
  items.push({ type: 'separator' }, {
    label: 'Quit Wireless',
    click: () => {
      quitting = true;
      app.quit();
    },
  });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

app.on('window-all-closed', () => {
  // Stay in the tray; quit only via the tray menu.
});

app.on('before-quit', () => {
  quitting = true;
  if (srv && srv.close) srv.close().catch(() => {});
});