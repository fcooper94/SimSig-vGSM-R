const { app, BrowserWindow } = require('electron');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    title: 'vGSM-R Diagnostic',
  });

  mainWindow.loadURL('data:text/html,<h1>It works!</h1><p>If you can see this, Electron is running correctly.</p>');

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
