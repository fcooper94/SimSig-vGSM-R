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
    // 15s timeout for the initial update CHECK only — if we can't reach
    // GitHub in 15s, proceed with the app. Once a download starts,
    // the timeout is cleared and we wait for it to finish.
    const timeout = setTimeout(() => {
      log('Update check timed out (no response from GitHub), proceeding');
      cleanup();
      resolve();
    }, 15000);

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
    autoUpdater.disableDifferentialDownload = true;

    let updateVersion = '';

    autoUpdater.on('checking-for-update', () => {
      log('Checking for updates...');
      if (onStatus) onStatus('checking');
    });

    autoUpdater.on('update-available', (info) => {
      updateVersion = info.version;
      log(`Update available: ${updateVersion} — downloading (timeout cleared)`);
      clearTimeout(timeout);
      if (onStatus) onStatus('downloading', `Downloading v${updateVersion}...`);
    });

    autoUpdater.on('update-not-available', (info) => {
      log(`App is up to date (latest: ${info?.version})`);
      cleanup();
      resolve();
    });

    autoUpdater.on('download-progress', (progress) => {
      const pct = Math.round(progress.percent);
      if (onProgress) onProgress(progress.percent);
      if (onStatus) onStatus('downloading', `Downloading v${updateVersion}... ${pct}%`);
    });

    autoUpdater.on('update-downloaded', (info) => {
      log(`Update downloaded: ${info.version} — quitting and installing`);
      if (onStatus) onStatus('installing', `Installing v${info.version}...`);
      cleanup();
      // Don't resolve — quit and install immediately
      setTimeout(() => {
        autoUpdater.quitAndInstall(false, true); // isSilent=false, isForceRunAfter=true
      }, 1500);
    });

    autoUpdater.on('error', (err) => {
      log(`Error: ${err.message}`);
      cleanup();
      resolve(); // Proceed with app on error
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
