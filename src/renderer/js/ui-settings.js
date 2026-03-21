const SettingsUI = {
  modal: null,
  form: null,
  isListeningForKeybind: false,

  init() {
    this.modal = document.getElementById('settings-modal');
    this.form = document.getElementById('settings-form');

    const settingsBtn = document.getElementById('settings-btn');
    if (settingsBtn) settingsBtn.addEventListener('click', () => this.open());
    document.getElementById('settings-save').addEventListener('click', () => this.save());
    document.getElementById('settings-cancel').addEventListener('click', () => this.close());
    document.querySelectorAll('.rebind-btn').forEach((btn) => {
      btn.addEventListener('click', () => this.startKeybindListen(btn));
    });

    // Live volume percentage display + real-time gain update for meter feedback
    const micSlider = document.getElementById('setting-mic-volume');
    micSlider.addEventListener('input', (e) => {
      document.getElementById('mic-volume-val').textContent = e.target.value + '%';
      if (typeof AudioPipeline !== 'undefined') AudioPipeline.setMicVolume(parseInt(e.target.value, 10));
    });
    document.getElementById('setting-output-volume').addEventListener('input', (e) => {
      document.getElementById('output-volume-val').textContent = e.target.value + '%';
    });
    document.getElementById('setting-ring-volume').addEventListener('input', (e) => {
      document.getElementById('ring-volume-val').textContent = e.target.value + '%';
      if (typeof PhoneCallsUI !== 'undefined' && PhoneCallsUI.ringAudio) {
        PhoneCallsUI.ringAudio.volume = parseInt(e.target.value, 10) / 100;
      }
    });

    // Mic gain +/- buttons
    document.getElementById('mic-gain-down').addEventListener('click', () => {
      const val = Math.max(0, parseInt(micSlider.value, 10) - 5);
      micSlider.value = val;
      micSlider.dispatchEvent(new Event('input'));
    });
    document.getElementById('mic-gain-up').addEventListener('click', () => {
      const val = Math.min(200, parseInt(micSlider.value, 10) + 5);
      micSlider.value = val;
      micSlider.dispatchEvent(new Event('input'));
    });

    // Show/hide Chatterbox URL row on provider change
    document.getElementById('setting-tts-provider').addEventListener('change', (e) => {
      this.toggleChatterboxRow(e.target.value);
    });

    // Detect gateway host button
    document.getElementById('detect-host-btn').addEventListener('click', () => this.detectGatewayHost());

    // Close on overlay click
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) this.close();
    });
  },

  async open() {
    const settings = await window.simsigAPI.settings.getAll();
    this._savedTheme = settings.theme || 'light';
    this.populate(settings);
    if (window.simsigAPI.app && window.simsigAPI.app.getVersion) {
      window.simsigAPI.app.getVersion().then((v) => {
        document.getElementById('settings-version').textContent = 'Version - v' + v;
      });
    }
    await this.enumerateAudioDevices();
    // Hide browser overlay text while settings is open so it's not in the way
    const browserOverlay = document.getElementById('browser-overlay');
    if (browserOverlay && !browserOverlay.classList.contains('hidden')) {
      browserOverlay.classList.add('settings-open');
    }
    this.modal.classList.remove('hidden');

    // Start live mic meter
    this._startMicMeter();
  },

  async _startMicMeter() {
    if (typeof AudioPipeline === 'undefined') return;
    try {
      await AudioPipeline.startCapture();
      const barEl = document.getElementById('mic-meter-fill');
      const labelEl = document.getElementById('mic-meter-label');
      if (barEl && AudioPipeline.analyserNode) {
        AudioPipeline.startMeter(barEl);
        labelEl.textContent = 'Speak to test';
      } else {
        labelEl.textContent = 'No mic access';
      }
    } catch {
      const labelEl = document.getElementById('mic-meter-label');
      if (labelEl) labelEl.textContent = 'Mic error';
    }
  },

  _stopMicMeter() {
    if (typeof AudioPipeline !== 'undefined') {
      AudioPipeline.stopMeter();
      AudioPipeline.stopCapture();
    }
    const barEl = document.getElementById('mic-meter-fill');
    if (barEl) barEl.style.width = '0%';
  },

  close() {
    this.modal.classList.add('hidden');
    this._stopMicMeter();
    this.stopKeybindListen();
    // Revert dark mode preview if cancelled (not saved)
    if (this._savedTheme !== undefined) {
      document.body.classList.toggle('dark-mode', this._savedTheme === 'dark');
    }
    const browserOverlay = document.getElementById('browser-overlay');
    if (browserOverlay) browserOverlay.classList.remove('settings-open');
  },

  populate(settings) {
    document.getElementById('setting-host').value = settings.gateway?.host || 'localhost';
    document.getElementById('setting-port').value = settings.gateway?.port || 51515;
    document.getElementById('setting-initials').value = settings.signaller?.initials || '';
    document.getElementById(settings.audio?.muteSimsig ? 'setting-simsig-mute' : 'setting-simsig-keep').checked = true;
    document.getElementById('setting-username').value = settings.credentials?.username || '';
    document.getElementById('setting-password').value = settings.credentials?.password || '';
    document.getElementById('setting-ptt-keybind').value = settings.ptt?.keybind || 'ControlLeft';
    document.getElementById('setting-answer-keybind').value = settings.answerCall?.keybind || 'Space';
    document.getElementById('setting-hangup-keybind').value = settings.hangUp?.keybind || 'Space';
    const micVol = settings.audio?.micVolume ?? 50;
    const outVol = settings.audio?.outputVolume ?? 50;
    document.getElementById('setting-mic-volume').value = micVol;
    document.getElementById('mic-volume-val').textContent = micVol + '%';
    document.getElementById('setting-output-volume').value = outVol;
    document.getElementById('output-volume-val').textContent = outVol + '%';
    const ringVol = settings.audio?.ringVolume ?? 50;
    document.getElementById('setting-ring-volume').value = ringVol;
    document.getElementById('ring-volume-val').textContent = ringVol + '%';

    // TTS provider
    const providerSelect = document.getElementById('setting-tts-provider');
    const savedProvider = settings.tts?.provider || 'edge';
    // Migrate old elevenlabs setting to edge
    providerSelect.value = savedProvider === 'elevenlabs' ? 'edge' : savedProvider;
    document.getElementById('setting-tts-chatterbox-url').value = settings.tts?.chatterboxUrl || 'http://localhost:8099';
    this.toggleChatterboxRow(providerSelect.value);

    // Browser access
    document.getElementById('setting-web-enabled').checked = settings.web?.enabled || false;
    document.getElementById('setting-web-port').value = settings.web?.port || 3000;

    // Appearance
    const darkCheckbox = document.getElementById('setting-dark-mode');
    darkCheckbox.checked = settings.theme === 'dark';
    darkCheckbox.addEventListener('change', () => {
      document.body.classList.toggle('dark-mode', darkCheckbox.checked);
    });
  },

  async save() {
    const prevSettings = await window.simsigAPI.settings.getAll();
    const prevHost = prevSettings?.gateway?.host;
    const prevPort = prevSettings?.gateway?.port;
    const prevUsername = prevSettings?.credentials?.username || '';
    const prevPassword = prevSettings?.credentials?.password || '';

    const newHost = document.getElementById('setting-host').value;
    const newPort = parseInt(document.getElementById('setting-port').value, 10);
    await window.simsigAPI.settings.set('gateway.host', newHost);
    await window.simsigAPI.settings.set('gateway.port', newPort);
    const initials = document.getElementById('setting-initials').value.trim().toUpperCase();
    if (initials) await window.simsigAPI.settings.set('signaller.initials', initials);
    await window.simsigAPI.settings.set('audio.muteSimsig', document.getElementById('setting-simsig-mute').checked);
    await window.simsigAPI.settings.set('credentials.username', document.getElementById('setting-username').value);
    await window.simsigAPI.settings.set('credentials.password', document.getElementById('setting-password').value);

    const gatewayChanged = newHost !== prevHost || newPort !== prevPort;

    const inputSelect = document.getElementById('setting-audio-input');
    const outputSelect = document.getElementById('setting-audio-output');
    const ringSelect = document.getElementById('setting-ring-output');
    await window.simsigAPI.settings.set('audio.inputDeviceId', inputSelect.value);
    await window.simsigAPI.settings.set('audio.outputDeviceId', outputSelect.value);
    await window.simsigAPI.settings.set('audio.ringDeviceId', ringSelect.value);

    const micVolume = parseInt(document.getElementById('setting-mic-volume').value, 10);
    const outputVolume = parseInt(document.getElementById('setting-output-volume').value, 10);
    const ringVolume = parseInt(document.getElementById('setting-ring-volume').value, 10);
    await window.simsigAPI.settings.set('audio.micVolume', micVolume);
    await window.simsigAPI.settings.set('audio.outputVolume', outputVolume);
    await window.simsigAPI.settings.set('audio.ringVolume', ringVolume);
    if (typeof PhoneCallsUI !== 'undefined' && PhoneCallsUI.ringAudio) {
      PhoneCallsUI.ringAudio.volume = ringVolume / 100;
    }

    const keybind = document.getElementById('setting-ptt-keybind').value;
    await window.simsigAPI.settings.set('ptt.keybind', keybind);

    // Update PTT keybind in real-time (renderer + main process global hook)
    if (typeof PTTUI !== 'undefined') {
      PTTUI.keybind = keybind;
    }
    await window.simsigAPI.ptt.setKeybind(keybind);

    // Answer Call / Hang Up keybinds
    const answerKeybind = document.getElementById('setting-answer-keybind').value;
    const hangUpKeybind = document.getElementById('setting-hangup-keybind').value;
    await window.simsigAPI.settings.set('answerCall.keybind', answerKeybind);
    await window.simsigAPI.settings.set('hangUp.keybind', hangUpKeybind);
    await window.simsigAPI.keys.setAnswerCallKeybind(answerKeybind);
    await window.simsigAPI.keys.setHangUpKeybind(hangUpKeybind);

    // Update audio pipeline volumes in real-time
    if (typeof AudioPipeline !== 'undefined') {
      AudioPipeline.setMicVolume(micVolume);
      AudioPipeline.setOutputVolume(outputVolume);
    }

    // TTS provider settings
    const ttsProvider = document.getElementById('setting-tts-provider').value;
    await window.simsigAPI.settings.set('tts.provider', ttsProvider);
    await window.simsigAPI.settings.set('tts.chatterboxUrl', document.getElementById('setting-tts-chatterbox-url').value.trim());

    // Invalidate cached TTS voices so next speak uses the new provider
    if (typeof PhoneCallsUI !== 'undefined') {
      PhoneCallsUI.ttsVoices = null;
      PhoneCallsUI.voiceCache = {};
    }

    // Apply ring output device in real-time
    if (typeof PhoneCallsUI !== 'undefined') {
      PhoneCallsUI.setRingDevice(ringSelect.value);
    }

    // Browser access
    const webEnabled = document.getElementById('setting-web-enabled').checked;
    const webPort = parseInt(document.getElementById('setting-web-port').value, 10) || 3000;
    await window.simsigAPI.settings.set('web.enabled', webEnabled);
    await window.simsigAPI.settings.set('web.port', webPort);
    if (typeof PhoneCallsUI !== 'undefined') PhoneCallsUI._browserModeActive = webEnabled;

    if (window.simsigAPI.web) {
      const overlay = document.getElementById('browser-overlay');
      if (webEnabled) {
        const result = await window.simsigAPI.web.start(webPort);
        const urlSpan = document.getElementById('browser-overlay-url');
        urlSpan.textContent = `${result.ip || 'localhost'}:${webPort}`;
        overlay.classList.remove('hidden');
      } else {
        await window.simsigAPI.web.stop();
        overlay.classList.add('hidden');
      }
    }

    // Theme
    const theme = document.getElementById('setting-dark-mode').checked ? 'dark' : 'light';
    await window.simsigAPI.settings.set('theme', theme);
    document.body.classList.toggle('dark-mode', theme === 'dark');
    this._savedTheme = theme; // prevent close() from reverting

    // If gateway, credentials, or detect changed, force a disconnect and reconnect
    const newUsername = document.getElementById('setting-username').value;
    const newPassword = document.getElementById('setting-password').value;
    const credentialsChanged = newUsername !== prevUsername || newPassword !== prevPassword;
    if ((gatewayChanged || credentialsChanged || this._detectedHost) && window.simsigAPI.connection) {
      this._detectedHost = false;
      window.simsigAPI.connection.disconnect();
      setTimeout(() => window.simsigAPI.connection.connect(), 500);
    }

    this.close();
  },

  async enumerateAudioDevices() {
    const inputSelect = document.getElementById('setting-audio-input');
    const outputSelect = document.getElementById('setting-audio-output');
    const ringSelect = document.getElementById('setting-ring-output');

    inputSelect.innerHTML = '<option value="default">Default</option>';
    outputSelect.innerHTML = '<option value="default">Default</option>';
    ringSelect.innerHTML = '<option value="default">Default</option>';

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const settings = await window.simsigAPI.settings.getAll();

      devices.forEach((device) => {
        const label = device.label || `${device.kind} (${device.deviceId.substring(0, 8)}...)`;

        if (device.kind === 'audioinput') {
          const option = document.createElement('option');
          option.value = device.deviceId;
          option.textContent = label;
          if (device.deviceId === settings.audio?.inputDeviceId) option.selected = true;
          inputSelect.appendChild(option);
        } else if (device.kind === 'audiooutput') {
          const option = document.createElement('option');
          option.value = device.deviceId;
          option.textContent = label;
          if (device.deviceId === settings.audio?.outputDeviceId) option.selected = true;
          outputSelect.appendChild(option);

          const ringOption = document.createElement('option');
          ringOption.value = device.deviceId;
          ringOption.textContent = label;
          if (device.deviceId === settings.audio?.ringDeviceId) ringOption.selected = true;
          ringSelect.appendChild(ringOption);
        }
      });
    } catch (err) {
      console.warn('Could not enumerate audio devices:', err);
    }
  },

  startKeybindListen(btn) {
    // Stop any existing listen first
    this.stopKeybindListen();

    const targetId = btn.dataset.target;
    this._activeRebindBtn = btn;
    btn.textContent = 'Press any key...';
    btn.classList.add('listening');
    this.isListeningForKeybind = true;

    this._keybindHandler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      document.getElementById(targetId).value = e.code;
      this.stopKeybindListen();
    };

    document.addEventListener('keydown', this._keybindHandler, true);
  },

  toggleChatterboxRow(provider) {
    const status = document.getElementById('tts-chatterbox-status');
    if (provider === 'chatterbox') {
      this.checkChatterboxServer();
    } else {
      status.textContent = '';
      status.classList.add('hidden');
    }
  },

  async checkChatterboxServer() {
    const status = document.getElementById('tts-chatterbox-status');
    status.classList.remove('hidden');

    // Test by fetching voices — this already works via TTS_GET_VOICES
    try {
      const voices = await window.simsigAPI.tts.getVoices();
      if (voices && voices.length > 0) {
        status.className = 'status-ok';
        status.textContent = `Connected — ${voices.length} voices`;
      } else {
        status.className = 'status-error';
        status.textContent = 'Server not running';
      }
    } catch (e) {
      status.className = 'status-error';
      status.textContent = 'Server not running';
    }
  },

  async detectGatewayHost() {
    const btn = document.getElementById('detect-host-btn');
    const hostInput = document.getElementById('setting-host');
    const origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Detecting...';

    try {
      const result = await window.simsigAPI.settings.detectGatewayHost();
      if (result.error) {
        btn.textContent = 'Failed';
        console.warn('[Settings] Gateway detection error:', result.error);
      } else if (result.host) {
        hostInput.value = result.host;
        btn.textContent = result.type === 'server' ? 'Localhost' : result.host;
        this._detectedHost = true;
      }
    } catch (err) {
      btn.textContent = 'Error';
      console.error('[Settings] Gateway detection failed:', err);
    }

    setTimeout(() => {
      btn.textContent = origText;
      btn.disabled = false;
    }, 2000);
  },

  stopKeybindListen() {
    if (this._activeRebindBtn) {
      this._activeRebindBtn.textContent = 'Press to rebind...';
      this._activeRebindBtn.classList.remove('listening');
      this._activeRebindBtn = null;
    }
    this.isListeningForKeybind = false;

    if (this._keybindHandler) {
      document.removeEventListener('keydown', this._keybindHandler, true);
      this._keybindHandler = null;
    }
  },
};
