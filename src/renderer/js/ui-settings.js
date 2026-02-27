const SettingsUI = {
  modal: null,
  form: null,
  isListeningForKeybind: false,

  init() {
    this.modal = document.getElementById('settings-modal');
    this.form = document.getElementById('settings-form');

    document.getElementById('settings-btn').addEventListener('click', () => this.open());
    document.getElementById('settings-save').addEventListener('click', () => this.save());
    document.getElementById('settings-cancel').addEventListener('click', () => this.close());
    document.querySelectorAll('.rebind-btn').forEach((btn) => {
      btn.addEventListener('click', () => this.startKeybindListen(btn));
    });

    // Live volume percentage display
    document.getElementById('setting-mic-volume').addEventListener('input', (e) => {
      document.getElementById('mic-volume-val').textContent = e.target.value + '%';
    });
    document.getElementById('setting-output-volume').addEventListener('input', (e) => {
      document.getElementById('output-volume-val').textContent = e.target.value + '%';
    });

    // Show/hide ElevenLabs API key row and check credits on provider change
    document.getElementById('setting-tts-provider').addEventListener('change', (e) => {
      this.toggleApiKeyRow(e.target.value);
    });

    // Check credits when API key is changed (debounced)
    let apiKeyTimer = null;
    document.getElementById('setting-tts-apikey').addEventListener('input', () => {
      clearTimeout(apiKeyTimer);
      apiKeyTimer = setTimeout(() => this.checkElevenLabsCredits(), 500);
    });

    // Close on overlay click
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) this.close();
    });
  },

  async open() {
    const settings = await window.simsigAPI.settings.getAll();
    this.populate(settings);
    await this.enumerateAudioDevices();
    this.modal.classList.remove('hidden');
  },

  close() {
    this.modal.classList.add('hidden');
    this.stopKeybindListen();
  },

  populate(settings) {
    document.getElementById('setting-host').value = settings.gateway?.host || 'localhost';
    document.getElementById('setting-port').value = settings.gateway?.port || 51515;
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

    // TTS provider
    const providerSelect = document.getElementById('setting-tts-provider');
    providerSelect.value = settings.tts?.provider || 'edge';
    document.getElementById('setting-tts-apikey').value = settings.tts?.elevenLabsApiKey || '';
    this.toggleApiKeyRow(providerSelect.value);
  },

  async save() {
    await window.simsigAPI.settings.set('gateway.host', document.getElementById('setting-host').value);
    await window.simsigAPI.settings.set('gateway.port', parseInt(document.getElementById('setting-port').value, 10));
    await window.simsigAPI.settings.set('credentials.username', document.getElementById('setting-username').value);
    await window.simsigAPI.settings.set('credentials.password', document.getElementById('setting-password').value);

    const inputSelect = document.getElementById('setting-audio-input');
    const outputSelect = document.getElementById('setting-audio-output');
    await window.simsigAPI.settings.set('audio.inputDeviceId', inputSelect.value);
    await window.simsigAPI.settings.set('audio.outputDeviceId', outputSelect.value);

    const micVolume = parseInt(document.getElementById('setting-mic-volume').value, 10);
    const outputVolume = parseInt(document.getElementById('setting-output-volume').value, 10);
    await window.simsigAPI.settings.set('audio.micVolume', micVolume);
    await window.simsigAPI.settings.set('audio.outputVolume', outputVolume);

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
    await window.simsigAPI.settings.set('tts.elevenLabsApiKey', document.getElementById('setting-tts-apikey').value.trim());

    // Invalidate cached TTS voices so next speak uses the new provider
    if (typeof PhoneCallsUI !== 'undefined') {
      PhoneCallsUI.ttsVoices = null;
      PhoneCallsUI.voiceCache = {};
    }

    this.close();
  },

  async enumerateAudioDevices() {
    const inputSelect = document.getElementById('setting-audio-input');
    const outputSelect = document.getElementById('setting-audio-output');

    inputSelect.innerHTML = '<option value="default">Default</option>';
    outputSelect.innerHTML = '<option value="default">Default</option>';

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const settings = await window.simsigAPI.settings.getAll();

      devices.forEach((device) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `${device.kind} (${device.deviceId.substring(0, 8)}...)`;

        if (device.kind === 'audioinput') {
          if (device.deviceId === settings.audio?.inputDeviceId) option.selected = true;
          inputSelect.appendChild(option);
        } else if (device.kind === 'audiooutput') {
          if (device.deviceId === settings.audio?.outputDeviceId) option.selected = true;
          outputSelect.appendChild(option);
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

  toggleApiKeyRow(provider) {
    const input = document.getElementById('setting-tts-apikey');
    const status = document.getElementById('tts-credit-status');
    const isEL = provider === 'elevenlabs';
    input.disabled = !isEL;
    if (isEL) {
      this.checkElevenLabsCredits();
    } else {
      status.classList.add('hidden');
    }
  },

  async checkElevenLabsCredits() {
    const status = document.getElementById('tts-credit-status');
    const apiKey = document.getElementById('setting-tts-apikey').value.trim();
    if (!apiKey) {
      status.className = 'status-error';
      status.textContent = 'Enter an API key to use ElevenLabs voices';
      status.classList.remove('hidden');
      return;
    }

    status.className = 'status-loading';
    status.textContent = 'Checking credits...';
    status.classList.remove('hidden');

    const result = await window.simsigAPI.tts.checkCredits(apiKey);
    if (result.error) {
      status.className = 'status-error';
      status.textContent = result.error === 'Invalid API key'
        ? 'Invalid API key - please check and try again'
        : `Error: ${result.error}`;
    } else if (result.remaining <= 0) {
      status.className = 'status-error';
      status.textContent = `No credits remaining (${result.total.toLocaleString()} used). Please select another provider.`;
    } else if (result.remaining < 1000) {
      status.className = 'status-low';
      status.textContent = `Low credits: ${result.remaining.toLocaleString()} / ${result.total.toLocaleString()} characters remaining`;
    } else {
      status.className = 'status-ok';
      status.textContent = `${result.remaining.toLocaleString()} / ${result.total.toLocaleString()} characters remaining`;
    }
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
