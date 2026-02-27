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
};
