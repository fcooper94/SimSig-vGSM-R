const SetupWizard = {
  currentStep: 0,
  direction: 'forward',
  collectedSettings: {},

  steps: [
    { id: 'welcome', title: 'Welcome' },
    { id: 'simsig-audio', title: 'SimSig Audio' },
    { id: 'port-guide', title: 'Port Forwarding' },
    { id: 'initials', title: 'Your Initials' },
    { id: 'connection', title: 'SimSig Credentials' },
    { id: 'tts', title: 'Text-to-Speech' },
    { id: 'chatterbox-install', title: 'Installing Voice Engine', skip: true },
    // { id: 'browser', title: 'Browser Access' },  // Hidden from setup — available in Settings after first launch
    { id: 'complete', title: 'Complete' },
  ],

  async init() {
    this.container = document.getElementById('step-container');
    this.dotsEl = document.getElementById('step-dots');
    this.progressFill = document.getElementById('progress-fill');

    // Detect update mode from query string
    const params = new URLSearchParams(window.location.search);
    this.updateMode = params.get('mode') === 'update';

    if (this.updateMode) {
      const all = await window.setupAPI.settings.getAll();
      this.collectedSettings = {
        username: all.credentials?.username || '',
        password: all.credentials?.password || '',
        ttsProvider: all.tts?.provider || 'edge',
        webEnabled: all.web?.enabled || false,
        webPort: String(all.web?.port || '3000'),
      };
    }

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
      // Skip the install step if local Chatterbox was not selected
      if (this.steps[this.currentStep].id === 'chatterbox-install' && this.collectedSettings.ttsProvider !== 'chatterbox') {
        this.currentStep++;
      }
      this.renderStep(this.currentStep);
      this.updateProgress();
    }
  },

  prevStep() {
    const minStep = this.updateMode ? 2 : 0;
    if (this.currentStep <= minStep) return;
    if (this.currentStep > minStep) {
      this.direction = 'backward';
      this.currentStep--;
      // Skip the install step when going back
      if (this.steps[this.currentStep].id === 'chatterbox-install') {
        this.currentStep--;
      }
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
      case 'simsig-audio': {
        const selected = this.container.querySelector('.provider-option.selected');
        s.muteSimsig = selected ? selected.dataset.option === 'mute' : true;
        break;
      }
      case 'initials': {
        s.initials = (this.val('setup-initials') || '').toUpperCase();
        break;
      }
      case 'tts': {
        const selected = this.container.querySelector('.provider-option.selected');
        s.ttsProvider = selected ? selected.dataset.provider : 'edge';
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

    if (stepId === 'initials') {
      const initials = (this.val('setup-initials') || '').trim();
      if (!initials) {
        this._showValidationError('setup-initials', 'Please enter your initials (1-4 characters)');
        return false;
      }
    }

    if (stepId === 'connection') {
      const username = (this.val('setup-username') || '').trim();
      const password = (this.val('setup-password') || '').trim();
      if (!username && !password) {
        this._showValidationError('setup-username', 'Please enter your SimSig username and password');
        return false;
      }
      if (!username) {
        this._showValidationError('setup-username', 'Please enter your SimSig username');
        return false;
      }
      if (!password) {
        this._showValidationError('setup-password', 'Please enter your SimSig password');
        return false;
      }
    }

    if (stepId === 'tts') {
      const selected = this.container.querySelector('.provider-option.selected');
      const provider = selected ? selected.dataset.provider : 'edge';
      // No validation needed for Chatterbox (server check happens at runtime)
    }

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

  _showValidationError(inputId, message) {
    const input = document.getElementById(inputId);
    if (input) {
      input.focus();
      input.classList.add('invalid');
      input.addEventListener('input', () => {
        input.classList.remove('invalid');
        const err = input.parentElement.querySelector('.setup-validation-msg');
        if (err) err.remove();
      }, { once: true });
    }
    // Remove any existing error message
    const existing = input?.parentElement?.querySelector('.setup-validation-msg');
    if (existing) existing.remove();
    // Add error message below the input
    const msg = document.createElement('div');
    msg.className = 'setup-validation-msg';
    msg.textContent = message;
    if (input?.parentElement) input.parentElement.appendChild(msg);
  },

  async finish() {
    const s = this.collectedSettings;
    const payload = {
      'signaller.initials': s.initials || '',
      'audio.muteSimsig': s.muteSimsig === true,
      'credentials.username': s.username || '',
      'credentials.password': s.password || '',
      'tts.provider': s.ttsProvider || 'chatterbox',
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
    this.container.querySelectorAll('[data-action="keep"]').forEach((btn) => {
      btn.addEventListener('click', () => window.setupAPI.keepSettings());
    });
    this.container.querySelectorAll('[data-action="review"]').forEach((btn) => {
      btn.addEventListener('click', () => this.goToStep(2));
    });

    this.container.querySelectorAll('[data-action="skip-credentials"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.collectCurrentStepData();
        if (this.currentStep < this.steps.length - 1) {
          this.direction = 'forward';
          this.currentStep++;
          this.renderStep(this.currentStep);
          this.updateProgress();
        }
      });
    });

    // Step-specific bindings
    if (stepId === 'simsig-audio') {
      const options = this.container.querySelectorAll('.provider-option');
      options.forEach((opt) => {
        opt.addEventListener('click', () => {
          options.forEach((o) => o.classList.remove('selected'));
          opt.classList.add('selected');
          opt.querySelector('input[type="radio"]').checked = true;
        });
      });
    }
    if (stepId === 'initials') {
      const input = document.getElementById('setup-initials');
      if (input) {
        input.addEventListener('input', () => { input.value = input.value.toUpperCase(); });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.nextStep(); });
        input.focus();
      }
    }
    if (stepId === 'connection') {
      const usernameInput = document.getElementById('setup-username');
      const passwordInput = document.getElementById('setup-password');
      if (usernameInput) {
        usernameInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { passwordInput?.focus(); }
        });
        usernameInput.focus();
      }
      if (passwordInput) {
        passwordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.nextStep(); });
      }
    }
    if (stepId === 'chatterbox-install') {
      // Start install and listen for progress
      const detail = document.getElementById('setup-install-detail');
      const fill = document.getElementById('setup-install-fill');

      if (window.setupAPI?.tts?.onInstallProgress) {
        window.setupAPI.tts.onInstallProgress((data) => {
          if (detail) detail.textContent = data.detail || data.stage;
          if (fill) fill.style.width = data.percent + '%';
        });
      }

      if (window.setupAPI?.tts?.startInstall) {
        window.setupAPI.tts.startInstall().then((result) => {
          if (result && result.success) {
            if (detail) detail.textContent = 'Installation complete!';
            if (fill) fill.style.width = '100%';
            setTimeout(() => this.nextStep(), 1500);
          } else {
            if (detail) detail.textContent = 'Installation failed: ' + (result?.error || 'Unknown error') + '. You can change your TTS provider in Settings.';
            if (fill) fill.style.width = '0%';
            // Show a continue button so user isn't stuck
            const btnRow = document.createElement('div');
            btnRow.className = 'btn-row center';
            btnRow.innerHTML = '<button class="btn-primary" id="install-fail-continue">Continue</button>';
            this.container.querySelector('.step-card.active')?.appendChild(btnRow);
            document.getElementById('install-fail-continue')?.addEventListener('click', () => this.nextStep());
          }
        });
      }
    }
    if (stepId === 'tts') {
      this.bindTTSEvents();
    }
    if (stepId === 'browser') this.bindBrowserEvents();
  },

  bindTTSEvents() {
    const options = this.container.querySelectorAll('.provider-option');
    options.forEach((opt) => {
      opt.addEventListener('click', () => {
        if (opt.classList.contains('disabled')) return;
        options.forEach((o) => o.classList.remove('selected'));
        opt.classList.add('selected');
        opt.querySelector('input[type="radio"]').checked = true;
      });
    });

    // Check for GPU — disable Chatterbox if not available
    if (window.setupAPI?.tts?.checkGpu) {
      window.setupAPI.tts.checkGpu().then((gpu) => {
        const cbOption = this.container.querySelector('[data-provider="chatterbox"]');
        if (!cbOption) return;
        if (!gpu.hasGpu) {
          cbOption.classList.add('disabled');
          cbOption.style.opacity = '0.4';
          cbOption.style.pointerEvents = 'none';
          const desc = cbOption.querySelector('.provider-desc');
          if (desc) desc.innerHTML = 'Requires an NVIDIA GPU (GTX 1060 or better). No compatible GPU detected on this PC';
          const ribbon = cbOption.querySelector('.recommended-ribbon');
          if (ribbon) ribbon.style.display = 'none';
          // If Chatterbox was selected, switch to Edge
          if (cbOption.classList.contains('selected')) {
            cbOption.classList.remove('selected');
            const edgeOpt = this.container.querySelector('[data-provider="edge"]');
            if (edgeOpt) {
              edgeOpt.classList.add('selected');
              edgeOpt.querySelector('input[type="radio"]').checked = true;
            }
          }
        } else {
          const desc = cbOption.querySelector('.provider-desc');
          if (desc) desc.innerHTML = `Ultra-realistic cloned voices. Runs locally on your <strong>${gpu.gpuName}</strong>`;
        }
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

  // === Step Renderers ===

  render_welcome() {
    if (this.updateMode) {
      return `
        <img src="../../images/branding.png" class="setup-banner" alt="vGSM-R">
        <p class="welcome-tagline">vGSM-R has been updated</p>
        <p class="welcome-description">
          New settings may have been added. Would you like to review your settings,
          or keep your current configuration?
        </p>
        <div class="btn-row center stacked">
          <button class="btn-primary large" data-action="keep">Keep Settings</button>
          <button class="btn-ghost" data-action="review">Review Settings</button>
        </div>
      `;
    }
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

  render_simsig_audio() {
    const s = this.collectedSettings;
    const muteAll = s.muteSimsig === true; // default false (keep sounds)
    return `
        <div class="step-title">SimSig Audio</div>
        <div class="step-subtitle">
          vGSM-R provides its own audio for incoming calls and train alerts.
          Choose how to handle SimSig's built-in sounds:
        </div>
        <div class="provider-options">
          <div class="provider-option has-ribbon ${!muteAll ? 'selected' : ''}" data-option="keep">
            <div class="recommended-ribbon">Best</div>
            <input type="radio" name="simsig-audio" value="keep" ${!muteAll ? 'checked' : ''}>
            <div class="provider-radio"></div>
            <div class="provider-info">
              <div class="provider-name">Keep SimSig Sounds</div>
              <div class="provider-desc" style="line-height:1.8">
                Keep SimSig audio enabled, but untick <strong>Play Sound</strong> for:<br><br>
                &bull; <strong>Train Waiting at Red Signal</strong><br>
                &bull; <strong>General Telephone Message</strong><br><br>
                <span style="color:#777;font-size:11px">Found in SimSig &rarr; Options (F3) &rarr; Messages tab</span>
              </div>
            </div>
          </div>
          <div class="provider-option ${muteAll ? 'selected' : ''}" data-option="mute">
            <input type="radio" name="simsig-audio" value="mute" ${muteAll ? 'checked' : ''}>
            <div class="provider-radio"></div>
            <div class="provider-info">
              <div class="provider-name">Mute All SimSig Audio</div>
              <div class="provider-desc">Automatically mute all SimSig sounds. vGSM-R becomes the sole source for call notifications and train alerts. No manual setup needed.</div>
            </div>
          </div>
        </div>
        <div class="btn-row">
          <button class="btn-secondary" data-action="prev">Back</button>
          <button class="btn-primary" data-action="next">Next</button>
        </div>
    `;
  },

  render_simsig_settings() {
    return `
        <div class="step-title">SimSig Settings</div>
        <div class="step-subtitle">
          vGSM-R handles telephone calls and train alerts for you. To avoid duplicate sounds,
          please disable the following in SimSig:
        </div>
        <ol class="guide-steps">
          <li>
            <span class="guide-step-num">1</span>
            <span>In SimSig, press <strong style="color:#fff">F3</strong> to open <strong style="color:#fff">Options</strong></span>
          </li>
          <li>
            <span class="guide-step-num">2</span>
            <span>Go to the <strong style="color:#fff">Messages</strong> tab</span>
          </li>
          <li>
            <span class="guide-step-num">3</span>
            <span>Remove the sound for <strong style="color:#fff">Train Waiting at Red Signal</strong></span>
          </li>
          <li>
            <span class="guide-step-num">4</span>
            <span>Remove the sound for <strong style="color:#fff">General Telephone Message</strong></span>
          </li>
        </ol>
        <div class="setup-privacy-note">
          These sounds are replaced by vGSM-R's telephone ringing and alert system.
          You can restore them in SimSig at any time if you stop using vGSM-R.
        </div>
        <div class="btn-row center">
          <button class="btn-primary" data-action="next">Ok, I understand</button>
        </div>
    `;
  },

  render_port_guide() {
    return `
        <div class="step-title">Port Forwarding</div>
        <div class="step-subtitle">
          This step is only needed if you are <strong>hosting a multiplayer session</strong> and other players
          need to connect to your SimSig gateway over the internet.<br><br>
          If you are playing <strong>singleplayer</strong> or <strong>joining someone else's multiplayer session</strong>,
          you can skip this step.
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
          <button class="btn-secondary" data-action="prev">Back</button>
          <button class="btn-primary" data-action="next">Ok, I understand</button>
        </div>
    `;
  },

  render_initials() {
    const s = this.collectedSettings;
    return `
        <div class="step-title">Your Initials</div>
        <div class="step-subtitle">Enter the initials you use when starting or joining a SimSig session. This is used to identify your panel for telephone calling.</div>
        <div class="form-group" style="text-align:center;margin:30px 0">
          <input type="text" id="setup-initials" class="setup-input" maxlength="4"
                 value="${s.initials || ''}" placeholder="" autocomplete="off" spellcheck="false"
                 style="font-size:28px;text-align:center;width:5em;text-transform:uppercase;letter-spacing:0.1em">
        </div>
        <div class="btn-row">
          <button class="btn-secondary" data-action="prev">Back</button>
          <button class="btn-primary" data-action="next">Next</button>
        </div>
    `;
  },

  render_connection() {
    const s = this.collectedSettings;
    return `
      <div class="step-title">SimSig Credentials</div>
      <div class="step-subtitle">Enter your SimSig account credentials. These are used to connect to SimSig's data gateway for train and signalling information.</div>
      <div class="form-group">
        <label for="setup-username">Username</label>
        <input type="text" id="setup-username" class="setup-input"
               value="${s.username || ''}" placeholder="Your SimSig username" autocomplete="off">
      </div>
      <div class="form-group">
        <label for="setup-password">Password</label>
        <input type="password" id="setup-password" class="setup-input"
               value="${s.password || ''}" placeholder="Your SimSig password" autocomplete="off">
      </div>
      <div class="setup-privacy-note">
        Your credentials are stored locally on this PC only and your password is encrypted using Windows Data Protection. We do not send or store your data anywhere else.
      </div>
      <div class="btn-row">
        <button class="btn-secondary" data-action="prev">Back</button>
        <button class="btn-ghost" data-action="skip-credentials">Skip</button>
        <button class="btn-primary" data-action="next">Next</button>
      </div>
    `;
  },

  render_tts() {
    const s = this.collectedSettings;
    const provider = s.ttsProvider || 'chatterbox-cloud';
    const sel = (p) => provider === p ? 'selected' : '';
    const chk = (p) => provider === p ? 'checked' : '';
    return `
        <div class="step-title">Text-to-Speech</div>
        <div class="step-subtitle">vGSM-R uses AI to voice driver communications. Choose how to run the voice engine:</div>
        <div class="provider-options">
          <div class="provider-option has-ribbon ${sel('chatterbox-cloud')}" data-provider="chatterbox-cloud">
            <div class="recommended-ribbon">Best</div>
            <input type="radio" name="tts-provider" value="chatterbox-cloud" ${chk('chatterbox-cloud')}>
            <div class="provider-radio"></div>
            <div class="provider-info">
              <div class="provider-name">Online Voice Server</div>
              <div class="provider-desc">Ultra-realistic AI voices hosted online. Works on any PC, requires internet connection</div>
            </div>
            <span class="provider-badge badge-green">Excellent</span>
          </div>
          <div class="provider-option ${sel('chatterbox')}" data-provider="chatterbox">
            <input type="radio" name="tts-provider" value="chatterbox" ${chk('chatterbox')}>
            <div class="provider-radio"></div>
            <div class="provider-info">
              <div class="provider-name">Local Voice Server</div>
              <div class="provider-desc">Same AI voices, downloaded and run locally. Works offline, requires NVIDIA GPU (~4GB download)</div>
            </div>
            <span class="provider-badge badge-green">Excellent</span>
          </div>
          <div class="provider-option ${sel('edge')}" data-provider="edge">
            <input type="radio" name="tts-provider" value="edge" ${chk('edge')}>
            <div class="provider-radio"></div>
            <div class="provider-info">
              <div class="provider-name">Edge TTS</div>
              <div class="provider-desc">Microsoft neural voices. Requires internet, no setup needed</div>
            </div>
            <span class="provider-badge badge-amber">Ok Quality</span>
          </div>
          <div class="provider-option ${sel('windows')}" data-provider="windows">
            <input type="radio" name="tts-provider" value="windows" ${chk('windows')}>
            <div class="provider-radio"></div>
            <div class="provider-info">
              <div class="provider-name">Windows TTS</div>
              <div class="provider-desc">Built-in system voices. Works offline, no setup needed</div>
            </div>
            <span class="provider-badge badge-red">Basic</span>
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

  render_chatterbox_install() {
    return `
        <div class="step-title">Installing Voice Engine</div>
        <div class="step-subtitle">Downloading and setting up the AI voice engine. This is a one-time download of approximately 4GB.</div>
        <div style="margin:30px 0;text-align:center">
          <div id="setup-install-detail" style="font-size:13px;color:#aaa;margin-bottom:16px">Preparing...</div>
          <div style="height:8px;background:#222;border-radius:4px;overflow:hidden;max-width:400px;margin:0 auto">
            <div id="setup-install-fill" style="height:100%;background:var(--setup-accent);border-radius:4px;width:0%;transition:width 0.3s ease"></div>
          </div>
          <div style="font-size:11px;color:#666;margin-top:12px">Please do not close this window during installation.</div>
        </div>
    `;
  },

  render_complete() {
    const s = this.collectedSettings;
    const providerNames = { 'chatterbox-cloud': 'Online Voice Server', chatterbox: 'Local Voice Server', edge: 'Edge TTS', windows: 'Windows TTS' };
    const title = this.updateMode ? 'Settings Reviewed' : 'Setup Complete';
    const subtitle = this.updateMode
      ? 'Here\'s a summary of your updated configuration.'
      : 'Here\'s a summary of your configuration.';
    return `
        <img src="../../images/branding.png" class="setup-banner" style="max-width:200px" alt="vGSM-R">
        <div class="step-title" style="text-align:center">${title}</div>
        <div class="step-subtitle" style="text-align:center">${subtitle}</div>
        <ul class="summary-list">
          <li>
            <span class="summary-label">Initials</span>
            <span class="summary-value">${s.initials || 'Not set'}</span>
          </li>
          <li>
            <span class="summary-label">SimSig Account</span>
            <span class="summary-value">${s.username || 'Skipped'}</span>
          </li>
          <li>
            <span class="summary-label">SimSig Audio</span>
            <span class="summary-value">${s.muteSimsig ? 'Muted' : 'Keep sounds (manual setup)'}</span>
          </li>
          <li>
            <span class="summary-label">TTS Provider</span>
            <span class="summary-value">${providerNames[s.ttsProvider] || 'Edge TTS'}</span>
          </li>
        </ul>
        <div class="btn-row center stacked">
          <button class="btn-primary large" data-action="finish">Launch vGSM-R</button>
          <button class="btn-ghost" data-action="edit" data-step="2">Go back and edit</button>
        </div>
    `;
  },
};

document.addEventListener('DOMContentLoaded', () => SetupWizard.init());
