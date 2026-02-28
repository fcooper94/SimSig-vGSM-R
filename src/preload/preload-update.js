const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updateAPI', {
  onStatus: (callback) => ipcRenderer.on('update:status', (_e, data) => callback(data)),
  onProgress: (callback) => ipcRenderer.on('update:progress', (_e, data) => callback(data)),
});
