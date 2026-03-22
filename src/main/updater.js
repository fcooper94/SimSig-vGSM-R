const { autoUpdater } = require('electron-updater');

/**
 * Check for updates using electron-updater (reads latest.yml from GitHub Releases).
 */
function checkForUpdates({ onStatus, onProgress } = {}) {
  const { app } = require('electron');

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

    autoUpdater.logger = {
      info: (...args) => console.log('[Updater]', ...args),
      warn: (...args) => console.warn('[Updater]', ...args),
      error: (...args) => console.error('[Updater]', ...args),
    };

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
      console.log('[Updater] Checking for updates...');
      if (onStatus) onStatus('Checking for updates...');
    });

    autoUpdater.on('update-available', (info) => {
      console.log(`[Updater] Update available: ${info.version}`);
      if (onStatus) onStatus('Downloading update...');
    });

    autoUpdater.on('update-not-available', () => {
      console.log('[Updater] App is up to date');
      cleanup();
      resolve();
    });

    autoUpdater.on('download-progress', (progress) => {
      console.log(`[Updater] Download: ${Math.round(progress.percent)}%`);
      if (onProgress) onProgress(progress.percent);
      if (onStatus) onStatus(`Downloading update... ${Math.round(progress.percent)}%`);
    });

    autoUpdater.on('update-downloaded', (info) => {
      console.log(`[Updater] Update downloaded: ${info.version}`);
      if (onStatus) onStatus('Installing update...', 'The app will restart');
      setTimeout(() => {
        autoUpdater.quitAndInstall();
      }, 1500);
    });

    autoUpdater.on('error', (err) => {
      console.error('[Updater] Error:', err.message);
      cleanup();
      resolve();
    });

    try {
      autoUpdater.checkForUpdates();
    } catch (err) {
      console.error('[Updater] checkForUpdates failed:', err.message);
      cleanup();
      resolve();
    }
  });
}

module.exports = { checkForUpdates };
