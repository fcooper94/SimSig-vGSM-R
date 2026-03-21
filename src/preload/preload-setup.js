const { contextBridge, ipcRenderer } = require('electron');

// IPC channel constants inlined here because sandboxed preload scripts
// cannot require() relative paths — only 'electron' and built-in modules
const channels = {
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_GET_ALL: 'settings:get-all',
  SETUP_COMPLETE: 'setup:complete',
  TTS_CHECK_CREDITS: 'tts:check-credits',
};

contextBridge.exposeInMainWorld('setupAPI', {
  settings: {
    get: (key) => ipcRenderer.invoke(channels.SETTINGS_GET, key),
    set: (key, value) => ipcRenderer.invoke(channels.SETTINGS_SET, key, value),
    getAll: () => ipcRenderer.invoke(channels.SETTINGS_GET_ALL),
  },
  complete: (allSettings) => ipcRenderer.invoke(channels.SETUP_COMPLETE, allSettings),
  keepSettings: () => ipcRenderer.invoke('setup:keep-settings'),
  tts: {
    checkChatterbox: (url) => ipcRenderer.invoke('tts:check-chatterbox', url),
    checkGpu: () => ipcRenderer.invoke('chatterbox:gpu-check'),
    startInstall: () => ipcRenderer.invoke('chatterbox:start'),
    onInstallProgress: (callback) => {
      const listener = (_event, data) => callback(data);
      ipcRenderer.on('chatterbox:install-progress', listener);
      return () => ipcRenderer.removeListener('chatterbox:install-progress', listener);
    },
  },
});
