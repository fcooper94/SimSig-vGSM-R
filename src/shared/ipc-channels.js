module.exports = {
  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_GET_ALL: 'settings:get-all',

  // Connection
  CONNECTION_CONNECT: 'connection:connect',
  CONNECTION_DISCONNECT: 'connection:disconnect',
  CONNECTION_STATUS: 'connection:status-changed',

  // Messages
  MESSAGE_RECEIVED: 'message:received',
  CLOCK_UPDATE: 'clock:update',

  // Commands
  CMD_ALL_SIGNALS_DANGER: 'cmd:all-signals-danger',
  CMD_OPEN_MESSAGE_LOG: 'cmd:open-message-log',

  // Audio
  AUDIO_DEVICES: 'audio:get-devices',
  PTT_STATE: 'ptt:state-changed',
  PTT_SET_KEYBIND: 'ptt:set-keybind',
  ANSWER_CALL_KEY: 'keys:answer-call',
  ANSWER_CALL_SET_KEYBIND: 'keys:answer-call-set-keybind',
  HANGUP_KEY: 'keys:hangup',
  HANGUP_SET_KEYBIND: 'keys:hangup-set-keybind',
  PHONE_IN_CALL: 'keys:phone-in-call',

  // Phone calls
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
  PHONE_SILENCE_RING: 'phone:silence-ring',
  PHONE_CALL_ANSWERED: 'phone:call-answered',

  // TTS
  TTS_GET_VOICES: 'tts:get-voices',
  TTS_SPEAK: 'tts:speak',
  TTS_CHECK_CREDITS: 'tts:check-credits',

  // Sim info
  SIM_NAME: 'sim:name',

  // Init
  INIT_READY: 'init:ready',

  // STT
  STT_TRANSCRIBE: 'stt:transcribe',

  // Window
  WINDOW_TOGGLE_FULLSCREEN: 'window:toggle-fullscreen',

  // Browser mirror (chat state sync + remote interaction)
  PHONE_CHAT_SYNC: 'phone:chat-sync',
  PHONE_REMOTE_ACTION: 'phone:remote-action',

  // Web server (browser access)
  WEB_START: 'web:start',
  WEB_STOP: 'web:stop',

  // Setup wizard
  SETUP_COMPLETE: 'setup:complete',
};
