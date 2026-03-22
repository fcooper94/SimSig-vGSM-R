const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

/**
 * Check for updates using electron-updater (reads latest.yml from GitHub Releases).
 */
function checkForUpdates({ onStatus, onProgress } = {}) {
  const { app } = require('electron');

  if (!app.isPackaged) {
    console.log('[Updater] Skipping update check in development mode');
    return Promise.resolve();
  }

  // Write updater log to file for debugging
  const logFile = path.join(app.getPath('userData'), 'updater.log');
  function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log('[Updater]', msg);
    try { fs.appendFileSync(logFile, line + '\n'); } catch (_) {}
  }

  return new Promise((resolve) => {
    // 5 minutes — full exe download can be 120MB+
    const timeout = setTimeout(() => {
      log('Update check timed out, proceeding');
      cleanup();
      resolve();
    }, 300000);

    function cleanup() {
      clearTimeout(timeout);
      autoUpdater.removeAllListeners();
    }

    log(`Current version: ${app.getVersion()}`);

    autoUpdater.logger = {
      info: (...args) => log(args.join(' ')),
      warn: (...args) => log('WARN: ' + args.join(' ')),
      error: (...args) => log('ERROR: ' + args.join(' ')),
    };

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.disableWebInstaller = true;

    // Disable differential downloads — GitHub's redirect-based CDN
    // causes sha512 mismatches on range requests
    autoUpdater.requestHeaders = { accept: '*/*' };
    autoUpdater.disableDifferentialDownload = true;

    autoUpdater.on('checking-for-update', () => {
      log('Checking for updates...');
      if (onStatus) onStatus('Checking for updates...');
    });

    autoUpdater.on('update-available', (info) => {
      log(`Update available: ${info.version}`);
      if (onStatus) onStatus('Downloading update...');
    });

    autoUpdater.on('update-not-available', (info) => {
      log(`App is up to date (latest: ${info?.version})`);
      cleanup();
      resolve();
    });

    autoUpdater.on('download-progress', (progress) => {
      const pct = Math.round(progress.percent);
      if (onProgress) onProgress(progress.percent);
      if (onStatus) onStatus(`Downloading update... ${pct}%`);
    });

    autoUpdater.on('update-downloaded', (info) => {
      log(`Update downloaded: ${info.version}`);
      if (onStatus) onStatus('Installing update...', 'The app will restart');
      setTimeout(() => {
        autoUpdater.quitAndInstall();
      }, 1500);
    });

    autoUpdater.on('error', (err) => {
      log(`Error: ${err.message}`);
      cleanup();
      resolve();
    });

    try {
      autoUpdater.checkForUpdates();
    } catch (err) {
      log(`checkForUpdates failed: ${err.message}`);
      cleanup();
      resolve();
    }
  });
}

module.exports = { checkForUpdates };
