const { autoUpdater } = require('electron-updater');
const { BrowserWindow, app } = require('electron');
const path = require('path');

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

let updateWindow = null;

function createUpdateWindow() {
  updateWindow = new BrowserWindow({
    width: 400,
    height: 200,
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

  updateWindow.loadFile(path.join(__dirname, '../renderer/update.html'));
  updateWindow.once('ready-to-show', () => updateWindow.show());

  updateWindow.on('closed', () => {
    updateWindow = null;
  });

  return updateWindow;
}

function sendStatus(message, detail) {
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.webContents.send('update:status', { message, detail });
  }
}

function sendProgress(percent) {
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.webContents.send('update:progress', { percent });
  }
}

/**
 * Check for updates. Returns a Promise that resolves when the app
 * should continue to its normal startup flow.
 *
 * - If an update is found: shows progress window, downloads, installs,
 *   and quits (Promise never resolves — app restarts).
 * - If no update / error / offline: resolves so the app proceeds.
 * - Times out after 15s to avoid blocking startup forever.
 */
function checkForUpdates() {
  if (!app.isPackaged) {
    console.log('[Updater] Skipping update check in development mode');
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.log('[Updater] Update check timed out, proceeding');
      cleanup();
      resolve();
    }, 15000);

    function cleanup() {
      clearTimeout(timeout);
      autoUpdater.removeAllListeners();
      if (updateWindow && !updateWindow.isDestroyed()) {
        updateWindow.close();
      }
    }

    autoUpdater.on('checking-for-update', () => {
      console.log('[Updater] Checking for updates...');
    });

    autoUpdater.on('update-available', (info) => {
      console.log(`[Updater] Update available: v${info.version}`);
      createUpdateWindow();
      sendStatus('Update available', `Downloading v${info.version}...`);
      autoUpdater.downloadUpdate();
    });

    autoUpdater.on('update-not-available', () => {
      console.log('[Updater] App is up to date');
      cleanup();
      resolve();
    });

    autoUpdater.on('download-progress', (progress) => {
      const percent = Math.round(progress.percent);
      sendProgress(percent);
      sendStatus('Downloading update', `${percent}%`);
    });

    autoUpdater.on('update-downloaded', () => {
      console.log('[Updater] Update downloaded, installing...');
      sendStatus('Installing update', 'The app will restart...');
      setTimeout(() => {
        autoUpdater.quitAndInstall(false, true);
      }, 1500);
    });

    autoUpdater.on('error', (err) => {
      console.error('[Updater] Error:', err.message);
      cleanup();
      resolve();
    });

    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[Updater] checkForUpdates failed:', err.message);
      cleanup();
      resolve();
    });
  });
}

module.exports = { checkForUpdates };
