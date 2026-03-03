const { app, BrowserWindow } = require('electron');
const path = require('path');

let mainWindow = null;
let splashWindow = null;

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

app.whenReady().then(async () => {
  // Show a splash-style window, wait 3 seconds, close it, open main window
  splashWindow = new BrowserWindow({
    width: 896,
    height: 626,
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
  splashWindow.setAlwaysOnTop(true, 'floating');
  splashWindow.loadFile(path.join(__dirname, '../renderer/update.html'));
  splashWindow.once('ready-to-show', () => splashWindow.show());

  // Wait 3 seconds then switch to main window
  await new Promise((r) => setTimeout(r, 3000));

  splashWindow.close();
  splashWindow = null;

  createWindow();
});

app.on('window-all-closed', () => {
  if (splashWindow) return;
  app.quit();
});
