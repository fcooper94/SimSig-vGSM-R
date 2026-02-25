const { contextBridge, ipcRenderer } = require('electron');

// IPC channel constants inlined here because sandboxed preload scripts
// cannot require() relative paths — only 'electron' and built-in modules
const channels = {
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_GET_ALL: 'settings:get-all',
  CONNECTION_CONNECT: 'connection:connect',
  CONNECTION_DISCONNECT: 'connection:disconnect',
  CONNECTION_STATUS: 'connection:status-changed',
  MESSAGE_RECEIVED: 'message:received',
  CLOCK_UPDATE: 'clock:update',
  CMD_ALL_SIGNALS_DANGER: 'cmd:all-signals-danger',
  CMD_OPEN_MESSAGE_LOG: 'cmd:open-message-log',
  PHONE_CALLS_UPDATE: 'phone:calls-update',
  PHONE_ANSWER_CALL: 'phone:answer-call',
  PHONE_REPLY_CALL: 'phone:reply-call',
  TTS_GET_VOICES: 'tts:get-voices',
  TTS_SPEAK: 'tts:speak',
  STT_TRANSCRIBE: 'stt:transcribe',
  SIM_NAME: 'sim:name',
};

contextBridge.exposeInMainWorld('simsigAPI', {
  settings: {
    get: (key) => ipcRenderer.invoke(channels.SETTINGS_GET, key),
    set: (key, value) => ipcRenderer.invoke(channels.SETTINGS_SET, key, value),
    getAll: () => ipcRenderer.invoke(channels.SETTINGS_GET_ALL),
  },

  connection: {
    connect: () => ipcRenderer.invoke(channels.CONNECTION_CONNECT),
    disconnect: () => ipcRenderer.invoke(channels.CONNECTION_DISCONNECT),
    onStatusChange: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on(channels.CONNECTION_STATUS, listener);
      return () => ipcRenderer.removeListener(channels.CONNECTION_STATUS, listener);
    },
  },

  messages: {
    onMessage: (callback) => {
      const listener = (_event, msg) => callback(msg);
      ipcRenderer.on(channels.MESSAGE_RECEIVED, listener);
      return () => ipcRenderer.removeListener(channels.MESSAGE_RECEIVED, listener);
    },
  },

  commands: {
    allSignalsToDanger: () => ipcRenderer.invoke(channels.CMD_ALL_SIGNALS_DANGER),
    openMessageLog: () => ipcRenderer.invoke(channels.CMD_OPEN_MESSAGE_LOG),
  },

  clock: {
    onUpdate: (callback) => {
      const listener = (_event, data) => callback(data);
      ipcRenderer.on(channels.CLOCK_UPDATE, listener);
      return () => ipcRenderer.removeListener(channels.CLOCK_UPDATE, listener);
    },
  },

  sim: {
    onName: (callback) => {
      const listener = (_event, name) => callback(name);
      ipcRenderer.on(channels.SIM_NAME, listener);
      return () => ipcRenderer.removeListener(channels.SIM_NAME, listener);
    },
  },

  phone: {
    onCallsUpdate: (callback) => {
      const listener = (_event, calls) => callback(calls);
      ipcRenderer.on(channels.PHONE_CALLS_UPDATE, listener);
      return () => ipcRenderer.removeListener(channels.PHONE_CALLS_UPDATE, listener);
    },
    answerCall: (index, train) => ipcRenderer.invoke(channels.PHONE_ANSWER_CALL, index, train),
    replyCall: (replyIndex, headCode) => ipcRenderer.invoke(channels.PHONE_REPLY_CALL, replyIndex, headCode),
  },

  tts: {
    getVoices: () => ipcRenderer.invoke(channels.TTS_GET_VOICES),
    speak: (text, voiceId) => ipcRenderer.invoke(channels.TTS_SPEAK, text, voiceId),
  },

  stt: {
    transcribe: (audioData) => ipcRenderer.invoke(channels.STT_TRANSCRIBE, audioData),
  },
});
