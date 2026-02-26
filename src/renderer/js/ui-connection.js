const ConnectionUI = {
  isConnected: false,
  indicator: null,
  statusText: null,
  connectBtn: null,
  clockDisplay: null,

  // Clock interpolation state
  lastClockSeconds: 0,
  lastClockRealTime: 0,
  speedRatio: 1,
  paused: false,
  clockInterval: null,

  init() {
    this.indicator = document.getElementById('status-indicator');
    this.statusText = document.getElementById('status-text');
    this.connectBtn = document.getElementById('connect-btn');
    this.clockDisplay = document.getElementById('clock-display');

    this.connectBtn.addEventListener('click', () => {
      if (this.isConnected) {
        window.simsigAPI.connection.disconnect();
      } else {
        window.simsigAPI.connection.connect();
        this.setStatus('connecting');
        const initOverlay = document.getElementById('init-overlay');
        if (initOverlay) initOverlay.classList.remove('hidden');
      }
    });
  },

  setStatus(status) {
    const statusStr = typeof status === 'object' ? status.status : status;

    this.indicator.className = statusStr;
    this.isConnected = statusStr === 'connected';

    const labels = {
      disconnected: 'Disconnected',
      connecting: 'Connecting...',
      connected: 'Connected',
      reconnecting: 'Reconnecting...',
      error: 'Error',
    };

    this.statusText.textContent = labels[statusStr] || statusStr;

    if (typeof status === 'object' && status.error) {
      this.statusText.textContent += `: ${status.error}`;
    }

    this.connectBtn.textContent = this.isConnected ? 'Disconnect' : 'Connect';

    if (statusStr === 'disconnected' || statusStr === 'error') {
      this.clockDisplay.textContent = '--:--:--';
      this.stopClockTicker();
    }
  },

  handleClockUpdate(data) {
    ConnectionUI.lastClockSeconds = data.clockSeconds || 0;
    ConnectionUI.lastClockRealTime = Date.now();
    ConnectionUI.speedRatio = data.interval > 0 ? 500 / data.interval : 1;
    ConnectionUI.paused = data.paused || false;

    // Start the ticker if not already running
    if (!ConnectionUI.clockInterval) {
      ConnectionUI.startClockTicker();
    }

    // Immediate update
    ConnectionUI.updateClockDisplay();
  },

  startClockTicker() {
    this.clockInterval = setInterval(() => {
      ConnectionUI.updateClockDisplay();
    }, 200);
  },

  stopClockTicker() {
    if (this.clockInterval) {
      clearInterval(this.clockInterval);
      this.clockInterval = null;
    }
  },

  updateClockDisplay() {
    if (this.paused) {
      const formatted = TimeUtils.formatSecondsFromMidnight(this.lastClockSeconds);
      this.clockDisplay.textContent = formatted + ' (PAUSED)';
      return;
    }

    // Interpolate: game seconds = last known + (real elapsed * speed ratio)
    const realElapsed = (Date.now() - this.lastClockRealTime) / 1000;
    const gameSeconds = Math.floor(this.lastClockSeconds + (realElapsed * this.speedRatio));
    const formatted = TimeUtils.formatSecondsFromMidnight(gameSeconds);
    this.clockDisplay.textContent = formatted;
  },
};
