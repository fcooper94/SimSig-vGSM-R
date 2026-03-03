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
  // Show a plain splash window with data URL — no update.html, no preload
  splashWindow = new BrowserWindow({
    width: 896,
    height: 626,
    resizable: false,
    frame: false,
    center: true,
    backgroundColor: '#000000',
  });

  splashWindow.setMenu(null);
  splashWindow.setAlwaysOnTop(true, 'floating');
  splashWindow.loadURL('data:text/html,<body style="background:#000;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif"><h1>Loading...</h1></body>');

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
