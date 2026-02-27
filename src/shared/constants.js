module.exports = {
  DEFAULT_HOST: 'localhost',
  DEFAULT_PORT: 51515,

  TOPICS: {
    TD: '/topic/TD_ALL_SIG_AREA',
    TRAIN_MVT: '/topic/TRAIN_MVT_ALL_TOC',
    SIMSIG: '/topic/SimSig',
  },

  MSG_TYPES: {
    CA_MSG: 'CA_MSG',
    CB_MSG: 'CB_MSG',
    CC_MSG: 'CC_MSG',
    SG_MSG: 'SG_MSG',
    TRAIN_LOCATION: 'train_location',
    TRAIN_DELAY: 'train_delay',
    CLOCK_MSG: 'clock_msg',
  },

  DEFAULT_SETTINGS: {
    gateway: {
      host: 'localhost',
      port: 51515,
    },
    credentials: {
      username: '',
      password: '',
    },
    audio: {
      inputDeviceId: 'default',
      outputDeviceId: 'default',
      micVolume: 50,
      outputVolume: 50,
    },
    ptt: {
      keybind: 'Space',
    },
    signaller: {
      panelName: '',
    },
    tts: {
      provider: 'edge',
      elevenLabsApiKey: '',
    },
  },
};
