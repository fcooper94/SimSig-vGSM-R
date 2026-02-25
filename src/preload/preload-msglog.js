const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('simsigAPI', {
  messages: {
    onMessage: (callback) => {
      const listener = (_event, msg) => callback(msg);
      ipcRenderer.on('message:received', listener);
      return () => ipcRenderer.removeListener('message:received', listener);
    },
  },
});
