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
    document.getElementById('ptt-rebind-btn').addEventListener('click', () => this.startKeybindListen());

    // Live volume percentage display
    document.getElementById('setting-mic-volume').addEventListener('input', (e) => {
      document.getElementById('mic-volume-val').textContent = e.target.value + '%';
    });
    document.getElementById('setting-output-volume').addEventListener('input', (e) => {
      document.getElementById('output-volume-val').textContent = e.target.value + '%';
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
    document.getElementById('setting-ptt-keybind').value = settings.ptt?.keybind || 'Space';
    const micVol = settings.audio?.micVolume ?? 50;
    const outVol = settings.audio?.outputVolume ?? 50;
    document.getElementById('setting-mic-volume').value = micVol;
    document.getElementById('mic-volume-val').textContent = micVol + '%';
    document.getElementById('setting-output-volume').value = outVol;
    document.getElementById('output-volume-val').textContent = outVol + '%';
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

    // Update PTT keybind in real-time
    if (typeof PTTUI !== 'undefined') {
      PTTUI.keybind = keybind;
    }

    // Update audio pipeline volumes in real-time
    if (typeof AudioPipeline !== 'undefined') {
      AudioPipeline.setMicVolume(micVolume);
      AudioPipeline.setOutputVolume(outputVolume);
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

  startKeybindListen() {
    const btn = document.getElementById('ptt-rebind-btn');
    btn.textContent = 'Press any key...';
    btn.classList.add('listening');
    this.isListeningForKeybind = true;

    this._keybindHandler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      document.getElementById('setting-ptt-keybind').value = e.code;
      this.stopKeybindListen();
    };

    document.addEventListener('keydown', this._keybindHandler, true);
  },

  stopKeybindListen() {
    const btn = document.getElementById('ptt-rebind-btn');
    btn.textContent = 'Press to rebind...';
    btn.classList.remove('listening');
    this.isListeningForKeybind = false;

    if (this._keybindHandler) {
      document.removeEventListener('keydown', this._keybindHandler, true);
      this._keybindHandler = null;
    }
  },
};
