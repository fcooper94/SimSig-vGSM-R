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

  // Phone calls
  PHONE_CALLS_UPDATE: 'phone:calls-update',
  PHONE_ANSWER_CALL: 'phone:answer-call',
  PHONE_REPLY_CALL: 'phone:reply-call',

  // TTS
  TTS_GET_VOICES: 'tts:get-voices',
  TTS_SPEAK: 'tts:speak',

  // Sim info
  SIM_NAME: 'sim:name',

  // STT
  STT_TRANSCRIBE: 'stt:transcribe',
};
