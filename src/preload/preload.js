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
  PTT_STATE: 'ptt:state-changed',
  PTT_SET_KEYBIND: 'ptt:set-keybind',
  ANSWER_CALL_KEY: 'keys:answer-call',
  ANSWER_CALL_SET_KEYBIND: 'keys:answer-call-set-keybind',
  HANGUP_KEY: 'keys:hangup',
  HANGUP_SET_KEYBIND: 'keys:hangup-set-keybind',
  PHONE_IN_CALL: 'keys:phone-in-call',
  MESSAGE_RECEIVED: 'message:received',
  CLOCK_UPDATE: 'clock:update',
  CMD_ALL_SIGNALS_DANGER: 'cmd:all-signals-danger',
  CMD_OPEN_MESSAGE_LOG: 'cmd:open-message-log',
  PHONE_CALLS_UPDATE: 'phone:calls-update',
  PHONE_ANSWER_CALL: 'phone:answer-call',
  PHONE_REPLY_CALL: 'phone:reply-call',
  PHONE_BOOK_READ: 'phone:book-read',
  PHONE_BOOK_DIAL: 'phone:book-dial',
  PHONE_PLACE_CALL_STATUS: 'phone:place-call-status',
  PHONE_PLACE_CALL_REPLY: 'phone:place-call-reply',
  PHONE_PLACE_CALL_HANGUP: 'phone:place-call-hangup',
  PHONE_HIDE_ANSWER: 'phone:hide-answer',
  PHONE_DRIVER_HUNG_UP: 'phone:driver-hung-up',
  TTS_GET_VOICES: 'tts:get-voices',
  TTS_SPEAK: 'tts:speak',
  TTS_CHECK_CREDITS: 'tts:check-credits',
  STT_TRANSCRIBE: 'stt:transcribe',
  SIM_NAME: 'sim:name',
  INIT_READY: 'init:ready',
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
    onReady: (callback) => {
      ipcRenderer.once(channels.INIT_READY, () => callback());
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
    readPhoneBook: () => ipcRenderer.invoke(channels.PHONE_BOOK_READ),
    dialPhoneBook: (index) => ipcRenderer.invoke(channels.PHONE_BOOK_DIAL, index),
    placeCallStatus: () => ipcRenderer.invoke(channels.PHONE_PLACE_CALL_STATUS),
    placeCallReply: (replyIndex, headCode) => ipcRenderer.invoke(channels.PHONE_PLACE_CALL_REPLY, replyIndex, headCode),
    placeCallHangup: () => ipcRenderer.invoke(channels.PHONE_PLACE_CALL_HANGUP),
    hideAnswerDialog: () => ipcRenderer.invoke(channels.PHONE_HIDE_ANSWER),
    onDriverHungUp: (callback) => {
      const listener = () => callback();
      ipcRenderer.on(channels.PHONE_DRIVER_HUNG_UP, listener);
      return () => ipcRenderer.removeListener(channels.PHONE_DRIVER_HUNG_UP, listener);
    },
  },

  tts: {
    getVoices: () => ipcRenderer.invoke(channels.TTS_GET_VOICES),
    speak: (text, voiceId) => ipcRenderer.invoke(channels.TTS_SPEAK, text, voiceId),
    checkCredits: (apiKey) => ipcRenderer.invoke(channels.TTS_CHECK_CREDITS, apiKey),
  },

  ptt: {
    onStateChange: (callback) => {
      const listener = (_event, active) => callback(active);
      ipcRenderer.on(channels.PTT_STATE, listener);
      return () => ipcRenderer.removeListener(channels.PTT_STATE, listener);
    },
    setKeybind: (code) => ipcRenderer.invoke(channels.PTT_SET_KEYBIND, code),
  },

  keys: {
    onAnswerCall: (callback) => {
      const listener = () => callback();
      ipcRenderer.on(channels.ANSWER_CALL_KEY, listener);
      return () => ipcRenderer.removeListener(channels.ANSWER_CALL_KEY, listener);
    },
    onHangUp: (callback) => {
      const listener = () => callback();
      ipcRenderer.on(channels.HANGUP_KEY, listener);
      return () => ipcRenderer.removeListener(channels.HANGUP_KEY, listener);
    },
    setAnswerCallKeybind: (code) => ipcRenderer.invoke(channels.ANSWER_CALL_SET_KEYBIND, code),
    setHangUpKeybind: (code) => ipcRenderer.invoke(channels.HANGUP_SET_KEYBIND, code),
    setInCall: (state) => ipcRenderer.invoke(channels.PHONE_IN_CALL, state),
  },

  stt: {
    transcribe: (audioData) => ipcRenderer.invoke(channels.STT_TRANSCRIBE, audioData),
  },
});
