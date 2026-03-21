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
  PHONE_FORCE_CLOSE_CALL: 'phone:force-close-call',
  PHONE_DRIVER_HUNG_UP: 'phone:driver-hung-up',
  PHONE_SILENCE_RING: 'phone:silence-ring',
  PHONE_CALL_ANSWERED: 'phone:call-answered',
  PHONE_AUTO_WAIT: 'phone:auto-wait',
  PHONE_CLEAR_AUTO_WAIT: 'phone:clear-auto-wait',
  PHONE_GET_RECENT_LOG: 'phone:get-recent-log',
  TTS_GET_VOICES: 'tts:get-voices',
  TTS_SPEAK: 'tts:speak',
  TTS_CHECK_CREDITS: 'tts:check-credits',
  STT_TRANSCRIBE: 'stt:transcribe',
  SIM_NAME: 'sim:name',
  INIT_READY: 'init:ready',
  WINDOW_TOGGLE_FULLSCREEN: 'window:toggle-fullscreen',
  WINDOW_TOGGLE_COMPACT: 'window:toggle-compact',
  WINDOW_COMPACT_RESIZE: 'window:compact-resize',
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_CONFIRM_CLOSE: 'window:confirm-close',
  WINDOW_CONFIRM_CLOSE_REPLY: 'window:confirm-close-reply',
  PHONE_CHAT_SYNC: 'phone:chat-sync',
  PHONE_REMOTE_ACTION: 'phone:remote-action',
  WEB_START: 'web:start',
  WEB_STOP: 'web:stop',
  FAILURE_DISMISSED: 'sim:failure-dismissed',
  MESSAGE_LOG_LINES: 'sim:message-log-lines',
  DETECT_GATEWAY_HOST: 'settings:detect-gateway-host',
  SIM_IS_RUNNING: 'sim:is-running',
  PLAYER_PEERS_UPDATE: 'player:peers-update',
  PLAYER_DIAL: 'player:dial',
  PLAYER_ANSWER: 'player:answer',
  PLAYER_REJECT: 'player:reject',
  PLAYER_HANGUP: 'player:hangup',
  PLAYER_CANCEL_DIAL: 'player:cancel-dial',
  PLAYER_INCOMING_CALL: 'player:incoming-call',
  PLAYER_CALL_ANSWERED: 'player:call-answered',
  PLAYER_CALL_ENDED: 'player:call-ended',
  PLAYER_WEBRTC_SIGNAL: 'player:webrtc-signal',
  PLAYER_WEBRTC_SIGNAL_SEND: 'player:webrtc-signal-send',
  PLAYER_CALL_REJECTED: 'player:call-rejected',
};

contextBridge.exposeInMainWorld('simsigAPI', {
  settings: {
    get: (key) => ipcRenderer.invoke(channels.SETTINGS_GET, key),
    set: (key, value) => ipcRenderer.invoke(channels.SETTINGS_SET, key, value),
    getAll: () => ipcRenderer.invoke(channels.SETTINGS_GET_ALL),
    detectGatewayHost: () => ipcRenderer.invoke(channels.DETECT_GATEWAY_HOST),
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
      ipcRenderer.on(channels.INIT_READY, () => callback());
    },
    onFailure: (callback) => {
      const listener = (_event, dismissed) => callback(dismissed);
      ipcRenderer.on(channels.FAILURE_DISMISSED, listener);
      return () => ipcRenderer.removeListener(channels.FAILURE_DISMISSED, listener);
    },
    onMessageLog: (callback) => {
      const listener = (_event, lines) => callback(lines);
      ipcRenderer.on(channels.MESSAGE_LOG_LINES, listener);
      return () => ipcRenderer.removeListener(channels.MESSAGE_LOG_LINES, listener);
    },
    isRunning: () => ipcRenderer.invoke(channels.SIM_IS_RUNNING),
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
    placeCallStatus: (contactName) => ipcRenderer.invoke(channels.PHONE_PLACE_CALL_STATUS, contactName),
    placeCallReply: (replyIndex, headCode, param2, contactName) => ipcRenderer.invoke(channels.PHONE_PLACE_CALL_REPLY, replyIndex, headCode, param2, contactName),
    placeCallHangup: () => ipcRenderer.invoke(channels.PHONE_PLACE_CALL_HANGUP),
    hideAnswerDialog: () => ipcRenderer.invoke(channels.PHONE_HIDE_ANSWER),
    forceCloseCall: () => ipcRenderer.invoke(channels.PHONE_FORCE_CLOSE_CALL),
    autoWait: (headcode, signal) => ipcRenderer.invoke(channels.PHONE_AUTO_WAIT, headcode, signal),
    clearAutoWait: (headcode) => ipcRenderer.invoke(channels.PHONE_CLEAR_AUTO_WAIT, headcode),
    getRecentLog: (headcode, sinceTs) => ipcRenderer.invoke(channels.PHONE_GET_RECENT_LOG, headcode, sinceTs),
    silenceRing: () => ipcRenderer.invoke(channels.PHONE_SILENCE_RING),
    onSilenceRing: (callback) => {
      const listener = () => callback();
      ipcRenderer.on(channels.PHONE_SILENCE_RING, listener);
      return () => ipcRenderer.removeListener(channels.PHONE_SILENCE_RING, listener);
    },
    notifyCallAnswered: (train) => ipcRenderer.invoke(channels.PHONE_CALL_ANSWERED, train),
    onCallAnswered: (callback) => {
      const listener = (_event, train) => callback(train);
      ipcRenderer.on(channels.PHONE_CALL_ANSWERED, listener);
      return () => ipcRenderer.removeListener(channels.PHONE_CALL_ANSWERED, listener);
    },
    onDriverHungUp: (callback) => {
      const listener = () => callback();
      ipcRenderer.on(channels.PHONE_DRIVER_HUNG_UP, listener);
      return () => ipcRenderer.removeListener(channels.PHONE_DRIVER_HUNG_UP, listener);
    },
    chatSync: (state) => ipcRenderer.invoke(channels.PHONE_CHAT_SYNC, state),
    onChatSync: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on(channels.PHONE_CHAT_SYNC, listener);
      return () => ipcRenderer.removeListener(channels.PHONE_CHAT_SYNC, listener);
    },
    remoteAction: (action) => ipcRenderer.invoke(channels.PHONE_REMOTE_ACTION, action),
    onRemoteAction: (callback) => {
      const listener = (_event, action) => callback(action);
      ipcRenderer.on(channels.PHONE_REMOTE_ACTION, listener);
      return () => ipcRenderer.removeListener(channels.PHONE_REMOTE_ACTION, listener);
    },
  },

  tts: {
    getVoices: () => ipcRenderer.invoke(channels.TTS_GET_VOICES),
    speak: (text, voiceId) => ipcRenderer.invoke(channels.TTS_SPEAK, text, voiceId),
    checkChatterbox: (url) => ipcRenderer.invoke(channels.TTS_CHECK_CHATTERBOX, url),
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

  window: {
    toggleFullscreen: () => ipcRenderer.invoke(channels.WINDOW_TOGGLE_FULLSCREEN),
    toggleCompact: () => ipcRenderer.invoke(channels.WINDOW_TOGGLE_COMPACT),
    compactResize: (height) => ipcRenderer.invoke(channels.WINDOW_COMPACT_RESIZE, height),
    minimize: () => ipcRenderer.invoke(channels.WINDOW_MINIMIZE),
    maximize: () => ipcRenderer.invoke(channels.WINDOW_MAXIMIZE),
    close: () => ipcRenderer.invoke(channels.WINDOW_CLOSE),
    onCompactChanged: (callback) => {
      const listener = (_event, isCompact) => callback(isCompact);
      ipcRenderer.on('window:compact-changed', listener);
      return () => ipcRenderer.removeListener('window:compact-changed', listener);
    },
    onConfirmClose: (callback) => {
      const listener = () => callback();
      ipcRenderer.on(channels.WINDOW_CONFIRM_CLOSE, listener);
      return () => ipcRenderer.removeListener(channels.WINDOW_CONFIRM_CLOSE, listener);
    },
    confirmCloseReply: (confirmed) => ipcRenderer.send(channels.WINDOW_CONFIRM_CLOSE_REPLY, confirmed),
  },

  web: {
    start: (port) => ipcRenderer.invoke(channels.WEB_START, port),
    stop: () => ipcRenderer.invoke(channels.WEB_STOP),
  },

  player: {
    onPeersUpdate: (callback) => {
      const listener = (_event, peers) => callback(peers);
      ipcRenderer.on(channels.PLAYER_PEERS_UPDATE, listener);
      return () => ipcRenderer.removeListener(channels.PLAYER_PEERS_UPDATE, listener);
    },
    dial: (peerId, host, port) => ipcRenderer.invoke(channels.PLAYER_DIAL, peerId, host, port),
    answer: () => ipcRenderer.invoke(channels.PLAYER_ANSWER),
    reject: (reason) => ipcRenderer.invoke(channels.PLAYER_REJECT, reason),
    hangUp: () => ipcRenderer.invoke(channels.PLAYER_HANGUP),
    cancelDial: () => ipcRenderer.invoke(channels.PLAYER_CANCEL_DIAL),
    sendWebRTCSignal: (targetId, signal) => ipcRenderer.invoke(channels.PLAYER_WEBRTC_SIGNAL_SEND, targetId, signal),
    rescan: () => ipcRenderer.invoke(channels.PLAYER_RESCAN),
    onWebRTCSignal: (callback) => {
      const listener = (_event, data) => callback(data);
      ipcRenderer.on(channels.PLAYER_WEBRTC_SIGNAL, listener);
      return () => ipcRenderer.removeListener(channels.PLAYER_WEBRTC_SIGNAL, listener);
    },
    onIncomingCall: (callback) => {
      const listener = (_event, data) => callback(data);
      ipcRenderer.on(channels.PLAYER_INCOMING_CALL, listener);
      return () => ipcRenderer.removeListener(channels.PLAYER_INCOMING_CALL, listener);
    },
    onCallAnswered: (callback) => {
      const listener = (_event, data) => callback(data);
      ipcRenderer.on(channels.PLAYER_CALL_ANSWERED, listener);
      return () => ipcRenderer.removeListener(channels.PLAYER_CALL_ANSWERED, listener);
    },
    onCallEnded: (callback) => {
      const listener = () => callback();
      ipcRenderer.on(channels.PLAYER_CALL_ENDED, listener);
      return () => ipcRenderer.removeListener(channels.PLAYER_CALL_ENDED, listener);
    },
    onCallRejected: (callback) => {
      const listener = (_event, reason) => callback(reason);
      ipcRenderer.on(channels.PLAYER_CALL_REJECTED, listener);
      return () => ipcRenderer.removeListener(channels.PLAYER_CALL_REJECTED, listener);
    },
    onOurPanel: (callback) => {
      const listener = (_event, panelName) => callback(panelName);
      ipcRenderer.on('workstation:our-panel', listener);
      return () => ipcRenderer.removeListener('workstation:our-panel', listener);
    },
  },

  app: {
    getVersion: () => ipcRenderer.invoke('app:get-version'),
    log: (msg) => ipcRenderer.send('log:renderer', msg),
  },
});
