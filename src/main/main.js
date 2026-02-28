const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const webServer = require('./web-server');
const channels = require('../shared/ipc-channels');

let mainWindow = null;
let msgLogWindow = null;
let setupWindow = null;
let splashWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1194,
    height: 834,
    minWidth: 700,
    minHeight: 400,
    title: 'SimSig VGSM-R',
    icon: path.join(__dirname, '../../images/icon.png'),
    backgroundColor: '#505050',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.setMenu(null);
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('close', (e) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['Yes', 'No'],
      defaultId: 1,
      title: 'Confirm',
      message: 'Are you sure you want to close SimSig VGSM-R?',
    });
    if (choice === 1) e.preventDefault();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 750,
    height: 600,
    resizable: false,
    title: 'vGSM-R Setup',
    icon: path.join(__dirname, '../../images/icon.png'),
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload-setup.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  setupWindow.setMenu(null);
  setupWindow.loadFile(path.join(__dirname, '../renderer/setup.html'));

  if (process.argv.includes('--dev')) {
    setupWindow.webContents.openDevTools();
  }

  setupWindow.on('closed', () => {
    setupWindow = null;
  });
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 1194,
    height: 834,
    minWidth: 700,
    minHeight: 400,
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
  splashWindow.loadFile(path.join(__dirname, '../renderer/update.html'));
  splashWindow.once('ready-to-show', () => splashWindow.show());

  splashWindow.on('closed', () => {
    splashWindow = null;
  });

  return splashWindow;
}

function sendSplashStatus(message, detail) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('update:status', { message, detail });
  }
}

function sendSplashProgress(percent) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('update:progress', { percent });
  }
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
  }
}

function createMessageLogWindow() {
  if (msgLogWindow) {
    msgLogWindow.focus();
    return;
  }

  msgLogWindow = new BrowserWindow({
    width: 700,
    height: 500,
    minWidth: 400,
    minHeight: 300,
    title: 'Message Log - SimSig VGSM-R',
    backgroundColor: '#505050',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload-msglog.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  msgLogWindow.loadFile(path.join(__dirname, '../renderer/message-log.html'));

  msgLogWindow.on('closed', () => {
    msgLogWindow = null;
  });
}

function getMessageLogWindow() {
  return msgLogWindow;
}

const FIREWALL_RULE_NAME = 'SimSig VGSM-R Browser Access';

function addFirewallRule(port) {
  const { exec } = require('child_process');
  // Remove any existing rule first, then add for the correct port
  const del = `netsh advfirewall firewall delete rule name="${FIREWALL_RULE_NAME}"`;
  const add = `netsh advfirewall firewall add rule name="${FIREWALL_RULE_NAME}" dir=in action=allow protocol=TCP localport=${port}`;
  exec(`${del} >nul 2>&1 & ${add}`, { windowsHide: true }, (err) => {
    if (err) {
      console.warn('[WebServer] Could not add firewall rule (may need admin):', err.message);
    } else {
      console.log(`[WebServer] Firewall rule added for port ${port}`);
    }
  });
}

function removeFirewallRule() {
  const { exec } = require('child_process');
  exec(`netsh advfirewall firewall delete rule name="${FIREWALL_RULE_NAME}"`, { windowsHide: true }, () => {});
}

function startWebServer(port) {
  const { handlerMap, setWsBroadcast, getInitialState } = require('./ipc-handlers');
  const globalPtt = require('./global-ptt');

  webServer.start(port, handlerMap, getInitialState);
  setWsBroadcast(webServer.broadcast);
  globalPtt.setWsBroadcast(webServer.broadcast);
  addFirewallRule(port);
  console.log(`[WebServer] Started on port ${port}`);
}

function stopWebServer() {
  const { setWsBroadcast } = require('./ipc-handlers');
  const globalPtt = require('./global-ptt');

  webServer.stop();
  setWsBroadcast(null);
  globalPtt.setWsBroadcast(null);
  removeFirewallRule();
}

app.whenReady().then(async () => {
  // Show splash screen immediately
  createSplashWindow();

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  // Phase 1: Checking for updates (1.5s visible minimum)
  sendSplashStatus('checking');
  const updateStart = Date.now();
  const { checkForUpdates } = require('./updater');
  await checkForUpdates({
    onStatus: (message, detail) => sendSplashStatus('checking', detail),
    onProgress: (percent) => sendSplashProgress(percent),
  });
  const elapsed = Date.now() - updateStart;
  if (elapsed < 1500) await delay(1500 - elapsed);

  // Phase 2: Initialising (1.5s visible minimum)
  sendSplashStatus('initialising');
  const initStart = Date.now();

  const { initSettings } = require('./settings');
  const settings = require('./settings');
  const { registerIpcHandlers } = require('./ipc-handlers');

  initSettings();
  registerIpcHandlers();

  const initElapsed = Date.now() - initStart;
  if (initElapsed < 1500) await delay(1500 - initElapsed);

  // Close splash and open the appropriate window
  closeSplash();

  if (settings.get('setupComplete') === false) {
    createSetupWindow();
  } else {
    createWindow();
  }

  // Setup wizard completion handler
  ipcMain.handle(channels.SETUP_COMPLETE, async (_event, allSettings) => {
    for (const [key, value] of Object.entries(allSettings)) {
      settings.set(key, value);
    }
    settings.set('setupComplete', true);

    // Close setup window and open main window
    createWindow();
    if (setupWindow) {
      setupWindow.close();
    }

    // Auto-start web server if enabled during setup
    const webCfg = settings.get('web') || {};
    if (webCfg.enabled) {
      startWebServer(webCfg.port || 3000);
    }
  });

  // Web server IPC handlers
  ipcMain.handle(channels.WEB_START, (_event, port) => {
    if (webServer.isRunning()) stopWebServer();
    const actualPort = port || 3000;
    startWebServer(actualPort);

    // Get local network IP for the overlay URL
    // Prefer 192.168.x.x (LAN) over 10.x.x.x (often VPN/virtual adapters)
    const os = require('os');
    const nets = os.networkInterfaces();
    const allIPs = [];
    for (const iface of Object.values(nets)) {
      for (const addr of iface) {
        if ((addr.family === 'IPv4' || addr.family === 4) && !addr.internal) {
          allIPs.push(addr.address);
        }
      }
    }
    const localIP = allIPs.find(ip => ip.startsWith('192.168.'))
      || allIPs.find(ip => ip.startsWith('172.'))
      || allIPs[0]
      || 'localhost';

    return { success: true, port: actualPort, ip: localIP };
  });

  ipcMain.handle(channels.WEB_STOP, () => {
    stopWebServer();
    return { success: true };
  });

  // Auto-start web server if enabled in settings (skip during setup)
  if (settings.get('setupComplete') !== false) {
    const webSettings = settings.get('web') || {};
    if (webSettings.enabled) {
      startWebServer(webSettings.port || 3000);
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Restore SimSig dialogs to visible positions on quit
// Uses 'start' via cmd.exe so the PowerShell process is fully independent
let restoreDone = false;
function restoreTelephoneWindow() {
  if (restoreDone) return;
  restoreDone = true;
  const { exec } = require('child_process');
  const restoreScript = path.join(__dirname, 'restore-telephone.ps1');
  const cmd = `start "" /B powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${restoreScript}"`;
  exec(cmd, { windowsHide: true });
  console.log('[Quit] Launched restore script');
}

app.on('before-quit', () => {
  restoreTelephoneWindow();
  try { webServer.stop(); removeFirewallRule(); } catch (_) {}
  try { require('./global-ptt').stop(); } catch (_) {}
});
app.on('will-quit', restoreTelephoneWindow);

app.on('window-all-closed', () => {
  // Don't quit if we're transitioning between windows
  if (mainWindow || setupWindow || splashWindow) return;
  restoreTelephoneWindow();
  app.quit();
});

module.exports = { createMessageLogWindow, getMessageLogWindow };
