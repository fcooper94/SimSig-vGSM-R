const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let mainWindow = null;

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

app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
