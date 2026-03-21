const { autoUpdater, app } = require('electron');

const GITHUB_OWNER = 'fcooper94';
const GITHUB_REPO = 'SimSig-vGSM-R';
const UPDATE_URL = `https://update.electronjs.org/${GITHUB_OWNER}/${GITHUB_REPO}/win32/${app.getVersion()}`;

/**
 * Check for updates using Squirrel's native updater.
 * Uses update.electronjs.org which reads GitHub Releases automatically.
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

    autoUpdater.on('update-available', () => {
      console.log('[Updater] Update available, downloading...');
      if (onStatus) onStatus('Downloading update...');
      clearTimeout(timeout);
    });

    autoUpdater.on('update-not-available', () => {
      console.log('[Updater] App is up to date');
      cleanup();
      resolve();
    });

    autoUpdater.on('update-downloaded', (_event, releaseNotes, releaseName) => {
      console.log(`[Updater] Update downloaded: ${releaseName}`);
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
      console.log(`[Updater] Feed URL: ${UPDATE_URL}`);
      autoUpdater.setFeedURL({ url: UPDATE_URL });
      autoUpdater.checkForUpdates();
    } catch (err) {
      console.error('[Updater] checkForUpdates failed:', err.message);
      cleanup();
      resolve();
    }
  });
}

module.exports = { checkForUpdates };
