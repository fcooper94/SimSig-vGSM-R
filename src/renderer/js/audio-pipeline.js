const AudioPipeline = {
  audioContext: null,
  inputStream: null,
  inputNode: null,
  micGainNode: null,
  outputGainNode: null,
  _micVolume: 50,
  _outputVolume: 50,

  init() {
    // AudioContext is created on first user interaction to comply with autoplay policy
  },

  ensureContext() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
  },

  async startCapture() {
    this.ensureContext();

    try {
      const settings = await window.simsigAPI.settings.getAll();
      const deviceId = settings.audio?.inputDeviceId;

      const constraints = {
        audio: deviceId && deviceId !== 'default'
          ? { deviceId: { exact: deviceId } }
          : true,
      };

      this.inputStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.inputNode = this.audioContext.createMediaStreamSource(this.inputStream);

      // Mic gain node for volume control
      this.micGainNode = this.audioContext.createGain();
      this.micGainNode.gain.value = this._micVolume / 100;
      this.inputNode.connect(this.micGainNode);
      // Future: connect micGainNode to processing/analysis nodes
    } catch (err) {
      console.warn('Could not start audio capture:', err);
    }
  },

  stopCapture() {
    if (this.inputNode) {
      this.inputNode.disconnect();
      this.inputNode = null;
    }
    if (this.inputStream) {
      this.inputStream.getTracks().forEach((track) => track.stop());
      this.inputStream = null;
    }
  },

  async setOutputDevice(deviceId) {
    // setSinkId can be used on <audio> elements for output device routing
    // Stored for future use when audio playback is implemented
    this.outputDeviceId = deviceId;
  },

  setMicVolume(percent) {
    this._micVolume = percent;
    if (this.micGainNode) {
      this.micGainNode.gain.value = percent / 100;
    }
  },

  setOutputVolume(percent) {
    this._outputVolume = percent;
    if (this.outputGainNode) {
      this.outputGainNode.gain.value = percent / 100;
    }
  },
};
