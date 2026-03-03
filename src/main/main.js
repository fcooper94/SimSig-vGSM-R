const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let mainWindow = null;
let splashWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 896,
    height: 626,
    minWidth: 525,
    minHeight: 300,
    frame: false,
    title: 'SimSig VGSM-R',
    icon: path.join(__dirname, '../../images/icon.png'),
    backgroundColor: '#505050',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      zoomFactor: 0.9,
    },
  });

  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.setMenu(null);
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 896,
    height: 626,
    minWidth: 525,
    minHeight: 300,
    resizable: false,
    frame: false,
    center: true,
    show: false,
    icon: path.join(__dirname, '../../images/icon.png'),
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload-update.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  splashWindow.setMenu(null);
  splashWindow.setAlwaysOnTop(true, 'floating');
  splashWindow.loadFile(path.join(__dirname, '../renderer/update.html'));
  splashWindow.once('ready-to-show', () => splashWindow.show());

  splashWindow.on('closed', () => {
    splashWindow = null;
  });
}

function sendSplashStatus(message, detail) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('update:status', { message, detail });
  }
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
  }
}

app.whenReady().then(async () => {
  createSplashWindow();

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  // Phase 1: Checking for updates
  sendSplashStatus('checking');
  const updateStart = Date.now();
  const { checkForUpdates } = require('./updater');
  await checkForUpdates({
    onStatus: (message, detail) => sendSplashStatus('checking', detail),
    onProgress: () => {},
  });
  const elapsed = Date.now() - updateStart;
  if (elapsed < 1500) await delay(1500 - elapsed);

  // Phase 2: Initialising (settings only, NO IPC handlers / native modules)
  sendSplashStatus('initialising');
  const initStart = Date.now();

  const { initSettings } = require('./settings');
  const settings = require('./settings');
  initSettings();

  const initElapsed = Date.now() - initStart;
  if (initElapsed < 1500) await delay(1500 - initElapsed);

  // Close splash and open main window
  closeSplash();
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
