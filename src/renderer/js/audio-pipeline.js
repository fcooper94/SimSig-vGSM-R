const AudioPipeline = {
  audioContext: null,
  inputStream: null,
  inputNode: null,
  micGainNode: null,
  analyserNode: null,
  outputGainNode: null,
  _micVolume: 50,
  _outputVolume: 50,
  _meterAnimId: null,

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

      // Analyser node for live level metering
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 256;
      this.analyserNode.smoothingTimeConstant = 0.3;
      this.micGainNode.connect(this.analyserNode);
    } catch (err) {
      console.warn('Could not start audio capture:', err);
    }
  },

  stopCapture() {
    this.stopMeter();
    if (this.inputNode) {
      this.inputNode.disconnect();
      this.inputNode = null;
    }
    if (this.inputStream) {
      this.inputStream.getTracks().forEach((track) => track.stop());
      this.inputStream = null;
    }
    this.analyserNode = null;
  },

  // Get current mic level as 0-100 percentage (RMS-based)
  getMicLevel() {
    if (!this.analyserNode) return 0;
    const data = new Float32Array(this.analyserNode.fftSize);
    this.analyserNode.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    // Convert RMS to a 0-100 scale (RMS of ~0.3 = loud speech)
    return Math.min(100, rms * 333);
  },

  // Start animating a meter bar element
  startMeter(barEl) {
    this.stopMeter();
    const update = () => {
      const level = this.getMicLevel();
      barEl.style.width = level + '%';
      // Color: green in sweet spot (30-70%), yellow outside, red if clipping
      if (level > 90) barEl.className = 'mic-meter-fill clip';
      else if (level >= 25 && level <= 75) barEl.className = 'mic-meter-fill good';
      else barEl.className = 'mic-meter-fill';
      this._meterAnimId = requestAnimationFrame(update);
    };
    this._meterAnimId = requestAnimationFrame(update);
  },

  stopMeter() {
    if (this._meterAnimId) {
      cancelAnimationFrame(this._meterAnimId);
      this._meterAnimId = null;
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
