const { autoUpdater } = require('electron-updater');
const { app } = require('electron');

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

/**
 * Check for updates.
 *
 * @param {object} callbacks
 * @param {function} callbacks.onStatus  - (message, detail) status text
 * @param {function} callbacks.onProgress - (percent) download progress
 *
 * Returns a Promise that resolves when the app should continue.
 * If an update is downloaded it calls quitAndInstall (Promise never resolves).
 */
function checkForUpdates({ onStatus, onProgress } = {}) {
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
    }

    autoUpdater.on('checking-for-update', () => {
      console.log('[Updater] Checking for updates...');
      if (onStatus) onStatus('Checking for updates...');
    });

    autoUpdater.on('update-available', (info) => {
      console.log(`[Updater] Update available: v${info.version}`);
      if (onStatus) onStatus('Update available', `Downloading v${info.version}...`);
      autoUpdater.downloadUpdate();
    });

    autoUpdater.on('update-not-available', () => {
      console.log('[Updater] App is up to date');
      cleanup();
      resolve();
    });

    autoUpdater.on('download-progress', (progress) => {
      const percent = Math.round(progress.percent);
      if (onProgress) onProgress(percent);
      if (onStatus) onStatus('Downloading update...', `${percent}%`);
    });

    autoUpdater.on('update-downloaded', () => {
      console.log('[Updater] Update downloaded, installing...');
      if (onStatus) onStatus('Installing update...', 'The app will restart');
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
