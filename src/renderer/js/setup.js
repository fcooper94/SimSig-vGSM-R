const SetupWizard = {
  currentStep: 0,
  direction: 'forward',
  collectedSettings: {},

  steps: [
    { id: 'welcome', title: 'Welcome' },
    { id: 'port-guide', title: 'Port Forwarding' },
    { id: 'connection', title: 'SimSig Credentials' },
    { id: 'tts', title: 'Text-to-Speech' },
    { id: 'browser', title: 'Browser Access' },
    { id: 'complete', title: 'Complete' },
  ],

  init() {
    this.container = document.getElementById('step-container');
    this.dotsEl = document.getElementById('step-dots');
    this.progressFill = document.getElementById('progress-fill');

    // Build step dots
    this.steps.forEach((_, i) => {
      const dot = document.createElement('div');
      dot.className = 'step-dot';
      dot.dataset.index = i;
      this.dotsEl.appendChild(dot);
    });

    this.renderStep(0);
    this.updateProgress();
  },

  updateProgress() {
    const pct = (this.currentStep / (this.steps.length - 1)) * 100;
    this.progressFill.style.width = pct + '%';

    this.dotsEl.querySelectorAll('.step-dot').forEach((dot, i) => {
      dot.classList.remove('active', 'completed');
      if (i === this.currentStep) dot.classList.add('active');
      else if (i < this.currentStep) dot.classList.add('completed');
    });
  },

  renderStep(index) {
    const existing = this.container.querySelector('.step-card');
    const stepId = this.steps[index].id;

    // Build new card
    const card = document.createElement('div');
    card.className = 'step-card';
    card.innerHTML = this['render_' + stepId.replace('-', '_')]();

    // Animate transition
    if (existing) {
      const exitClass = this.direction === 'forward' ? 'exit-left' : 'exit-right';
      const enterClass = this.direction === 'forward' ? 'enter-right' : 'enter-left';

      existing.classList.add(exitClass);
      card.classList.add(enterClass);
      this.container.appendChild(card);

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          card.classList.remove(enterClass);
          card.classList.add('active');
        });
      });

      setTimeout(() => existing.remove(), 300);
    } else {
      card.classList.add('active');
      this.container.appendChild(card);
    }

    // Bind events after DOM insertion
    requestAnimationFrame(() => this.bindStepEvents(stepId));
  },

  nextStep() {
    this.collectCurrentStepData();
    if (!this.validateCurrentStep()) return;

    if (this.currentStep < this.steps.length - 1) {
      this.direction = 'forward';
      this.currentStep++;
      this.renderStep(this.currentStep);
      this.updateProgress();
    }
  },

  prevStep() {
    if (this.currentStep > 0) {
      this.direction = 'backward';
      this.currentStep--;
      this.renderStep(this.currentStep);
      this.updateProgress();
    }
  },

  goToStep(index) {
    this.direction = index > this.currentStep ? 'forward' : 'backward';
    this.currentStep = index;
    this.renderStep(this.currentStep);
    this.updateProgress();
  },

  collectCurrentStepData() {
    const stepId = this.steps[this.currentStep].id;
    const s = this.collectedSettings;

    switch (stepId) {
      case 'connection': {
        s.username = this.val('setup-username') || '';
        s.password = this.val('setup-password') || '';
        break;
      }
      case 'tts': {
        const selected = this.container.querySelector('.provider-option.selected');
        s.ttsProvider = selected ? selected.dataset.provider : 'edge';
        s.elevenLabsApiKey = this.val('setup-api-key') || '';
        break;
      }
      case 'browser': {
        const checkbox = document.getElementById('setup-web-enabled');
        s.webEnabled = checkbox ? checkbox.checked : false;
        s.webPort = this.val('setup-web-port') || '3000';
        break;
      }
    }
  },

  validateCurrentStep() {
    const stepId = this.steps[this.currentStep].id;

    if (stepId === 'browser') {
      const checkbox = document.getElementById('setup-web-enabled');
      if (checkbox && checkbox.checked) {
        const portVal = parseInt(this.val('setup-web-port'), 10);
        const portInput = document.getElementById('setup-web-port');
        const portError = document.getElementById('web-port-error');

        if (isNaN(portVal) || portVal < 1024 || portVal > 65535) {
          portInput.classList.add('invalid');
          if (portError) portError.classList.add('visible');
          return false;
        }
        portInput.classList.remove('invalid');
        if (portError) portError.classList.remove('visible');
      }
    }

    return true;
  },

  val(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
  },

  async finish() {
    const s = this.collectedSettings;
    const payload = {
      'credentials.username': s.username || '',
      'credentials.password': s.password || '',
      'tts.provider': s.ttsProvider || 'edge',
      'tts.elevenLabsApiKey': s.elevenLabsApiKey || '',
      'web.enabled': !!s.webEnabled,
      'web.port': parseInt(s.webPort, 10) || 3000,
    };
    await window.setupAPI.complete(payload);
  },

  bindStepEvents(stepId) {
    // Navigation buttons
    this.container.querySelectorAll('[data-action="next"]').forEach((btn) => {
      btn.addEventListener('click', () => this.nextStep());
    });
    this.container.querySelectorAll('[data-action="prev"]').forEach((btn) => {
      btn.addEventListener('click', () => this.prevStep());
    });
    this.container.querySelectorAll('[data-action="finish"]').forEach((btn) => {
      btn.addEventListener('click', () => this.finish());
    });
    this.container.querySelectorAll('[data-action="edit"]').forEach((btn) => {
      btn.addEventListener('click', () => this.goToStep(parseInt(btn.dataset.step, 10)));
    });

    // Step-specific bindings
    if (stepId === 'tts') {
      this.bindTTSEvents();
      this.bindElevenLabsModal();
    }
    if (stepId === 'browser') this.bindBrowserEvents();
  },

  bindTTSEvents() {
    const options = this.container.querySelectorAll('.provider-option');
    const apiSection = document.getElementById('api-key-section');

    options.forEach((opt) => {
      opt.addEventListener('click', () => {
        options.forEach((o) => o.classList.remove('selected'));
        opt.classList.add('selected');
        opt.querySelector('input[type="radio"]').checked = true;

        if (apiSection) {
          if (opt.dataset.provider === 'elevenlabs') {
            apiSection.classList.add('visible');
          } else {
            apiSection.classList.remove('visible');
          }
        }
      });
    });

    // API key credit check
    const apiKeyInput = document.getElementById('setup-api-key');
    if (apiKeyInput) {
      let timer = null;
      apiKeyInput.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => this.checkCredits(), 600);
      });
    }
  },

  bindBrowserEvents() {
    const toggle = document.getElementById('setup-web-enabled');
    const portGroup = document.getElementById('web-port-group');
    const warning = document.getElementById('web-warning');
    if (toggle) {
      toggle.addEventListener('change', () => {
        if (portGroup) portGroup.classList.toggle('visible', toggle.checked);
        if (warning) warning.classList.toggle('visible', toggle.checked);
      });
    }
  },

  async checkCredits() {
    const status = document.getElementById('credit-status');
    const apiKey = this.val('setup-api-key');
    if (!status) return;

    if (!apiKey) {
      status.className = 'credit-status status-error';
      status.textContent = 'Enter an API key to use ElevenLabs voices';
      return;
    }

    status.className = 'credit-status status-loading';
    status.textContent = 'Checking credits...';

    const result = await window.setupAPI.tts.checkCredits(apiKey);
    if (result.error) {
      status.className = 'credit-status status-error';
      status.textContent = result.error === 'Invalid API key'
        ? 'Invalid API key'
        : `Error: ${result.error}`;
    } else if (result.remaining <= 0) {
      status.className = 'credit-status status-error';
      status.textContent = `No credits remaining (${result.total.toLocaleString()} used)`;
    } else if (result.remaining < 1000) {
      status.className = 'credit-status status-low';
      status.textContent = `Low: ${result.remaining.toLocaleString()} / ${result.total.toLocaleString()} chars`;
    } else {
      status.className = 'credit-status status-ok';
      status.textContent = `${result.remaining.toLocaleString()} / ${result.total.toLocaleString()} chars remaining`;
    }
  },

  bindElevenLabsModal() {
    const link = document.getElementById('elevenlabs-setup-link');
    if (!link) return;

    link.addEventListener('click', (e) => {
      e.stopPropagation(); // Don't trigger provider selection
      this.showElevenLabsModal();
    });
  },

  showElevenLabsModal() {
    const overlay = document.createElement('div');
    overlay.className = 'setup-modal-overlay';
    overlay.innerHTML = `
      <div class="setup-modal">
        <div class="modal-title">ElevenLabs Setup</div>
        <div class="modal-subtitle">Follow these steps to get your free API key.</div>
        <ol class="modal-steps">
          <li>
            <span class="modal-step-num">1</span>
            <span>Go to <strong style="color:#fff">elevenlabs.io</strong> and click <strong style="color:#fff">Sign Up</strong>. You can register with Google or create an account with your email.</span>
          </li>
          <li>
            <span class="modal-step-num">2</span>
            <span>Once logged in, click your profile icon in the bottom-left corner and select <strong style="color:#fff">API Keys</strong> from the menu.</span>
          </li>
          <li>
            <span class="modal-step-num">3</span>
            <span>Click <strong style="color:#fff">Create API Key</strong>, give it a name (e.g. "vGSM-R"), and copy the key.</span>
          </li>
          <li>
            <span class="modal-step-num">4</span>
            <span>Paste the API key into the field on this page and you're all set.</span>
          </li>
        </ol>
        <div class="modal-note">
          <strong>Free tier:</strong> ElevenLabs gives you <strong>10,000 characters per month</strong> for free.
          A typical driver message is around 50–80 characters, so you'll get roughly
          <strong>125–200 messages per month</strong> at no cost. For most SimSig sessions
          that's plenty — a busy 2–3 hour session might use 30–60 messages. You'd likely get
          through several full sessions before hitting the limit. If you need more, paid plans
          start at around $5/month for 30,000 characters.
        </div>
        <div class="btn-row center">
          <button class="btn-primary" id="modal-close-btn">Got it</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => overlay.classList.add('visible'));
    });

    const close = () => {
      overlay.classList.remove('visible');
      setTimeout(() => overlay.remove(), 200);
    };

    overlay.querySelector('#modal-close-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
  },

  // === Step Renderers ===

  render_welcome() {
    return `
      <img src="../../images/branding.png" class="setup-banner" alt="vGSM-R">
      <p class="welcome-tagline">Virtual Railway Communication for SimSig</p>
      <p class="welcome-description">
        This wizard will help you configure vGSM-R to work with your SimSig simulation.
        You can change these settings at any time.
      </p>
      <div class="btn-row center">
        <button class="btn-primary large" data-action="next">Get Started</button>
      </div>
    `;
  },

  render_port_guide() {
    return `
        <div class="step-title">Port Forwarding</div>
        <div class="step-subtitle">
          vGSM-R needs to connect to SimSig's gateway. You'll need to set up port forwarding
          on your router so the connection can reach the SimSig host.
        </div>
        <div class="guide-diagram">
          <div class="guide-box">vGSM-R</div>
          <div class="guide-arrow">
            <span>&#8594; TCP &#8594;</span>
            <span class="port">Port 51515</span>
          </div>
          <div class="guide-box">Router</div>
          <div class="guide-arrow">
            <span>&#8594;</span>
          </div>
          <div class="guide-box">SimSig</div>
        </div>
        <ol class="guide-steps">
          <li>
            <span class="guide-step-num">1</span>
            <span>Open your router's admin page (usually <strong style="color:#fff">192.168.1.1</strong> or <strong style="color:#fff">192.168.0.1</strong>)</span>
          </li>
          <li>
            <span class="guide-step-num">2</span>
            <span>Find the <strong style="color:#fff">Port Forwarding</strong> section</span>
          </li>
          <li>
            <span class="guide-step-num">3</span>
            <span>Add a new rule: forward <strong style="color:#fff">TCP port 51515</strong> to the IP address of the machine running SimSig</span>
          </li>
          <li>
            <span class="guide-step-num">4</span>
            <span>Save and apply the changes</span>
          </li>
        </ol>
        <div class="btn-row">
          <button class="btn-secondary" data-action="next">Skip for now</button>
          <button class="btn-primary" data-action="next">I've done this</button>
        </div>
    `;
  },

  render_connection() {
    const s = this.collectedSettings;
    return `
      <div class="step-title">SimSig Credentials</div>
      <div class="step-subtitle">For vGSM-R to work on paid panels, we require you to enter your SimSig credentials to authenticate with SimSig.</div>
      <div class="form-group">
        <label for="setup-username">Username</label>
        <input type="text" id="setup-username" class="setup-input"
               value="${s.username || ''}" placeholder="Your SimSig username">
      </div>
      <div class="form-group">
        <label for="setup-password">Password</label>
        <input type="password" id="setup-password" class="setup-input"
               value="${s.password || ''}" placeholder="Your SimSig password">
      </div>
      <div class="btn-row">
        <button class="btn-secondary" data-action="prev">Back</button>
        <button class="btn-primary" data-action="next">Next</button>
      </div>
    `;
  },

  render_tts() {
    const s = this.collectedSettings;
    const provider = s.ttsProvider || 'elevenlabs';
    const sel = (p) => provider === p ? 'selected' : '';
    const chk = (p) => provider === p ? 'checked' : '';
    return `
        <div class="step-title">Text-to-Speech</div>
        <div class="step-subtitle">vGSM-R uses text-to-speech to voice driver communications.</div>
        <div class="provider-options">
          <div class="provider-option has-ribbon ${sel('elevenlabs')}" data-provider="elevenlabs">
            <div class="recommended-ribbon">Recommended</div>
            <input type="radio" name="tts-provider" value="elevenlabs" ${chk('elevenlabs')}>
            <div class="provider-radio"></div>
            <div class="provider-info">
              <div class="provider-name">ElevenLabs</div>
              <div class="provider-desc">Ultra-realistic AI voices, requires API key</div>
              <div class="provider-link" id="elevenlabs-setup-link">Setup Instructions</div>
            </div>
            <span class="provider-badge badge-premium">Premium</span>
          </div>
          <div class="provider-option ${sel('edge')}" data-provider="edge">
            <input type="radio" name="tts-provider" value="edge" ${chk('edge')}>
            <div class="provider-radio"></div>
            <div class="provider-info">
              <div class="provider-name">Edge TTS</div>
              <div class="provider-desc">High quality voices, requires internet</div>
            </div>
            <span class="provider-badge badge-free">Free</span>
          </div>
          <div class="provider-option ${sel('windows')}" data-provider="windows">
            <input type="radio" name="tts-provider" value="windows" ${chk('windows')}>
            <div class="provider-radio"></div>
            <div class="provider-info">
              <div class="provider-name">Windows TTS</div>
              <div class="provider-desc">Built-in voices, works offline</div>
            </div>
            <span class="provider-badge badge-offline">Offline</span>
          </div>
        </div>
        <div id="api-key-section" class="api-key-section ${provider === 'elevenlabs' ? 'visible' : ''}">
          <div class="form-group">
            <label for="setup-api-key">ElevenLabs API Key</label>
            <input type="text" id="setup-api-key" class="setup-input"
                   value="${s.elevenLabsApiKey || ''}" placeholder="Enter your API key">
            <div id="credit-status" class="credit-status"></div>
          </div>
        </div>
        <div class="btn-row">
          <button class="btn-secondary" data-action="prev">Back</button>
          <button class="btn-primary" data-action="next">Next</button>
        </div>
    `;
  },

  render_browser() {
    const s = this.collectedSettings;
    const enabled = s.webEnabled || false;
    return `
      <div class="step-title">Browser Access</div>
      <div class="step-subtitle">Access vGSM-R from an iPad or other device on your local network.</div>
      <div class="toggle-row">
        <div>
          <div class="toggle-label">Enable Browser Access</div>
          <div class="toggle-description">Start a web server for remote connections</div>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" id="setup-web-enabled" ${enabled ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div id="web-warning" class="setup-warning ${enabled ? 'visible' : ''}">
        <strong>Note:</strong> Enabling browser access will disable the desktop interface.
        All interaction will happen through the browser on your remote device instead.
      </div>
      <div id="web-port-group" class="form-group setup-hidden ${enabled ? 'visible' : ''}"
        <label for="setup-web-port">Web Server Port</label>
        <input type="number" id="setup-web-port" class="setup-input"
               value="${s.webPort || '3000'}" min="1024" max="65535">
        <div id="web-port-error" class="validation-error">Port must be 1024-65535</div>
        <div class="form-hint">Accessible at http://&lt;your-ip&gt;:${s.webPort || '3000'} on your network</div>
      </div>
      <div class="btn-row">
        <button class="btn-secondary" data-action="prev">Back</button>
        <button class="btn-primary" data-action="next">Next</button>
      </div>
    `;
  },

  render_complete() {
    const s = this.collectedSettings;
    const providerNames = { edge: 'Edge TTS', elevenlabs: 'ElevenLabs', windows: 'Windows TTS' };
    return `
        <img src="../../images/branding.png" class="setup-banner" style="max-width:200px" alt="vGSM-R">
        <div class="step-title" style="text-align:center">Setup Complete</div>
        <div class="step-subtitle" style="text-align:center">Here's a summary of your configuration.</div>
        <ul class="summary-list">
          <li>
            <span class="summary-label">SimSig Account</span>
            <span class="summary-value">${s.username ? s.username : 'Not set'}</span>
          </li>
          <li>
            <span class="summary-label">TTS Provider</span>
            <span class="summary-value">${providerNames[s.ttsProvider] || 'Edge TTS'}</span>
          </li>
          <li>
            <span class="summary-label">Browser Access</span>
            <span class="summary-value">${s.webEnabled ? 'Port ' + (s.webPort || '3000') : 'Disabled'}</span>
          </li>
        </ul>
        <div class="btn-row center" style="flex-direction:column;gap:8px">
          <button class="btn-primary large" data-action="finish">Launch vGSM-R</button>
          <button class="btn-ghost" data-action="edit" data-step="2">Go back and edit</button>
        </div>
    `;
  },
};

document.addEventListener('DOMContentLoaded', () => SetupWizard.init());
