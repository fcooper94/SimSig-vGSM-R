const ConnectionUI = {
  isConnected: false,
  indicator: null,
  statusText: null,
  connectBtn: null,

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
        window.simsigAPI.connection.connect();
        this.setStatus('connecting');
        const initOverlay = document.getElementById('init-overlay');
        if (initOverlay) initOverlay.classList.remove('hidden');
      }
    });

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

    // Tooltip for no-gateway explaining what's unavailable
    this.statusText.title = statusStr === 'no-gateway'
      ? 'Train position data requires the Information Gateway'
      : '';

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
};
