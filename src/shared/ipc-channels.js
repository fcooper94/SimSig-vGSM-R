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
  PHONE_FORCE_CLOSE_CALL: 'phone:force-close-call',
  PHONE_DRIVER_HUNG_UP: 'phone:driver-hung-up',
  PHONE_SILENCE_RING: 'phone:silence-ring',
  PHONE_CALL_ANSWERED: 'phone:call-answered',
  PHONE_AUTO_WAIT: 'phone:auto-wait',
  PHONE_CLEAR_AUTO_WAIT: 'phone:clear-auto-wait',
  PHONE_GET_RECENT_LOG: 'phone:get-recent-log',

  // TTS
  TTS_GET_VOICES: 'tts:get-voices',
  TTS_SPEAK: 'tts:speak',
  TTS_CHECK_CREDITS: 'tts:check-credits',

  // Sim info
  SIM_NAME: 'sim:name',
  FAILURE_DISMISSED: 'sim:failure-dismissed',
  MESSAGE_LOG_LINES: 'sim:message-log-lines',

  // Init
  INIT_READY: 'init:ready',

  // STT
  STT_TRANSCRIBE: 'stt:transcribe',

  // Window
  WINDOW_TOGGLE_FULLSCREEN: 'window:toggle-fullscreen',
  WINDOW_TOGGLE_COMPACT: 'window:toggle-compact',
  WINDOW_COMPACT_RESIZE: 'window:compact-resize',
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_CONFIRM_CLOSE: 'window:confirm-close',
  WINDOW_CONFIRM_CLOSE_REPLY: 'window:confirm-close-reply',

  // Browser mirror (chat state sync + remote interaction)
  PHONE_CHAT_SYNC: 'phone:chat-sync',
  PHONE_REMOTE_ACTION: 'phone:remote-action',

  // Web server (browser access)
  WEB_START: 'web:start',
  WEB_STOP: 'web:stop',

  // Detection
  DETECT_GATEWAY_HOST: 'settings:detect-gateway-host',
  SIM_IS_RUNNING: 'sim:is-running',

  // Setup wizard
  SETUP_COMPLETE: 'setup:complete',

  // Player-to-player calls
  PLAYER_PEERS_UPDATE: 'player:peers-update',
  PLAYER_DIAL: 'player:dial',
  PLAYER_ANSWER: 'player:answer',
  PLAYER_REJECT: 'player:reject',
  PLAYER_HANGUP: 'player:hangup',
  PLAYER_CANCEL_DIAL: 'player:cancel-dial',
  PLAYER_INCOMING_CALL: 'player:incoming-call',
  PLAYER_CALL_ANSWERED: 'player:call-answered',
  PLAYER_CALL_ENDED: 'player:call-ended',
  PLAYER_SEND_AUDIO: 'player:send-audio',
  PLAYER_AUDIO_RECEIVED: 'player:audio-received',
  PLAYER_CALL_REJECTED: 'player:call-rejected',
};
