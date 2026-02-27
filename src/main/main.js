const { app, BrowserWindow } = require('electron');
const path = require('path');

let mainWindow = null;
let msgLogWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 700,
    minHeight: 400,
    title: 'SimSig GSM-R Comms',
    icon: path.join(__dirname, '../../images/icon.png'),
    backgroundColor: '#505050',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
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
    title: 'Message Log - SimSig GSM-R',
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

app.whenReady().then(() => {
  const { initSettings } = require('./settings');
  const { registerIpcHandlers } = require('./ipc-handlers');

  initSettings();
  registerIpcHandlers();
  createWindow();

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
  try { require('./global-ptt').stop(); } catch (_) {}
});
app.on('will-quit', restoreTelephoneWindow);

app.on('window-all-closed', () => {
  restoreTelephoneWindow();
  app.quit();
});

module.exports = { createMessageLogWindow, getMessageLogWindow };
