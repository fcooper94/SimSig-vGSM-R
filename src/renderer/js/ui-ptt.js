const PTTUI = {
  pttBtn: null,
  pttStatus: null,
  keybind: 'Space',
  isActive: false,

  async init() {
    this.pttBtn = document.getElementById('ptt-btn');
    this.pttStatus = document.getElementById('ptt-status');

    const settings = await window.simsigAPI.settings.getAll();
    this.keybind = settings.ptt?.keybind || 'Space';

    // Mouse hold-to-talk
    this.pttBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.activate();
    });

    this.pttBtn.addEventListener('mouseup', () => {
      this.deactivate();
    });

    this.pttBtn.addEventListener('mouseleave', () => {
      if (this.isActive) this.deactivate();
    });

    // Keyboard hold-to-talk
    document.addEventListener('keydown', (e) => {
      if (e.code === this.keybind && !e.repeat && !this.isActive) {
        // Don't trigger PTT when settings modal is open or keybind listening
        if (typeof SettingsUI !== 'undefined' && SettingsUI.isListeningForKeybind) return;
        if (typeof SettingsUI !== 'undefined' && !SettingsUI.modal.classList.contains('hidden')) return;

        e.preventDefault();
        this.activate();
      }
    });

    document.addEventListener('keyup', (e) => {
      if (e.code === this.keybind && this.isActive) {
        this.deactivate();
      }
    });
  },

  activate() {
    this.isActive = true;
    this.pttBtn.classList.add('active');
    this.pttStatus.textContent = 'PTT: ON';
    this.pttStatus.classList.add('active');

    if (typeof AudioPipeline !== 'undefined') {
      AudioPipeline.startCapture();
    }
  },

  deactivate() {
    this.isActive = false;
    this.pttBtn.classList.remove('active');
    this.pttStatus.textContent = 'PTT: OFF';
    this.pttStatus.classList.remove('active');

    if (typeof AudioPipeline !== 'undefined') {
      AudioPipeline.stopCapture();
    }
  },
};
