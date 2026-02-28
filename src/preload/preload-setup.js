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
  tts: {
    checkCredits: (apiKey) => ipcRenderer.invoke(channels.TTS_CHECK_CREDITS, apiKey),
  },
});
