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
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
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
    backgroundColor: '#1a1a2e',
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

app.on('window-all-closed', () => {
  app.quit();
});

module.exports = { createMessageLogWindow, getMessageLogWindow };
