const ConnectionUI = {
  isConnected: false,
  indicator: null,
  statusText: null,
  connectBtn: null,
  _simCheckTimer: null,

  init() {
    this.indicator = document.getElementById('status-indicator');
    this.statusText = document.getElementById('status-text');
    this.connectBtn = document.getElementById('connect-btn');

    this.connectBtn.addEventListener('click', () => {
      const currentStatus = this.indicator.className;
      if (this.isConnected || currentStatus === 'no-gateway' || currentStatus === 'reconnecting') {
        this.showConfirm('Disconnect', 'Are you sure you want to disconnect?', () => {
          window.simsigAPI.connection.disconnect();
        });
      } else {
        this.promptInitials((initials) => {
          window.simsigAPI.settings.set('signaller.initials', initials);
          document.getElementById('panel-name-tab').dataset.initials = initials;
          window.simsigAPI.connection.connect();
          this.setStatus('connecting');
          const initOverlay = document.getElementById('init-overlay');
          if (initOverlay) initOverlay.classList.remove('hidden');
        });
      }
    });

    // Poll SimSig running state to enable/disable Connect button
    this._checkSimSigRunning();
    this._simCheckTimer = setInterval(() => this._checkSimSigRunning(), 5000);

    const fullscreenBtn = document.getElementById('fullscreen-btn');
    if (fullscreenBtn) {
      fullscreenBtn.addEventListener('click', () => {
        window.simsigAPI.window.toggleFullscreen();
      });
    }

    // Custom window controls (frameless window)
    const winMin = document.getElementById('win-minimize');
    const winMax = document.getElementById('win-maximize');
    const winClose = document.getElementById('win-close');
    if (winMin) winMin.addEventListener('click', () => window.simsigAPI.window.minimize());
    if (winMax) winMax.addEventListener('click', () => window.simsigAPI.window.maximize());
    if (winClose) winClose.addEventListener('click', () => window.simsigAPI.window.close());
  },

  async promptInitials(onConnect) {
    const modal = document.getElementById('initials-modal');
    const input = document.getElementById('initials-input');
    const okBtn = document.getElementById('initials-ok');
    const cancelBtn = document.getElementById('initials-cancel');

    // Pre-fill with last saved initials
    const saved = await window.simsigAPI.settings.get('signaller.initials');
    const resizeInput = () => {
      const len = Math.max(1, input.value.length || 1);
      input.style.width = (len * 1.2 + 0.6) + 'em';
    };
    if (saved) {
      input.value = saved;
    }
    resizeInput();
    input.addEventListener('input', resizeInput);

    modal.classList.remove('hidden');
    input.focus();
    input.select();

    const cleanup = () => {
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      input.removeEventListener('input', resizeInput);
    };
    const onOk = () => {
      const val = input.value.trim().toUpperCase();
      if (!val) { input.focus(); return; }
      cleanup();
      onConnect(val);
    };
    const onCancel = () => { cleanup(); };
    const onKey = (e) => { if (e.key === 'Enter') onOk(); if (e.key === 'Escape') onCancel(); };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
  },

  showConfirm(title, message, onYes) {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    modal.classList.remove('hidden');

    const yesBtn = document.getElementById('confirm-yes');
    const noBtn = document.getElementById('confirm-no');
    const onYesClick = () => { cleanup(); onYes(); };
    const onNoClick = () => { cleanup(); };
    const cleanup = () => {
      modal.classList.add('hidden');
      yesBtn.removeEventListener('click', onYesClick);
      noBtn.removeEventListener('click', onNoClick);
    };
    yesBtn.addEventListener('click', onYesClick, { once: true });
    noBtn.addEventListener('click', onNoClick, { once: true });
  },

  setStatus(status) {
    const statusStr = typeof status === 'object' ? status.status : status;

    this.indicator.className = statusStr;
    this.isConnected = statusStr === 'connected';

    // Toggle body-level disconnected state for global UI gating
    const active = statusStr === 'connected' || statusStr === 'no-gateway';
    document.body.classList.toggle('disconnected', !active);

    const labels = {
      disconnected: 'Disconnected',
      connecting: 'Connecting...',
      connected: 'Connected',
      reconnecting: 'Reconnecting...',
      'no-gateway': 'No Gateway',
      error: 'Error',
    };

    this.statusText.textContent = labels[statusStr] || statusStr;

    if (typeof status === 'object' && status.error) {
      this.statusText.textContent += `: ${status.error}`;
    }

    // Show hint next to No Gateway status text
    let hint = document.getElementById('no-gateway-hint');
    if (statusStr === 'no-gateway') {
      if (!hint) {
        hint = document.createElement('span');
        hint.id = 'no-gateway-hint';
        hint.textContent = '— Start Gateway or press Detect in Settings';
        this.statusText.parentNode.insertBefore(hint, this.statusText.nextSibling);
      }
      hint.style.display = '';
    } else if (hint) {
      hint.style.display = 'none';
    }

    // No-gateway keeps Disconnect available (PhoneReader is still running)
    this.connectBtn.textContent = (this.isConnected || statusStr === 'no-gateway') ? 'Disconnect' : 'Connect';

    // Clear init overlay once connection resolves (connected or no-gateway)
    if (statusStr === 'connected' || statusStr === 'no-gateway') {
      const initOverlay = document.getElementById('init-overlay');
      if (initOverlay) initOverlay.classList.add('hidden');
    }

    // Show/hide "No Gateway" messages on Trains and Log tabs
    const noGateway = statusStr === 'no-gateway' || statusStr === 'disconnected';
    const trainsNoGw = document.getElementById('trains-no-gateway');
    const feedNoGw = document.getElementById('feed-no-gateway');
    const trainsContent = document.getElementById('trains-table-wrapper');
    const noTrainsMsg = document.getElementById('no-trains-message');
    const feedContent = document.getElementById('feed-log');
    if (trainsNoGw) trainsNoGw.classList.toggle('hidden', !noGateway);
    if (feedNoGw) feedNoGw.classList.toggle('hidden', !noGateway);
    if (trainsContent) trainsContent.classList.toggle('hidden', noGateway);
    if (noTrainsMsg) noTrainsMsg.classList.toggle('hidden', noGateway);
    if (feedContent) feedContent.classList.toggle('hidden', noGateway);
  },

  async _checkSimSigRunning() {
    // Only check when disconnected — while connected, PhoneReader handles detection
    if (this.isConnected || this.indicator.className === 'connecting') return;
    try {
      const running = await window.simsigAPI.sim.isRunning();
      this.connectBtn.disabled = !running;
      if (!running && this.indicator.className === 'disconnected') {
        this.statusText.textContent = 'SimSig not running';
      }
    } catch {
      // Ignore errors in polling
    }
  },
};
