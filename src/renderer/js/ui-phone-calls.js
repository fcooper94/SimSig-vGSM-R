const PhoneCallsUI = {
  listEl: null,
  countEl: null,
  chatEl: null,
  calls: [],
  messages: [],
  ringingAudio: null,
  wasRinging: false,
  inCall: false,
  gameTime: '',         // formatted game time from gateway (empty = no connection)
  voiceCache: {},       // caller → voice ID (Edge TTS) or local profile
  ttsVoices: null,   // cached list of voices from TTS provider
  trainSignalCache: {}, // headcode → last known signal ID

  // True when running in a browser (not Electron) — display-only mirror mode
  get _isBrowser() {
    return !!window.simsigAPI._isBrowser;
  },

  init() {
    this._callSeq = 0; // monotonic counter to detect stale async continuations
    this.initReady = false;
    this.listEl = document.getElementById('phone-calls-list');
    this.countEl = document.getElementById('phone-calls-count');
    this.chatEl = document.getElementById('chat-messages');
    this.notificationEl = document.getElementById('incoming-notification');
    this.notificationTrainEl = document.getElementById('notification-train');
    this.notificationSignalEl = document.getElementById('notification-signal');
    this.notificationAnswerBtn = document.getElementById('notification-answer-btn');
    this.noCallsEl = document.getElementById('no-calls-message');
    this.tabIncomingEl = document.getElementById('tab-incoming');
    this.silenceBtn = document.getElementById('silence-btn');
    this.silenced = false;

    // ── Compact mode notification mirror ─────────────────────────────
    const compactNotif = document.getElementById('compact-notification');
    if (compactNotif && this.notificationEl) {
      const compactTrain = document.getElementById('compact-notif-train');
      const compactAction = document.getElementById('compact-notif-action');
      const syncCompact = () => {
        if (this.notificationEl.classList.contains('hidden')) {
          compactNotif.classList.add('hidden');
          compactNotif.classList.remove('flashing', 'in-call');
        } else {
          compactNotif.classList.remove('hidden');
          compactNotif.classList.toggle('flashing', this.notificationEl.classList.contains('flashing'));
          compactNotif.classList.toggle('in-call', this.notificationEl.classList.contains('in-call'));
        }
        if (compactTrain) compactTrain.textContent = this.notificationTrainEl.textContent;
        if (compactAction && this.notificationAnswerBtn) compactAction.textContent = this.notificationAnswerBtn.textContent;
      };
      new MutationObserver(syncCompact).observe(this.notificationEl, {
        attributes: true, attributeFilter: ['class'],
        childList: true, subtree: true, characterData: true,
      });
    }

    // ── Browser mirror mode ──────────────────────────────────────────
    // Browser is display-only: no audio, no local call flow.
    // It receives chat/notification state from the host and forwards clicks.
    if (this._isBrowser) {
      // Receive chat state from host
      window.simsigAPI.phone.onChatSync((state) => {
        this.messages = state.messages || [];
        this.inCall = state.inCall || false;
        this._activeCallTrain = state.activeCallTrain || '';
        this._outgoingCall = state.outgoingCall || false;
        this.currentHeadCode = state.currentHeadCode || '';
        this.currentSignalId = state.currentSignalId || '';
        this.isShunterCall = state.isShunterCall || false;
        this.isSignallerCall = state.isSignallerCall || false;
        this.isThirdPartyCall = state.isThirdPartyCall || false;
        this.renderChat();
        this.renderCalls(); // re-render call list so In Call badge matches
        if (state.notification) this._applyNotification(state.notification);
        // Sync silence button visibility
        if (this.silenceBtn) {
          this.silenceBtn.classList.toggle('hidden', !state.silenceBtnVisible);
        }
        // Update radio display
        const radioDisplay = document.getElementById('radio-display');
        const line1 = document.getElementById('display-line-1');
        const line2 = document.getElementById('display-line-2');
        if (radioDisplay) radioDisplay.classList.toggle('in-call', this.inCall || this._outgoingCall);
        if (line1) line1.textContent = (this.inCall || this._outgoingCall) ? 'In Call' : 'Ready';
        if (line2) line2.textContent = state.activeCallTrain || '';
      });

      // Forward reply clicks to host
      this.chatEl.addEventListener('click', (e) => {
        const chip = e.target.closest('.wait-time-choice');
        if (chip) {
          window.simsigAPI.phone.remoteAction({ type: 'reply', replyIndex: parseInt(chip.dataset.index, 10) });
          return;
        }
        const li = e.target.closest('.reply-options-list li');
        if (li) {
          const idx = parseInt(li.dataset.replyIndex, 10);
          if (idx < 0) return; // wait row — use time chips
          window.simsigAPI.phone.remoteAction({ type: 'reply', replyIndex: idx });
        }
      });

      // Notification click — forward answer/hangup to host
      this.notificationEl.addEventListener('click', () => {
        if (this.inCall || this._outgoingCall) {
          window.simsigAPI.phone.remoteAction({ type: 'hangup' });
        } else if (this.calls.length > 0) {
          window.simsigAPI.phone.remoteAction({ type: 'answer' });
        }
      });

      // Silence button — still forward to host
      this.silenceBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.simsigAPI.phone.silenceRing();
      });

      // No audio, TTS, or keybind setup on browser
      this.renderChat();
      return; // Skip all host-only init below
    }

    // ── Host mode (Electron) ─────────────────────────────────────────

    this.ringingAudio = new Audio('../../sounds/ringing.wav');
    this.ringingAudio.loop = true;

    // Apply saved ring output device
    window.simsigAPI.settings.getAll().then((s) => {
      if (s.audio?.ringDeviceId && s.audio.ringDeviceId !== 'default') {
        this.setRingDevice(s.audio.ringDeviceId);
      }
    });

    // Silence ring for this call only — broadcast to all clients
    this.silenceBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.simsigAPI.phone.silenceRing();
    });

    // Listen for silence events (from this client or remote clients)
    window.simsigAPI.phone.onSilenceRing(() => {
      this.silenced = true;
      this.ringingAudio.pause();
      this.ringingAudio.currentTime = 0;
      this.silenceBtn.classList.add('hidden');
      this._syncToRemote();
    });

    // Listen for call-answered from another client — stop ringing
    window.simsigAPI.phone.onCallAnswered((train) => {
      if (this.inCall) return; // this client answered, already handled
      this.stopRinging();
      this._activeCallTrain = train || '';
      this.renderCalls();
      this.hideNotification();
    });

    // Listen for remote actions from the browser (answer/reply/hangup)
    window.simsigAPI.phone.onRemoteAction((action) => {
      if (action.type === 'answer' && !this.inCall && !this._outgoingCall && this.calls.length > 0) {
        this.answerCall(action.index != null ? action.index : this.calls.length - 1);
      } else if (action.type === 'reply' && this.inCall && !this._replySent && !this._replyClicked) {
        this._replyClicked = true;
        if (this._isOkOnly) {
          this.sendOkAndHangUp(this._replyCaller || this._activeCallVoiceKey || '');
        } else if (this._replyReplies) {
          this.sendReply(action.replyIndex, this._replyReplies, this._replyCaller);
        }
      } else if (action.type === 'reply' && this._outgoingCall && !this._outgoingReplySent) {
        this._outgoingReplySent = true;
        if (this._outgoingReplies) {
          this.sendOutgoingReply(action.replyIndex, this._outgoingReplies, this._outgoingContactName);
        }
      } else if (action.type === 'hangup') {
        if (this._dialingActive) {
          this.stopDialing();
          this.addMessage({ type: 'system', text: 'Call cancelled' });
          this._resumeIncoming();
          return;
        }
        if (this._outgoingCall) {
          if (this._outgoingReplies && this._outgoingReplies.length > 0 && !this._outgoingReplySent) return;
          this.endOutgoingCall();
        } else if (this.inCall) {
          if (this._hasReplyOptions && !this._replySent) return;
          if (this._hangUpLocked) return;
          this.hangUp();
        }
      } else if (action.type === 'dial' && ConnectionUI.isConnected && !this.inCall && !this._outgoingCall && !this._dialingActive) {
        // Browser requested a phonebook dial — run the full flow on the host
        this._handleRemoteDial(action.index, action.name);
      }
    });

    // Click the notification box to answer the latest call or end the current call
    this.notificationEl.addEventListener('click', () => {
      if (this._dialingActive) {
        this.stopDialing();
        window.simsigAPI.phone.placeCallHangup();
        this.addMessage({ type: 'system', text: 'Call cancelled' });
        this._resumeIncoming();
        return;
      }
      if (this._outgoingCall) {
        if (this._outgoingReplies && this._outgoingReplies.length > 0 && !this._outgoingReplySent) return;
        this.endOutgoingCall();
      } else if (this.inCall) {
        if (this._hasReplyOptions && !this._replySent) return; // must reply first
        if (this._hangUpLocked) return; // reply/goodbye still in progress
        this.hangUp();
      } else if (this.calls.length > 0) {
        this.answerCall(this.calls.length - 1);
      }
    });

    // Prevent PTT / Answer / HangUp keys from triggering button clicks on notification elements
    this.notificationEl.addEventListener('keydown', (e) => {
      if (typeof PTTUI !== 'undefined' && e.code === PTTUI.keybind) e.preventDefault();
      // Space (default answer/hangup keybind) would trigger a click on focused buttons — block it
      if (e.code === 'Space') e.preventDefault();
    });

    // Global keybind: Answer Call
    window.simsigAPI.keys.onAnswerCall(() => {
      if (typeof SettingsUI !== 'undefined' && SettingsUI.isListeningForKeybind) return;
      if (typeof SettingsUI !== 'undefined' && !SettingsUI.modal.classList.contains('hidden')) return;
      if (!this.inCall && !this._outgoingCall && this.calls.length > 0 && !this._dialingActive) {
        this.answerCall(this.calls.length - 1);
      }
    });

    // Global keybind: Hang Up
    window.simsigAPI.keys.onHangUp(() => {
      if (typeof SettingsUI !== 'undefined' && SettingsUI.isListeningForKeybind) return;
      if (typeof SettingsUI !== 'undefined' && !SettingsUI.modal.classList.contains('hidden')) return;
      if (this._dialingActive) {
        this.stopDialing();
        window.simsigAPI.phone.placeCallHangup();
        this.addMessage({ type: 'system', text: 'Call cancelled' });
        this._resumeIncoming();
        return;
      }
      if (this._outgoingCall) {
        if (this._outgoingReplies && this._outgoingReplies.length > 0 && !this._outgoingReplySent) return;
        this.endOutgoingCall();
      } else if (this.inCall) {
        if (this._hasReplyOptions && !this._replySent) return;
        if (this._hangUpLocked) return; // reply/goodbye still in progress
        this.hangUp();
      }
    });

    // Gapless background noise via Web Audio API — alternate between two clips
    this.bgCtx = new AudioContext();
    this.bgBuffers = [];
    this.bgBufferIndex = 0;
    this.bgSignallerBuffer = null;
    this.bgYardBuffer = null;
    this.bgSource = null;
    this.bgCallerType = 'train'; // 'train' | 'signaller' | 'yard'
    this.bgGain = this.bgCtx.createGain();
    this.bgGain.connect(this.bgCtx.destination);
    this.bgGain.gain.value = 0.5;
    const bgFiles = ['../../sounds/background.wav', '../../sounds/background2.wav'];
    Promise.all(bgFiles.map((f) =>
      fetch(f).then((r) => r.arrayBuffer()).then((buf) => this.bgCtx.decodeAudioData(buf))
    )).then((buffers) => { this.bgBuffers = buffers; }).catch(() => {});
    fetch('../../sounds/signaller-background.wav')
      .then((r) => r.arrayBuffer())
      .then((buf) => this.bgCtx.decodeAudioData(buf))
      .then((buffer) => { this.bgSignallerBuffer = buffer; })
      .catch(() => {});
    fetch('../../sounds/yard-background.wav')
      .then((r) => r.arrayBuffer())
      .then((buf) => this.bgCtx.decodeAudioData(buf))
      .then((buffer) => { this.bgYardBuffer = buffer; })
      .catch(() => {});

    // Pre-warm local voices as fallback
    speechSynthesis.getVoices();
    speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();

    // Pre-fetch TTS voices so first TTS is instant (skipped for Windows TTS)
    this.getTTSVoices();

    this.renderChat();
  },

  update(calls) {
    this.calls = calls || [];

    // Keep the active call in the list even if SimSig removed it
    if (this.inCall && this._activeCallTrain) {
      const stillInList = this.calls.some((c) => c.train === this._activeCallTrain);
      if (!stillInList) {
        this.calls.unshift({ train: this._activeCallTrain, status: 'In Call' });
      }
    }

    // Browser: don't ring — host handles all audio
    if (this._isBrowser) {
      this.renderCalls();
      return;
    }

    if (this.calls.length > 0 && !this.wasRinging && !this.inCall && !this._outgoingCall && !this._dialingActive) {
      this.startRinging();
    }

    if (this.calls.length === 0 && this.wasRinging) {
      this.stopRinging();
    }

    this.renderCalls();
  },

  isPaused() {
    return !document.getElementById('paused-overlay').classList.contains('hidden');
  },

  startRinging() {
    if (this._isBrowser) return; // no audio on browser
    this.wasRinging = true;
    this.silenced = false;
    this.silenceBtn.classList.remove('hidden');
    this._syncToRemote();
    if (this.isPaused() || !this.initReady) return;
    this.ringingAudio.currentTime = 0;
    this.ringingAudio.play().catch(() => {});
  },

  stopRinging() {
    if (this._isBrowser) return; // no audio on browser
    this.wasRinging = false;
    this.silenced = false;
    this.silenceBtn.classList.add('hidden');
    this._syncToRemote();
    this.ringingAudio.pause();
    this.ringingAudio.currentTime = 0;
  },

  setRingDevice(deviceId) {
    if (this.ringingAudio && this.ringingAudio.setSinkId) {
      this.ringingAudio.setSinkId(deviceId || 'default').catch((e) => {
        console.warn('[Phone] Could not set ring output device:', e.message);
      });
    }
  },

  // Silence all audio immediately (called when sim pauses)
  muteAll() {
    if (this._isBrowser) return; // no audio on browser
    this.ringingAudio.pause();
    this.ringingAudio.currentTime = 0;
  },

  // Resume ringing if calls are waiting (called when sim unpauses)
  resumeRinging() {
    if (this._isBrowser) return; // no audio on browser
    if (this.calls.length > 0 && this.wasRinging && !this.inCall && !this._outgoingCall && !this._dialingActive && !this.silenced) {
      this.ringingAudio.currentTime = 0;
      this.ringingAudio.play().catch(() => {});
    }
  },

  extractPosition(title) {
    const match = (title || '').match(/\(([^)]+)\)\s*$/);
    return match ? match[1] : '';
  },

  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  },

  // NATO phonetic alphabet + digits spoken individually
  NATO: {
    A: 'Alpha', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo',
    F: 'Foxtrot', G: 'Golf', H: 'Hotel', I: 'India', J: 'Juliet',
    K: 'Kilo', L: 'Leema', M: 'Mike', N: 'November', O: 'Oscar',
    P: 'Papa', Q: 'Quebec', R: 'Romeo', S: 'Sierra', T: 'Tango',
    U: 'Uniform', V: 'Victor', W: 'Whiskey', X: 'X-ray', Y: 'Yankee',
    Z: 'Zulu',
    0: 'Zero', 1: 'One', 2: 'Two', 3: 'Three', 4: 'Four',
    5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Niner',
  },

  // Convert headcodes (1A40), signal IDs (UM24, S14), and standalone
  // digit groups into phonetic speech
  phoneticize(text) {
    return text.replace(/\b[A-Z0-9]{2,}\b/gi, (match) => {
      const hasLetter = /[A-Za-z]/.test(match);
      const hasDigit = /\d/.test(match);
      // Mixed alphanumeric — always phoneticize (headcodes, signal IDs)
      if (hasLetter && hasDigit) {
        return match.split('').map((ch) => this.NATO[ch.toUpperCase()] || ch).join(' ');
      }
      // Pure digit groups (2+ digits) — speak individually
      if (hasDigit && !hasLetter) {
        return match.split('').map((ch) => this.NATO[ch] || ch).join(' ');
      }
      return match;
    });
  },

  // Fetch TTS voices (cached). Returns null for Windows TTS provider.
  async getTTSVoices() {
    if (this.ttsVoices) return this.ttsVoices;
    try {
      const result = await window.simsigAPI.tts.getVoices();
      // Windows TTS provider returns a sentinel — renderer handles it locally
      if (result && result.provider === 'windows') return null;
      this.ttsVoices = result && result.length > 0 ? result : null;
      return this.ttsVoices;
    } catch {
      return null;
    }
  },

  // Pick a consistent TTS voice for a caller (90% male, 10% female)
  getTTSVoiceId(caller, voices) {
    if (this.voiceCache[caller]) return this.voiceCache[caller];
    const hash = this.hashString(caller);
    const males = voices.filter((v) => v.gender === 'male');
    const females = voices.filter((v) => v.gender !== 'male');
    let voice;
    if (males.length && females.length) {
      // Use hash to deterministically assign ~90% male
      const useMale = (hash % 10) < 9;
      const pool = useMale ? males : females;
      voice = pool[hash % pool.length];
    } else {
      voice = voices[hash % voices.length];
    }
    this.voiceCache[caller] = voice.id;
    return voice.id;
  },

  // Fetch TTS audio from provider (returns audioData bytes, does NOT play)
  async fetchTTSAudio(text, voiceId) {
    const audioData = await window.simsigAPI.tts.speak(text, voiceId);
    return audioData || null;
  },

  // Start background noise (cab for trains, office for signallers, yard for shunters/CSD)
  startBgNoise() {
    if (!this.bgCtx) return; // no audio context on browser
    let buffer;
    if (this.bgCallerType === 'yard' && this.bgYardBuffer) {
      buffer = this.bgYardBuffer;
    } else if (this.bgCallerType === 'signaller' && this.bgSignallerBuffer) {
      buffer = this.bgSignallerBuffer;
    } else if (this.bgBuffers.length) {
      buffer = this.bgBuffers[this.bgBufferIndex % this.bgBuffers.length];
      this.bgBufferIndex++;
    } else {
      return;
    }
    if (this.bgSource) { try { this.bgSource.stop(); } catch {} }
    this.bgGain.gain.cancelScheduledValues(this.bgCtx.currentTime);
    this.bgGain.gain.value = 0.5;
    const source = this.bgCtx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(this.bgGain);
    source.start();
    this.bgSource = source;
  },

  // Fade out and stop cab background noise
  stopBgNoise() {
    if (!this.bgSource || !this.bgCtx) return;
    const now = this.bgCtx.currentTime;
    this.bgGain.gain.setValueAtTime(this.bgGain.gain.value, now);
    this.bgGain.gain.linearRampToValueAtTime(0, now + 0.5);
    const src = this.bgSource;
    this.bgSource = null;
    setTimeout(() => { try { src.stop(); } catch {} }, 600);
  },

  // Play pre-fetched audio data
  playAudioData(audioData) {
    if (!audioData) return Promise.resolve(false);
    return new Promise((resolve) => {
      const blob = new Blob([new Uint8Array(audioData)], { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this._currentAudio = audio;
      audio.onended = () => { this._currentAudio = null; URL.revokeObjectURL(url); resolve(true); };
      audio.onerror = () => { this._currentAudio = null; URL.revokeObjectURL(url); resolve(false); };
      audio.play().catch(() => { this._currentAudio = null; resolve(false); });
    });
  },

  // Speak via Edge TTS (main process handles the synthesis)
  async speakTTS(text, voiceId) {
    const audioData = await this.fetchTTSAudio(text, voiceId);
    return this.playAudioData(audioData);
  },

  // Fallback: local browser TTS with varied voice
  speakLocal(text, caller) {
    return new Promise((resolve) => {
      const voices = speechSynthesis.getVoices();
      const gbVoices = voices.filter((v) => v.lang.startsWith('en-GB'));
      // Prefer newer "Online" neural voices over legacy SAPI5 voices
      const onlineVoices = gbVoices.filter((v) => v.name.includes('Online'));
      const pool = onlineVoices.length > 0 ? onlineVoices
        : gbVoices.length > 0 ? gbVoices
        : voices;
      const hash = this.hashString(caller);

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'en-GB';
      utterance.voice = pool[hash % pool.length] || null;
      utterance.pitch = 0.7 + ((hash >> 4) % 100) / 100 * 0.6;
      utterance.rate = 2.0 + ((hash >> 8) % 100) / 100 * 0.3;

      utterance.onend = () => { resolve(); };
      utterance.onerror = () => { resolve(); };
      speechSynthesis.speak(utterance);
    });
  },

  // Stop any currently playing TTS (Edge TTS audio or browser speech)
  stopTTS() {
    if (this._currentAudio) {
      this._currentAudio.pause();
      this._currentAudio.currentTime = 0;
      this._currentAudio = null;
    }
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  },

  // Parse CSD (Carriage Sidings) entry permission messages
  parseCsdMessage(msg) {
    // "5A20 is ready at entry point Farnham CSD (WK440), scheduled 07:16."
    const entryMatch = msg.match(/(\w+)\s+is ready at entry point\s+(.+?)\s*\((\w+)\)/i);
    if (!entryMatch) return null;

    const headcode = entryMatch[1];
    const entryPoint = entryMatch[2].trim();
    const signal = entryMatch[3];

    // Route line: "07+17 Farnham CSD - Farnham (SWR 12 450)"
    const routeMatch = msg.match(/\d{2}\+\d{2}\s+.+?\s*-\s*(.+?)\s*\(/);
    const nextStop = routeMatch ? routeMatch[1].trim() : '';

    // Platform from timetable detail line: "Farnham 07:25    07:25    1"
    let platform = '';
    for (const line of msg.split('\n')) {
      const platMatch = line.match(/\d{2}:\d{2}\s+\d{2}:\d{2}\s+(\d+)/);
      if (platMatch) { platform = platMatch[1]; break; }
    }

    return { headcode, entryPoint, signal, nextStop, platform };
  },

  // Add "the" before Up/Down signal names, but not standard codes like "23" or "WK203"
  signalArticle(signal) {
    if (/^(up|down)\b/i.test(signal)) return `the ${signal}`;
    return signal;
  },

  // Build spoken message for CSD entry permission calls
  buildCsdSpokenMessage(panelName, position, csd, caller) {
    const isShunter = caller && /shunter/i.test(caller);
    const sigRef = `${this.signalArticle(csd.signal)} signal`;
    if (isShunter) {
      let msg = `Hello, ${panelName} Signaller, this is the Shunter within ${csd.entryPoint}. I have ${csd.headcode} at ${sigRef}. Request permission to enter`;
      if (csd.nextStop) {
        msg += `. Their next stop will be ${csd.nextStop}`;
        if (csd.platform) msg += ` Platform ${csd.platform}`;
      }
      return msg;
    }
    const posStr = position ? `, ${position}` : '';
    let msg = `Hello, ${panelName} Signaller${posStr}, this is driver of ${csd.headcode} at ${sigRef} within ${csd.entryPoint}. Request permission to enter`;
    if (csd.nextStop) {
      msg += `, next stop will be ${csd.nextStop}`;
      if (csd.platform) msg += ` Platform ${csd.platform}`;
    }
    return msg;
  },

  // Shorten a caller name to at most 4 words, stripping parenthesised suffixes
  shortenCaller(name) {
    const short = name.replace(/\s*\([^)]*\)\s*/g, '').replace(/\s*\/.*$/, '').trim();
    const words = short.split(/\s+/);
    return words.slice(0, 4).join(' ');
  },

  // Determine caller type for background audio selection
  // Returns 'yard' for shunters/CSD/sidings/yard/goods/depot,
  // 'signaller' for other signallers, or 'train' for train drivers
  getCallerType(caller, driverMsg) {
    if (!caller) return 'train';
    // Shunter is always yard
    if (/shunter/i.test(caller)) return 'yard';
    // CSD / sidings / yard / goods / depot in caller name or message
    if (/\b(CSD|siding|yard|goods|depot)\b/i.test(caller)) return 'yard';
    if (driverMsg && /\b(CSD|siding|yard|goods|depot)\b/i.test(driverMsg)) return 'yard';
    // Train calls have a headcode pattern (digit-letter-digits)
    if (/[0-9][A-Z][0-9]{2}/i.test(caller)) return 'train';
    // Technician — treat as train (cab-like environment)
    if (/technician/i.test(caller)) return 'train';
    // Everything else is a signaller
    return 'signaller';
  },

  // Parse simple "ready at" messages (e.g. "Train 5N53 is ready at Wall Sidings")
  // These lack the "entry point" keyword and signal code that CSD messages have.
  // May include timetable data on subsequent lines — if so, extract next stop and platform.
  parseReadyAtMessage(msg) {
    // Match first line only (location ends at newline or end-of-string)
    const match = msg.match(/(\w+)\s+is ready at\s+(.+?)\.?\s*(?:\n|$)/i);
    if (!match) return null;

    const headcode = match[1];
    const location = match[2].trim();

    // Try to extract next stop + platform from timetable lines
    // Timetable lines look like: "    Preston Park --:--    05:21    1    --- ---"
    // or "    Brighton 05:25    05:25    5    --- ---    N: 2T02"
    // Format: leading whitespace, station name, times, platform number
    let nextStop = '';
    let platform = '';
    const lines = msg.split('\n');
    for (const line of lines) {
      // Match timetable detail lines: station name followed by times and a platform number
      const platMatch = line.match(/^\s+(.+?)\s+(?:--:--|\d{2}:\d{2})\s+\d{2}:\d{2}\s+(\d+)/);
      if (platMatch) {
        nextStop = platMatch[1].trim();
        platform = platMatch[2];
        break; // first timetable stop is the next stop
      }
    }

    return { headcode, location, nextStop, platform };
  },

  // Parse signaller advisory messages — another signaller advising a train is waiting
  // SimSig formats: "I have train 1L33 waiting", "1L33 is waiting", "I have 1L33 waiting at Honiton"
  parseSignallerAdvisory(msg) {
    // "I have (train)? X waiting (at Y)?"
    const haveMatch = msg.match(/I\s+have\s+(?:train\s+)?(\w+)\s+waiting(?:\s+at\s+(.+?))?\.?\s*(?:\n|$)/i);
    if (haveMatch) return { headcode: haveMatch[1], location: haveMatch[2] ? haveMatch[2].trim() : null };
    // "X is waiting (at Y)?"
    const isMatch = msg.match(/(\w+)\s+is\s+waiting(?:\s+at\s+(.+?))?\.?\s*(?:\n|$)/i);
    if (isMatch) return { headcode: isMatch[1], location: isMatch[2] ? isMatch[2].trim() : null };
    return null;
  },

  // Parse "early running" advisory messages from other signallers
  // "I have 4022 running early via Aynho Junction (Up Main).\nIt can be in your area at about 05:00 if I let it continue.\nDo you want me to hold it until its booked time of 05:22?"
  parseEarlyRunningMessage(msg) {
    const earlyMatch = msg.match(/I have (\w+) running early via (.+?)[\.\n]/i);
    if (!earlyMatch) return null;

    const headcode = earlyMatch[1];
    const via = earlyMatch[2].replace(/\s*\([^)]*\)\s*$/, '').trim();
    const estimateMatch = msg.match(/in your area at about (\d{2}:\d{2})/i);
    const bookedMatch = msg.match(/booked time of (\d{2}:\d{2})/i);
    const estimate = estimateMatch ? estimateMatch[1] : '';
    const booked = bookedMatch ? bookedMatch[1] : '';

    return { headcode, via, estimate, booked };
  },

  // Keyword patterns for matching user speech to SimSig reply options
  // Order matters — more specific patterns first
  REPLY_MATCHERS: [
    { pattern: /no\s*obstruction|continue\s*normally/, fragment: 'no obstruction' },
    { pattern: /pass.*examine|authoris[ez].*pass.*examine|authoris[ez].*examine/, fragment: 'pass signal' },
    { pattern: /continue\s*examin/, fragment: 'continue examining' },
    { pattern: /(?:15|fifteen|one[\s-]*five|1[\s-]*5)\s*min/, fragment: '15 minute' },
    { pattern: /(?<!\d)(?:0?2|two|to)\s*min/, fragment: '2 minute' },
    { pattern: /(?<!\d)(?:0?5|five)\s*min/, fragment: '5 minute' },
    { pattern: /wait/, fragment: '2 minute' },  // bare "wait" defaults to 2 min
    { pattern: /authoris[ez].*pass|pass.*signal|pass\s*at\s*(?:stop|danger)|let\s*him\s*pass|pass\s*it/, fragment: 'authorise driver to pass' },
    { pattern: /examine.*line|examine\s*the/, fragment: 'examine the line' },
    // Place call specific matchers
    { pattern: /request\s*permission/, fragment: 'request permission' },
    { pattern: /cancel\s*all\s*accept/, fragment: 'cancel all acceptance' },
    { pattern: /cancel\s*accept/, fragment: 'cancel acceptance' },
    { pattern: /cancel/, fragment: 'cancel' },
    { pattern: /please\s*block|block.*signal/, fragment: 'block' },
    // General incoming call matchers
    { pattern: /permission\s*granted|granted/, fragment: 'permission granted' },
    { pattern: /understood|continue|obey|speaking.*control/, fragment: 'continue after speaking' },
    { pattern: /run\s*early|let.*run|let.*continue/, fragment: 'run early' },
    { pattern: /hold.*back|hold.*booked/, fragment: 'hold' },
    { pattern: /take\s*a\s*look|look\s*now|look\s*at\s*it/, fragment: 'ok' },
    { pattern: /\bok\b|thanks|thank\s*you|cheers/, fragment: 'ok' },
  ],

  // "danger" and "stop" are interchangeable in SimSig signalling terminology
  SYNONYMS: [['danger', 'stop']],

  // Match user's spoken text against available reply options
  matchReply(transcript, replies) {
    const text = transcript.toLowerCase();
    // First try exact pattern matchers (for incoming call standard replies)
    for (const matcher of this.REPLY_MATCHERS) {
      if (matcher.pattern.test(text)) {
        // Try the fragment as-is, then with synonyms swapped
        const fragments = [matcher.fragment];
        for (const pair of this.SYNONYMS) {
          if (matcher.fragment.includes(pair[0])) fragments.push(matcher.fragment.replace(pair[0], pair[1]));
          if (matcher.fragment.includes(pair[1])) fragments.push(matcher.fragment.replace(pair[1], pair[0]));
        }
        for (const frag of fragments) {
          const idx = replies.findIndex((r) => r.toLowerCase().includes(frag));
          if (idx >= 0) return idx;
        }
      }
    }
    // Fallback: fuzzy keyword matching — find the reply with the most word overlap
    // If there's only one reply, any speech selects it
    if (replies.length === 1) return 0;
    const words = text.split(/\s+/).filter((w) => w.length > 3);
    // Build synonym lookup for fuzzy matching
    const synMap = {};
    for (const pair of this.SYNONYMS) {
      synMap[pair[0]] = pair[1];
      synMap[pair[1]] = pair[0];
    }
    let bestIdx = -1;
    let bestScore = 0;
    replies.forEach((reply, i) => {
      const rLower = reply.toLowerCase();
      let score = 0;
      for (const w of words) {
        if (rLower.includes(w)) { score++; }
        else if (synMap[w] && rLower.includes(synMap[w])) { score++; }
      }
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    });
    // Require at least 1 matching word
    return bestScore >= 1 ? bestIdx : -1;
  },

  // Wait for PTT press, record audio, then transcribe using the configured provider:
  //   ElevenLabs → record PCM, send to main process → ElevenLabs Scribe API
  //   Edge/Windows → record via Vosk in-browser (WASM, no network needed)
  async recordAndTranscribe() {
    try {
      // Wait for PTT press to start
      await this.waitForPTTPress();

      // Mute background noise during recording for cleaner audio
      if (this.bgGain) this.bgGain.gain.value = 0;

      const settings = await window.simsigAPI.settings.getAll();
      const provider = settings.tts?.provider || 'edge';

      if (provider === 'elevenlabs') {
        // --- ElevenLabs Scribe: record PCM, send to main process ---
        console.log('[STT] PTT pressed — recording audio for ElevenLabs Scribe...');
        const audioData = await this._recordPCMWhilePTT();
        if (this.bgGain) this.bgGain.gain.value = 0.5;

        if (!audioData || audioData.length === 0) {
          console.log('[STT] No audio recorded');
          return '';
        }

        console.log(`[STT] Sending ${audioData.length} samples to Scribe...`);
        // Send as regular array (Electron IPC structured clone handles it)
        const result = await window.simsigAPI.stt.transcribe([...audioData]);

        if (result && typeof result === 'object' && result.error) {
          console.error('[STT] Scribe error:', result.error);
          return '';
        }
        console.log(`[STT] Scribe result: "${result}"`);
        return result || '';
      } else {
        // --- Vosk: in-browser WASM recognition ---
        console.log('[STT] PTT pressed — using Vosk in-browser STT...');
        try {
          const isPTTActive = () => typeof PTTUI !== 'undefined' && PTTUI.isActive;
          const result = await VoskSTT.transcribe(isPTTActive);
          if (this.bgGain) this.bgGain.gain.value = 0.5;
          console.log(`[STT] Vosk result: "${result}"`);
          return result || '';
        } catch (voskErr) {
          console.error('[STT] Vosk error:', voskErr.message);
          if (this.bgGain) this.bgGain.gain.value = 0.5;
          return '';
        }
      }
    } catch (err) {
      if (this.bgGain) this.bgGain.gain.value = 0.5;
      console.error('[STT] Recording error:', err);
      return '';
    }
  },

  // Record raw PCM Float32 audio at 16kHz while PTT is held
  async _recordPCMWhilePTT() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
        sampleRate: 16000,
      },
    });

    const audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const chunks = [];

    processor.onaudioprocess = (event) => {
      const data = event.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(data));
    };

    source.connect(processor);
    processor.connect(audioContext.destination);

    // Wait for PTT release
    await this.waitForPTTRelease();

    // Small delay to capture trailing audio
    await new Promise((r) => setTimeout(r, 200));

    // Cleanup
    processor.disconnect();
    source.disconnect();
    audioContext.close();
    stream.getTracks().forEach((t) => t.stop());

    // Concatenate all chunks into a single Float32Array
    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
    const combined = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    return combined;
  },

  // Returns a promise that resolves when PTT is pressed
  waitForPTTPress() {
    return new Promise((resolve, reject) => {
      if (this._replyClicked) { reject(new Error('reply_clicked')); return; }
      if (typeof PTTUI !== 'undefined' && PTTUI.isActive) { resolve(); return; }
      const check = () => {
        if (this._replyClicked) { reject(new Error('reply_clicked')); return; }
        if (typeof PTTUI !== 'undefined' && PTTUI.isActive) {
          resolve();
        } else {
          requestAnimationFrame(check);
        }
      };
      requestAnimationFrame(check);
    });
  },

  // Returns a promise that resolves when PTT is released
  waitForPTTRelease() {
    return new Promise((resolve) => {
      const check = () => {
        if (typeof PTTUI === 'undefined' || !PTTUI.isActive) {
          resolve();
        } else {
          requestAnimationFrame(check);
        }
      };
      requestAnimationFrame(check);
    });
  },

  NUMBERS: { 1:'one', 2:'two', 3:'three', 4:'four', 5:'five', 6:'six', 7:'seven', 8:'eight', 9:'nine', 10:'ten', 11:'eleven', 12:'twelve', 13:'thirteen', 14:'fourteen', 15:'fifteen', 20:'twenty', 25:'twenty five', 30:'thirty' },

  // Format raw SimSig reply option into proper signaller phrasing (GE/RT8000 style)
  formatReplyOption(raw) {
    const hc = this.currentHeadCode || '';
    const sig = this.currentSignalId || '';
    const panel = this.currentPanelName || '';
    const sigRef = sig ? ` signal ${sig}` : '';
    const panelRef = panel ? ` the ${panel} signaller` : ' the signaller';

    // Signaller-to-signaller calls use different phrasing
    if (this.isSignallerCall) {
      const sigWait = raw.match(/wait\s+(\d+)\s*min/i);
      if (sigWait) {
        return `Understood, they can expect to wait ${sigWait[1]} minutes further. Phone me back if it is longer than that`;
      }
      const sigCallBack = raw.match(/call\s*back\s+in\s+(\d+)\s*min/i);
      if (sigCallBack) {
        return `Give me ${sigCallBack[1]} minutes. Phone me back after that`;
      }
      if (/^\s*ok\s*$/i.test(raw)) {
        return 'Ok, Thanks. I will take a look now';
      }
      const runEarly = raw.match(/let\s+(\w+)\s+run\s+early/i);
      if (runEarly) {
        return `Ok, let ${runEarly[1]} come through`;
      }
      const holdBack = raw.match(/hold\s+(\w+)\s+back/i);
      if (holdBack) {
        return `Can you hold ${holdBack[1]} back until their booked time please`;
      }
      // Fall through to standard formatting for other signaller reply types
    }

    // Third-party calls (token hut, ground frame, etc.) — talk about the driver, not to them
    if (this.isThirdPartyCall) {
      if (/ok.*no\s*obstruction/i.test(raw)) {
        return `Ok, thank you. No obstructions found, they can continue normally`;
      }
      if (/pass.*signal.*at\s*stop.*examine|pass.*signal.*danger.*examine|authoris[ez].*pass.*examine|ask.*pass.*examine/i.test(raw)) {
        return `Ok, the driver of ${hc} is authorised to pass${sigRef} at danger. Tell them to proceed at caution and continue to examine the line. They need to report any obstructions`;
      }
      if (/authoris[ez].*pass.*signal|ask.*pass.*signal|pass.*signal.*at\s*stop/i.test(raw)) {
        return `Ok, the driver of ${hc} is authorised to pass${sigRef} at danger. Tell them to proceed at caution to the next signal and be prepared to stop short of any obstruction`;
      }
      if (/continue\s*examin/i.test(raw)) {
        return `Ok, thank you. No obstructions found. Tell the driver to continue examining the line and report any obstructions`;
      }
      if (/ask.*examine|examine\s*the\s*line/i.test(raw)) {
        return `Ok, I need the driver to examine the line between${sigRef} and the next signal. Tell them to proceed at caution and report any obstructions`;
      }
      const tpWait = raw.match(/wait\s+(\d+)\s*min/i);
      if (tpWait) {
        return `Ok, tell the driver to remain at${sigRef} and standby for ${tpWait[1]} minutes. Get them to phone back if the signal hasn't cleared`;
      }
      if (/continue\s+after\s+speaking/i.test(raw)) {
        return `Ok, tell the driver they can continue normally`;
      }
      const tpCallBack = raw.match(/call\s*back\s+in\s+(\d+)\s*min/i);
      if (tpCallBack) {
        return `Ok, get the driver to call back in ${tpCallBack[1]} minutes`;
      }
      if (/^\s*ok\s*$/i.test(raw)) {
        return 'Ok Thanks';
      }
      return raw.replace(/\bat stop\b/gi, 'at danger');
    }

    // "Ok, no obstruction found" — acknowledge and continue normally
    if (/ok.*no\s*obstruction/i.test(raw)) {
      return `${hc}, Thank you. No obstructions found. Continue normally`;
    }
    // Pass signal at danger AND continue examining the line
    if (/pass.*signal.*at\s*stop.*examine|pass.*signal.*danger.*examine|authoris[ez].*pass.*examine|ask.*pass.*examine/i.test(raw)) {
      return `Driver of ${hc}, this is${panelRef}. I am authorising you to pass${sigRef} at danger. Proceed at caution to the next signal and be prepared to stop short of any obstruction. Please continue to examine the line and report further`;
    }
    // Pass signal at danger only
    if (/authoris[ez].*pass.*signal|ask.*pass.*signal|pass.*signal.*at\s*stop/i.test(raw)) {
      return `Driver of ${hc}, this is${panelRef}. I am authorising you to pass${sigRef} at danger. Proceed at caution to the next signal and be prepared to stop short of any obstruction. Please examine the line and report any obstructions`;
    }
    // Continue examining the line (no pass at danger)
    if (/continue\s*examin/i.test(raw)) {
      return `${hc}, Thank you. No obstructions found. Driver, please continue to examine the line and report any obstructions`;
    }
    // Examine the line only (initial request)
    if (/ask.*examine|examine\s*the\s*line/i.test(raw)) {
      return `${hc}, I need you to examine the line between${sigRef} and the next signal. Proceed at caution and report any obstructions`;
    }
    // Wait N minutes
    const waitMatch = raw.match(/wait\s+(\d+)\s*min/i);
    if (waitMatch) {
      return `${hc}, correct. Remain at${sigRef}. Standby for ${waitMatch[1]} minutes before phoning back`;
    }
    // "Driver, please continue after speaking to your control"
    if (/continue\s+after\s+speaking/i.test(raw)) {
      return `${hc}, understood. Continue normally unless otherwise instructed`;
    }
    // "Permission granted for 5A20 to enter"
    const permMatch = raw.match(/permission\s+granted\s+for\s+(\w+)\s+to\s+enter/i);
    if (permMatch) {
      return `Permission granted, ${permMatch[1]} can enter`;
    }
    // "No, let 4022 run early" — allow early running train to continue
    const runEarlyMatch = raw.match(/let\s+(\w+)\s+run\s+early/i);
    if (runEarlyMatch) {
      return `We can let ${runEarlyMatch[1]} run early`;
    }
    // "Please hold 4022 back" — hold train until booked time
    const holdBackMatch = raw.match(/hold\s+(\w+)\s+back/i);
    if (holdBackMatch) {
      return `Can you hold ${holdBackMatch[1]} back until their booked time, thanks`;
    }
    // "Please call back in N minutes"
    const callBackMatch = raw.match(/call\s*back\s+in\s+(\d+)\s*min/i);
    if (callBackMatch) {
      const who = this.isShunterCall ? 'Shunter' : 'Driver';
      return `${who}, Please call back in ${callBackMatch[1]} minutes`;
    }
    // Simple "Ok" reply (e.g. ready-at-location acknowledgement)
    if (/^\s*ok\s*$/i.test(raw)) {
      return 'Ok Thanks';
    }
    // Default: swap "at stop" → "at danger"
    return raw.replace(/\bat stop\b/gi, 'at danger');
  },

  // Build driver readback confirmation for a reply (GE/RT8000 style)
  buildConfirmation(replyText) {
    const lower = replyText.toLowerCase();
    const sig = this.currentSignalId || '';
    const hc = this.currentHeadCode || '';
    const sigRef = sig ? ` signal ${sig}` : '';
    const trainRef = hc ? `, ${hc}` : '';

    // Signaller-to-signaller readbacks are conversational
    if (this.isSignallerCall) {
      if (/wait\s+\d+\s*min/i.test(lower)) {
        return 'Ok, I will let them know. Thanks';
      }
      if (/call\s*back\s+in\s+\d+\s*min/i.test(lower)) {
        return 'Ok, will do. Thanks';
      }
      if (/run\s*early|let.*run|let.*continue/i.test(lower)) {
        return 'Ok, will do. Thanks';
      }
      if (/hold.*back/i.test(lower)) {
        return 'Ok, I will hold them. Thanks';
      }
      if (/^\s*ok\s*$/i.test(lower)) {
        return 'Ok, Thanks. Bye';
      }
      return 'Ok, Thanks. Bye';
    }

    // Third-party readback (token hut, ground frame) — conversational, relaying the message
    if (this.isThirdPartyCall) {
      if (/pass.*signal.*at\s*(stop|danger).*examine/i.test(lower) || /pass.*at\s*danger.*continue.*examine/i.test(lower)) {
        return `Ok, I will let the driver know they are authorised to pass${sigRef} at danger and to continue examining the line`;
      }
      if (/pass.*signal.*at\s*(stop|danger)/i.test(lower)) {
        return `Ok, I will tell the driver they are authorised to pass${sigRef} at danger`;
      }
      if (/no\s*obstruction.*continue\s*normally/i.test(lower)) {
        return 'Ok, I will let them know they can continue normally';
      }
      if (/continue.*examine/i.test(lower)) {
        return 'Ok, I will tell them to continue examining the line';
      }
      if (/examine\s*the\s*line/i.test(lower)) {
        return `Ok, I will get the driver to examine the line from${sigRef} and report back`;
      }
      const tpWait = lower.match(/wait\s+(\d+)\s*min/);
      if (tpWait) {
        return `Ok, I will tell them to wait ${tpWait[1]} minutes`;
      }
      const tpCallBack = lower.match(/call\s*back\s+in\s+(\d+)\s*min/);
      if (tpCallBack) {
        return `Ok, I will get them to call back in ${tpCallBack[1]} minutes`;
      }
      if (/continue\s+after\s+speaking/i.test(lower)) {
        return 'Ok, I will let the driver know they can continue';
      }
      return 'Ok, I will pass that on to the driver';
    }

    // "No obstructions found, continue normally"
    if (/no\s*obstruction.*continue\s*normally/i.test(lower)) {
      return `Understood, continue normally${trainRef}`;
    }
    // Pass signal at danger + continue examining the line
    if (/pass.*signal.*at\s*(stop|danger).*examine/i.test(lower) || /pass.*at\s*danger.*continue.*examine/i.test(lower)) {
      return `Authorised to pass${sigRef} at danger, continue to examine the line, proceed at caution${trainRef}`;
    }
    // Pass signal at danger only
    if (/pass.*signal.*at\s*(stop|danger)/i.test(lower)) {
      return `Authorised to pass${sigRef} at danger, proceed at caution to the next signal${trainRef}`;
    }
    // Continue examining the line
    if (/continue.*examine/i.test(lower)) {
      return `Understood, continue to examine the line and report${trainRef}`;
    }
    // Examine the line only (initial request)
    if (/examine\s*the\s*line/i.test(lower)) {
      return `Examine the line from${sigRef} to the next signal, proceed at caution and report${trainRef}`;
    }
    // Wait N minutes — no formal readback required, just acknowledge
    const waitMatch = lower.match(/wait\s+(\d+)\s*min/);
    if (waitMatch) {
      const n = parseInt(waitMatch[1], 10);
      const word = this.NUMBERS[n] || waitMatch[1];
      return `Understood, remain at${sigRef} and wait ${word} minutes${trainRef}`;
    }
    // Call back in N minutes
    const callBackMatch = lower.match(/call\s*back\s+in\s+(\d+)\s*min/);
    if (callBackMatch) {
      const n = parseInt(callBackMatch[1], 10);
      const word = this.NUMBERS[n] || callBackMatch[1];
      return `Ok, will call back in ${word} minutes`;
    }
    // Run early — caller acknowledges
    if (/run\s*early/i.test(lower)) {
      return 'Ok, I will let it run early. Thanks';
    }
    // Hold back — caller acknowledges
    if (/hold.*back/i.test(lower)) {
      return 'Ok I will hold it back';
    }
    // Continue after speaking to control
    if (/continue\s+after\s+speaking/i.test(lower) || /continue.*obey/i.test(lower)) {
      return `Understood, I will continue to obey all other aspects${trainRef}`;
    }
    // Permission granted to enter
    if (/permission\s+granted/i.test(lower)) {
      return `Permission granted, ${hc} can enter`;
    }
    // Simple "Ok Thanks" acknowledgement (ready-at-location etc.)
    if (/ok\s*thanks/i.test(lower)) {
      return `Ok Thanks${trainRef}`;
    }
    return `Understood${trainRef}`;
  },

  // Send a reply by index — shared by speech recognition, click, and fallback button paths.
  // FLOW:
  //   1. Build the caller's readback text (buildConfirmation) based on reply type and caller type
  //      (driver = formal readback, signaller = conversational, third-party = relay phrasing)
  //   2. Start TTS audio generation in parallel (don't wait for it)
  //   3. Send reply to SimSig via reply-phone-call.ps1 (handles headcode confirmation dialogs)
  //   4. Show readback text in chat and play TTS audio
  //   5. Unlock hang-up button
  // The currentHeadCode is passed to the PS script for headcode confirmation dialogs.
  async sendReply(replyIndex, replies, caller) {
    const myCallId = this._callSeq;
    this._hangUpLocked = true; // prevent hangup keybind/click during reply flow
    this.addMessage({ type: 'loading', text: 'Replying...' });
    const confirmation = this.buildConfirmation(replies[replyIndex]);

    const voices = await this.getTTSVoices();
    if (myCallId !== this._callSeq) return;
    let audioPromise = null;
    if (voices && voices.length > 0) {
      const voiceId = this.getTTSVoiceId(caller, voices);
      audioPromise = this.fetchTTSAudio(this.phoneticize(confirmation), voiceId);
    }

    // Send reply to SimSig — PS script handles headcode entry dialogs automatically
    await window.simsigAPI.phone.replyCall(replyIndex, this.currentHeadCode);
    if (myCallId !== this._callSeq) return;
    this._replySent = true;

    // Remove loading spinner, show confirmation text
    this.messages = this.messages.filter((m) => m.type !== 'loading');
    this.addMessage({ type: 'driver', caller, text: confirmation });

    // Play audio (already fetched or nearly done)
    if (audioPromise) {
      const audioData = await audioPromise;
      if (myCallId !== this._callSeq) return;
      const ok = await this.playAudioData(audioData);
      if (myCallId !== this._callSeq) return;
      if (!ok) { await this.speakLocal(this.phoneticize(confirmation), caller); if (myCallId !== this._callSeq) return; }
    } else {
      await this.speakLocal(this.phoneticize(confirmation), caller);
      if (myCallId !== this._callSeq) return;
    }
    this._hangUpLocked = false;
    await this.showHangUpInChat(myCallId);
  },

  // Send "Ok" reply to SimSig, show "Ok, Thanks", driver says "Ok, Bye", then hang up
  async sendOkAndHangUp(caller) {
    const myCallId = this._callSeq;
    this._replyClicked = true;
    this._hangUpLocked = true; // prevent hangup keybind/click during reply flow
    this.addMessage({ type: 'loading', text: 'Replying...' });
    await window.simsigAPI.phone.replyCall(0, this.currentHeadCode);
    if (myCallId !== this._callSeq) return;
    this._replySent = true;
    this.messages = this.messages.filter((m) => m.type !== 'loading');
    const okText = this.isSignallerCall ? 'Ok, Thanks. I will take a look now' : 'Ok, Thanks';
    this.addMessage({ type: 'signaller', text: okText });
    this.renderChat();
    // Caller replies then call ends
    const goodbye = this.isSignallerCall ? 'Ok, Thanks. Bye' : 'Ok, Bye';
    this.addMessage({ type: 'driver', caller: this.shortenCaller(caller), text: goodbye });
    await this.speakAsDriver(goodbye, caller);
    if (myCallId !== this._callSeq) return;
    this._hangUpLocked = false;
    this.hangUp();
  },

  // Click handler for the Ok-only reply option — sends reply and hangs up directly
  setupOkOnlyClickHandler(caller) {
    if (this._replyDelegateHandler) {
      this.chatEl.removeEventListener('click', this._replyDelegateHandler);
    }
    this._replyDelegateHandler = (e) => {
      if (this._replyClicked) return;
      const li = e.target.closest('.reply-options-list li');
      if (li) {
        this.sendOkAndHangUp(caller);
      }
    };
    this.chatEl.addEventListener('click', this._replyDelegateHandler);
  },

  // Set up delegated click handler for reply options (survives renderChat DOM rebuilds)
  setupReplyClickHandlers(replies, caller) {
    this._replyClicked = false;
    this._replyReplies = replies;
    this._replyCaller = caller;

    // Remove previous delegated handler if any
    if (this._replyDelegateHandler) {
      this.chatEl.removeEventListener('click', this._replyDelegateHandler);
    }

    this._replyDelegateHandler = (e) => {
      if (this._replyClicked) return;

      // Check for wait time chip click
      const chip = e.target.closest('.wait-time-choice');
      if (chip) {
        this._replyClicked = true;
        const idx = parseInt(chip.dataset.index, 10);
        this.sendReply(idx, this._replyReplies, this._replyCaller);
        return;
      }

      // Check for <li> click with a valid reply index
      const li = e.target.closest('.reply-options-list li');
      if (li) {
        const replyIdx = parseInt(li.dataset.replyIndex, 10);
        if (replyIdx < 0) return; // wait row — use time chips
        this._replyClicked = true;
        this.sendReply(replyIdx, this._replyReplies, this._replyCaller);
      }
    };

    this.chatEl.addEventListener('click', this._replyDelegateHandler);
  },

  // Full reply flow: show options, listen for speech, match keywords, send to SimSig
  async handleReply(replies, caller, callId) {
    // If only "Ok" is available, show as speak prompt then send reply and hang up (no goodbye)
    const okOnly = replies.length === 1 && /^ok$/i.test(replies[0].trim());
    if (okOnly) replies = ['Ok, Thanks'];
    this._isOkOnly = okOnly; // stored so remote actions know the reply type

    this._replyClicked = false;
    this.addMessage({ type: 'reply-options', replies });

    if (okOnly) {
      // Set up click handler that sends reply and hangs up directly
      this.setupOkOnlyClickHandler(caller);
    } else {
      this.setupReplyClickHandlers(replies, caller);
    }

    const MAX_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (this._replyClicked || callId !== this._callSeq) return;
      this.addMessage({ type: 'greeting', text: 'Hold PTT and speak your reply...' });

      let transcript = '';
      try {
        transcript = await this.recordAndTranscribe();
      } catch (e) {
        if (this._replyClicked || callId !== this._callSeq) return;
        break;
      }
      if (this._replyClicked || callId !== this._callSeq) return;

      if (transcript) {
        const replyIndex = this.matchReply(transcript, replies);
        if (replyIndex >= 0) {
          if (okOnly) {
            await this.sendOkAndHangUp(caller);
            return;
          }
          await this.sendReply(replyIndex, replies, caller);
          return;
        }
      }

      // Not understood
      if (callId !== this._callSeq) return;
      const sorry = "Can you say again please";
      this.addMessage({ type: 'driver', caller, text: sorry });
      await this.speakAsDriver(sorry, caller);
      if (callId !== this._callSeq) return;
    }

    if (this._replyClicked || callId !== this._callSeq) return;

    // After max attempts, re-show the clickable reply options
    this.addMessage({ type: 'reply-options', replies });
    this.setupReplyClickHandlers(replies, caller);
  },

  // After reply is sent, listen for goodbye on incoming calls
  async showHangUpInChat(callId) {
    this._replyClicked = false;
    this._hangUpLocked = false; // allow hangup from this point

    while (this.inCall && callId === this._callSeq) {
      this.addMessage({ type: 'greeting', text: 'Hold PTT to say goodbye...' });

      try {
        const transcript = await this.recordAndTranscribe();
        if (!this.inCall || callId !== this._callSeq) return;
        if (transcript) {
          // At the goodbye stage, any speech is treated as goodbye
          // (user has already sent their reply — they're just ending the call)
          const voiceKey = this._activeCallVoiceKey || this._activeCallTrain || '';
          const goodbyes = this.isSignallerCall ? [
            'Ok, Thanks. Bye.',
            'Right, thanks for letting me know. Bye.',
            'Ok, cheers. Bye.',
            'Thanks. Bye.',
            'Ok, thanks for that. Bye bye.',
          ] : [
            'Right, cheers mate, bye.',
            'Ta, bye now.',
            'Sound, cheers, bye bye.',
            'Nice one, ta, bye.',
            'Alright mate, cheers, bye.',
            'Lovely, ta, see ya.',
            'Right oh, cheers, bye.',
            'Sweet, ta mate, bye bye.',
            'Alright, cheers ears, bye.',
            'Sorted, ta, bye now.',
          ];
          const reply = goodbyes[Math.floor(Math.random() * goodbyes.length)];
          this.addMessage({ type: 'driver', caller: this.shortenCaller(voiceKey), text: reply });
          await this.speakAsDriver(reply, voiceKey);
          if (callId !== this._callSeq) return;
          this.hangUp();
          return;
        }
      } catch (e) {
        // PTT cancelled or error — loop back and try again
      }
    }
  },

  // Fallback: show clickable buttons for reply options
  waitForReplyButton(replies, caller) {
    return new Promise((resolve) => {
      const container = document.createElement('div');
      container.className = 'reply-buttons';

      const makeHandler = (index, reply) => async () => {
        container.remove();
        await window.simsigAPI.phone.replyCall(index, this.currentHeadCode);
        this._replySent = true;
        const confirmation = this.buildConfirmation(reply);
        this.addMessage({ type: 'driver', caller, text: confirmation });
        await this.speakAsDriver(confirmation, caller);
        await this.showHangUpInChat();
        resolve();
      };

      // Group wait options into one row with time buttons
      const waitReplies = [];
      const otherReplies = [];
      replies.forEach((reply, i) => {
        const wm = reply.match(/wait\s+(\d+)\s*min/i);
        if (wm) {
          waitReplies.push({ reply, index: i, mins: wm[1] });
        } else {
          otherReplies.push({ reply, index: i });
        }
      });

      if (waitReplies.length > 0) {
        const hc = this.currentHeadCode || '';
        const sig = this.currentSignalId || '';
        const sigRef = sig ? ` signal ${sig}` : '';
        const row = document.createElement('div');
        row.className = 'reply-btn-wait-row';
        const label = document.createElement('span');
        label.className = 'reply-btn-wait-label';
        label.textContent = `${hc}, correct. Remain at${sigRef}. Standby for`;
        row.appendChild(label);
        waitReplies.forEach((w) => {
          const btn = document.createElement('button');
          btn.className = 'reply-btn reply-btn-wait';
          btn.textContent = `${w.mins} min`;
          btn.addEventListener('click', makeHandler(w.index, w.reply));
          row.appendChild(btn);
        });
        container.appendChild(row);
      }

      otherReplies.forEach((o) => {
        const btn = document.createElement('button');
        btn.className = 'reply-btn';
        btn.textContent = this.formatReplyOption(o.reply);
        btn.addEventListener('click', makeHandler(o.index, o.reply));
        container.appendChild(btn);
      });

      this.chatEl.appendChild(container);
      this.chatEl.scrollTop = this.chatEl.scrollHeight;
    });
  },

  // Speak as driver — phoneticizes codes, tries selected TTS provider, falls back to local
  async speakAsDriver(text, caller) {
    if (this.isPaused()) return;
    const spoken = this.phoneticize(text);
    const voices = await this.getTTSVoices();
    if (voices && voices.length > 0) {
      const voiceId = this.getTTSVoiceId(caller, voices);
      const ok = await this.speakTTS(spoken, voiceId);
      if (ok) return;
      console.warn('[TTS] Speak failed, falling back to local TTS');
    }
    await this.speakLocal(spoken, caller);
  },

  // Wait for user to press and release PTT (signaller speaking)
  async waitForUserSpeech() {
    await this.waitForPTTPress();
    await this.waitForPTTRelease();
  },

  hangUp() {
    // Stop any TTS immediately
    this.stopTTS();

    // Remove the active call from the list
    const activeTrain = this._activeCallTrain;
    if (activeTrain) {
      this.calls = this.calls.filter((c) => c.train !== activeTrain);
    }

    this.inCall = false;
    this._isOkOnly = false;
    window.simsigAPI.keys.setInCall(false);
    this.isShunterCall = false;
    this.isSignallerCall = false;
    this.isThirdPartyCall = false;
    this._replyClicked = false;
    this._hasReplyOptions = false;
    this._replySent = false;
    this._hangUpLocked = false;
    this._activeCallTrain = '';
    this._activeCallVoiceKey = '';
    this.stopBgNoise();
    this.bgCallerType = 'train';
    this.messages = [];
    if (this._replyDelegateHandler) {
      this.chatEl.removeEventListener('click', this._replyDelegateHandler);
      this._replyDelegateHandler = null;
    }
    this.renderChat();
    this.renderCalls();
    this.hideNotification();
    this._syncToRemote();

    // Hide any lingering TAnswerCallForm dialog in SimSig
    window.simsigAPI.phone.hideAnswerDialog().catch(() => {});
    // If there are waiting calls, show the next one and start ringing
    if (this.calls.length > 0) {
      const nextCall = this.calls[this.calls.length - 1];
      this.showNotification(nextCall.train || '');
      this.startRinging();
    }
  },

  async answerCall(index) {
    if (this.inCall) return; // prevent double-answer race condition
    this.inCall = true;
    this._hangUpLocked = true; // lock hangup until call flow is ready
    const callId = ++this._callSeq; // unique ID to detect stale async continuations
    window.simsigAPI.keys.setInCall(true);
    this._replyClicked = false;
    this._hasReplyOptions = false;
    this._replySent = false;
    this.stopRinging();

    const call = this.calls[index];
    const train = call ? call.train : '';
    this._activeCallTrain = train;

    // Broadcast to all clients so they stop ringing too
    window.simsigAPI.phone.notifyCallAnswered(train);

    this.showInCallNotification(train);

    // Remove focus from notification so Space (PTT) doesn't trigger a click on [End Call]
    if (document.activeElement && this.notificationEl.contains(document.activeElement)) {
      document.activeElement.blur();
    }

    const btn = this.listEl.querySelector(`.call-answer-btn[data-index="${index}"]`);
    if (btn) {
      btn.textContent = 'In Call';
      btn.disabled = true;
      btn.classList.add('in-call');
    }

    this.addMessage({ type: 'system', text: 'Answering...' });

    // Fetch settings + voices IN PARALLEL with the PowerShell answer script
    // so they're ready the instant the answer result comes back
    const [result, settingsAll, voices] = await Promise.all([
      window.simsigAPI.phone.answerCall(index, train),
      window.simsigAPI.settings.getAll(),
      this.getTTSVoices(),
    ]);
    if (callId !== this._callSeq) return; // call was hung up while awaiting

    if (result.error) {
      // Call no longer exists — remove it from local list and reset state
      this.inCall = false;
      window.simsigAPI.keys.setInCall(false);
      this.calls = this.calls.filter((c, i) => i !== index);
      this.renderCalls();
      if (this.calls.length > 0) {
        this.showNotification(this.calls[this.calls.length - 1].train || '');
        this.startRinging();
      } else {
        this.hideNotification();
      }
      this.messages = [];
      this.renderChat();
      return;
    }

    // Lock End Call until reply is sent (if this call has reply options)
    if (result.replies && result.replies.length > 0) {
      this._hasReplyOptions = true;
    }

    // Build greeting and driver message — settings + voices already loaded
    const panelName = settingsAll.signaller?.panelName || 'Panel';
    const position = this.extractPosition(result.title);
    const greeting = `Hello, ${panelName} Signaller${position ? ', ' + position : ''}, Go ahead`;
    const caller = (result.title || '').replace(/^Answer call from\s*/i, '') || result.train || '';
    this._activeCallVoiceKey = caller; // consistent key for voice selection during this call
    const driverMsg = result.message || '';
    const csd = this.parseCsdMessage(driverMsg);
    const readyAt = !csd ? this.parseReadyAtMessage(driverMsg) : null;
    const earlyRun = this.parseEarlyRunningMessage(driverMsg);
    const sigAdvisory = !csd && !readyAt && !earlyRun ? this.parseSignallerAdvisory(driverMsg) : null;

    // Start background noise for the duration of the call
    // Signaller → office ambience, shunter/CSD/yard → yard noise, train → cab noise
    this.bgCallerType = this.getCallerType(caller, driverMsg);
    this.isShunterCall = /shunter/i.test(caller);
    // Third-party calls: caller is not a Driver, not a Signaller, not a Shunter
    // (e.g. token hut, ground frame, level crossing) — use third-person phrasing
    this.isThirdPartyCall = !this.isShunterCall && !this.isSignallerCall
      && !/^Driver\b/i.test(caller) && !/signaller/i.test(caller)
      && !/[0-9][A-Z][0-9]{2}/i.test(caller);
    this.startBgNoise();

    // Extract signal and headcode EARLY so formatReplyOption can use them
    const sigMatch = driverMsg.match(/signal\s+([A-Z0-9]+)/i);
    const titleMatch = (result.title || '').match(/([0-9][A-Z][0-9]{2})/i);
    const trainMatch = (result.train || train).match(/([0-9][A-Z][0-9]{2})/i);
    const advisoryHc = sigAdvisory ? sigAdvisory.headcode.toUpperCase() : null;
    this.currentHeadCode = titleMatch ? titleMatch[1].toUpperCase()
      : trainMatch ? trainMatch[1].toUpperCase()
      : advisoryHc
        ? advisoryHc
        : (result.train || train).trim();
    // Use signal from message, or fall back to cached signal for this train
    if (sigMatch) {
      this.currentSignalId = sigMatch[1];
      this.trainSignalCache[this.currentHeadCode] = sigMatch[1];
    } else {
      this.currentSignalId = this.trainSignalCache[this.currentHeadCode] || null;
    }
    this.currentPanelName = panelName;

    // Update notification with actual headcode from the answered call
    this.showInCallNotification(this.currentHeadCode);

    // Build display and spoken messages based on call type
    const isExamineResult = /examining the line.*no obstruction|no obstruction.*found/i.test(driverMsg);
    let displayMsg, spokenMsg;
    if (csd) {
      displayMsg = `${csd.headcode} is ready at entry point ${csd.entryPoint} (${csd.signal}). Permission required to enter.`;
      spokenMsg = this.buildCsdSpokenMessage(panelName, position, csd, caller);
    } else if (readyAt) {
      const isShunter = /shunter/i.test(caller);
      const isDriverAtSidings = /^Driver\s*\(/i.test(caller) && /\b(siding|yard|goods|depot)\b/i.test(readyAt.location);
      if (isShunter || isDriverAtSidings) {
        // Shunter-style message for shunters or drivers calling from sidings
        this.isShunterCall = true;
        if (this.bgCallerType !== 'yard') {
          this.bgCallerType = 'yard';
          this.stopBgNoise();
          this.startBgNoise();
        }
        let msg = `Hello, this is the Shunter in ${readyAt.location}. Train ${readyAt.headcode} is ready`;
        if (readyAt.nextStop) {
          msg += `. Next stop is ${readyAt.nextStop}`;
          if (readyAt.platform) msg += ` Platform ${readyAt.platform}`;
        }
        spokenMsg = msg;
        displayMsg = msg;
      } else {
        displayMsg = `Driver of ${readyAt.headcode}. I am waiting to enter at ${readyAt.location}.`;
        spokenMsg = `Hello ${panelName} Signaller. This is driver of ${readyAt.headcode}. I am waiting to enter at ${readyAt.location}`;
      }
    } else if (earlyRun) {
      this.isSignallerCall = true;
      const bookedPart = earlyRun.booked ? ` with booked time of ${earlyRun.booked}` : '';
      displayMsg = `${caller}. ${earlyRun.headcode} is early. Estimate is ${earlyRun.estimate}${bookedPart}. Continue or hold back?`;
      spokenMsg = `Hello ${panelName}, this is ${this.shortenCaller(caller)} Signaller. I have ${earlyRun.headcode} running early via ${earlyRun.via}. It can be in your area at about ${earlyRun.estimate}. Shall I let it continue or hold it back until its booked time of ${earlyRun.booked}?`;
    } else if (sigAdvisory) {
      this.isSignallerCall = true;
      const locPart = sigAdvisory.location ? ` at ${sigAdvisory.location}` : '';
      spokenMsg = `Hello, ${panelName} Signaller, this is ${this.shortenCaller(caller)}. I currently have ${sigAdvisory.headcode} waiting${locPart}`;
      displayMsg = spokenMsg;
    } else if (isExamineResult && this.currentHeadCode) {
      // Examine line result — driver reporting back after examining the line
      const sigPart = this.currentSignalId ? ` at ${this.currentSignalId}` : '';
      displayMsg = `${this.currentHeadCode} is stopped${sigPart} after examining the line. No obstructions found.`;
      spokenMsg = `Hello Signaller. This is driver of ${this.currentHeadCode} standing at${this.currentSignalId ? ` ${this.currentSignalId} signal indicating danger` : ' signal indicating danger'}. After examining the line, no obstruction was found.`;
    } else if (this.currentSignalId) {
      // Red signal / waiting at signal scenario
      displayMsg = `${this.currentHeadCode} waiting at red signal ${this.currentSignalId}`;
      spokenMsg = `Hello Signaller, this is driver of ${this.currentHeadCode}. I am at signal ${this.currentSignalId} displaying red`;
    } else if (driverMsg) {
      displayMsg = driverMsg;
      spokenMsg = `Hello, ${panelName} Signaller${position ? ', ' + position : ''}, this is ${driverMsg}`;
    } else {
      // Non-train caller (Technician, Shunter, etc.) with no message body
      displayMsg = `${this.shortenCaller(caller)} is calling`;
      spokenMsg = `Hello, ${panelName} Signaller. This is ${this.shortenCaller(caller)}.`;
    }

    // Display text matches spoken text so user can read along with TTS
    displayMsg = spokenMsg;

    // Pre-generate TTS audio IN PARALLEL while user speaks the greeting
    let prefetchedAudio = null;
    let voiceId = null;
    const greetingText = greeting;
    if (voices && voices.length > 0) {
      voiceId = this.getTTSVoiceId(caller, voices);
      // Start fetching audio immediately — don't wait for user to finish speaking
      const audioPromise = this.fetchTTSAudio(this.phoneticize(spokenMsg), voiceId);

      // Show greeting and wait for user speech AT THE SAME TIME as audio generates
      this.addMessage({ type: 'greeting', text: greetingText });
      const [audio] = await Promise.all([audioPromise, this.waitForUserSpeech()]);
      if (callId !== this._callSeq) return;
      prefetchedAudio = audio;
    } else {
      this.addMessage({ type: 'greeting', text: greetingText });
      await this.waitForUserSpeech();
      if (callId !== this._callSeq) return;
    }

    // Show driver message and play TTS
    const shortCaller = this.shortenCaller(caller);
    this.addMessage({ type: 'driver', caller: shortCaller, text: displayMsg });

    if (prefetchedAudio) {
      const ok = await this.playAudioData(prefetchedAudio);
      if (callId !== this._callSeq) return;
      if (!ok) { await this.speakLocal(this.phoneticize(spokenMsg), caller); if (callId !== this._callSeq) return; }
    } else {
      await this.speakLocal(this.phoneticize(spokenMsg), caller);
      if (callId !== this._callSeq) return;
    }
    console.log(`[Phone] Title: "${result.title}", Train: "${result.train}", HeadCode: "${this.currentHeadCode}"`);

    // Handle reply if reply options available, then listen for goodbye
    if (result.replies && result.replies.length > 0) {
      await this.handleReply(result.replies, caller, callId);
    } else {
      // No reply options — go straight to goodbye
      await this.showHangUpInChat(callId);
    }
  },

  addMessage(msg) {
    const time = this.gameTime || '';
    this.messages.push({ ...msg, time });
    this.renderChat();
    this._syncToRemote();
  },

  renderCalls() {
    // Update tab bar count
    if (this.tabIncomingEl) {
      this.tabIncomingEl.textContent = `Incoming (${this.calls.length})`;
    }

    if (this.calls.length === 0) {
      this.countEl.classList.add('hidden');
      this.noCallsEl.classList.remove('hidden');
      this.listEl.innerHTML = '';
      if (!this.inCall) this.hideNotification();
    } else {
      this.countEl.textContent = this.calls.length;
      this.countEl.classList.remove('hidden');
      this.noCallsEl.classList.add('hidden');

      this.listEl.innerHTML = this.calls.map((call, i) => {
        const trainText = call.train || '';
        const headMatch = trainText.match(/([0-9][A-Z][0-9]{2})/i);
        const headcode = headMatch ? headMatch[1].toUpperCase() : this.shortenCaller(trainText);
        const isActive = this.inCall && trainText === this._activeCallTrain;
        const btnClass = isActive ? 'call-answer-btn in-call' : 'call-answer-btn';
        const btnText = isActive ? 'In Call' : 'Answer';
        const btnDisabled = isActive ? 'disabled' : '';
        return `<tr>
          <td class="col-train">${this.escapeHtml(headcode)}</td>
          <td class="col-signal"></td>
          <td class="col-action">
            <button class="${btnClass}" data-index="${i}" ${btnDisabled}>${btnText}</button>
          </td>
        </tr>`;
      }).join('');

      // Only flash notification for new calls if not already in a call or on an outgoing call
      if (!this.inCall && !this._outgoingCall && !this._dialingActive) {
        const latestCall = this.calls[this.calls.length - 1];
        this.showNotification(latestCall.train || '');
      }
    }

    this.listEl.querySelectorAll('.call-answer-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        if (this.inCall) return; // already in a call
        const idx = parseInt(e.target.dataset.index, 10);
        if (this._isBrowser) {
          window.simsigAPI.phone.remoteAction({ type: 'answer', index: idx });
        } else {
          this.answerCall(idx);
        }
      });
    });
  },

  showDialingNotification(contactName) {
    if (!this.notificationEl) return;
    // Silence incoming ringing while placing an outgoing call
    this.stopRinging();
    this.notificationEl.classList.remove('hidden');
    this.notificationEl.classList.remove('in-call');
    this.notificationEl.classList.add('flashing');
    this.notificationTrainEl.textContent = contactName;
    if (this.notificationSignalEl) this.notificationSignalEl.textContent = '';
    if (this.notificationAnswerBtn) this.notificationAnswerBtn.textContent = '[Cancel]';
    const icon = this.notificationEl.querySelector('#notification-icon');
    if (icon) icon.innerHTML = '&#128222;';
    this._dialingActive = true;
    this._syncToRemote();
    // No audio on browser — host plays the ringing-out sound
    if (this._isBrowser) return;
    // Play ringing-out via Web Audio API with smooth fade-out and 1s gap
    if (!this._ringOutCtx) {
      this._ringOutCtx = new (window.AudioContext || window.webkitAudioContext)();
      fetch('../../sounds/ringing-out.wav')
        .then(r => r.arrayBuffer())
        .then(buf => this._ringOutCtx.decodeAudioData(buf))
        .then(decoded => {
          this._ringOutBuffer = decoded;
          if (this._dialingActive) this._playRingOut();
        })
        .catch(() => {});
    }
    if (this._ringOutBuffer) this._playRingOut();
  },

  _playRingOut() {
    if (!this._dialingActive || !this._ringOutBuffer || !this._ringOutCtx) return;
    const ctx = this._ringOutCtx;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    const source = ctx.createBufferSource();
    source.buffer = this._ringOutBuffer;
    source.connect(gain);
    // Fade out over last 50ms
    const dur = this._ringOutBuffer.duration;
    gain.gain.setValueAtTime(1, ctx.currentTime);
    gain.gain.setValueAtTime(1, ctx.currentTime + dur - 0.05);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + dur);
    source.start(0);
    this._ringOutSource = source;
    this._ringOutGain = gain;
    // Schedule next loop with 1s gap
    source.onended = () => {
      this._ringingOutTimer = setTimeout(() => {
        if (this._dialingActive) this._playRingOut();
      }, 1000);
    };
  },

  stopDialing(keepDialog) {
    this._dialingActive = false;
    if (this._ringingOutTimer) {
      clearTimeout(this._ringingOutTimer);
      this._ringingOutTimer = null;
    }
    if (this._ringOutSource) {
      try { this._ringOutSource.stop(); } catch (e) {}
      this._ringOutSource = null;
    }
    // Only close the Place Call dialog if we're cancelling (not when connected)
    if (!keepDialog) {
      window.simsigAPI.phone.placeCallHangup().catch(() => {});
      this.hideNotification();
      // Resume incoming call notification if calls are waiting
      this._resumeIncoming();
    } else {
      this.hideNotification();
    }
  },

  async showOutgoingCallNotification(contactName, message, replies) {
    if (!this.notificationEl) return;
    this._outgoingCall = true;
    window.simsigAPI.keys.setInCall(true);
    this._outgoingContactName = contactName;
    this._outgoingReplySent = false;
    this.notificationEl.classList.remove('hidden');
    this.notificationEl.classList.remove('flashing');
    this.notificationEl.classList.add('in-call');
    this.notificationTrainEl.textContent = contactName;
    if (this.notificationSignalEl) this.notificationSignalEl.textContent = '';
    if (this.notificationAnswerBtn) this.notificationAnswerBtn.textContent = '[Hang Up]';
    const icon = this.notificationEl.querySelector('#notification-icon');
    if (icon) icon.innerHTML = '&#128222;';
    // Mark the phone book row as in-call
    this._updatePhonebookInCall(contactName, true);
    this._syncToRemote();

    // Start background audio based on contact type
    this.bgCallerType = this.getCallerType(contactName, '');
    this.startBgNoise();

    // Show greeting in chat and speak it — they identify themselves
    const shortName = this.shortenCaller(contactName);
    const greeting = `Hello, ${shortName}`;
    this.addMessage({ type: 'driver', caller: shortName, text: greeting });
    await this.speakAsDriver(`Hello, ${shortName}?`, contactName);

    // Show the message from the caller if available
    if (message) {
      this.addMessage({ type: 'driver', caller: shortName, text: message });
      await this.speakAsDriver(message, contactName);
    }

    // Show reply options if available
    if (replies && replies.length > 0) {
      this._outgoingReplies = replies;
      this.addMessage({ type: 'reply-options', replies });
      this.setupOutgoingReplyClickHandlers(replies, contactName);

      // PTT voice reply loop (same pattern as incoming calls)
      const MAX_ATTEMPTS = 3;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (this._outgoingReplySent || !this._outgoingCall) return;
        this.addMessage({ type: 'greeting', text: 'Hold PTT and speak your reply...' });

        let transcript = '';
        try {
          transcript = await this.recordAndTranscribe();
        } catch (e) {
          if (this._outgoingReplySent || !this._outgoingCall) return;
          break;
        }
        if (this._outgoingReplySent || !this._outgoingCall) return;

        if (transcript) {
          console.log(`[PlaceCall] Heard: "${transcript}", matching against:`, replies);
          const replyIndex = this.matchReply(transcript, replies);
          console.log(`[PlaceCall] Match result: index=${replyIndex}`);
          if (replyIndex >= 0) {
            this._outgoingReplySent = true;
            await this.sendOutgoingReply(replyIndex, replies, contactName);
            return;
          }
        } else {
          console.log('[PlaceCall] No speech detected (empty transcript)');
        }

        // Not understood
        const sorry = 'Can you say again please';
        this.addMessage({ type: 'driver', caller: shortName, text: sorry });
        await this.speakAsDriver(sorry, contactName);
      }

      if (this._outgoingReplySent || !this._outgoingCall) return;
      // After max attempts, re-show clickable reply options
      this.addMessage({ type: 'reply-options', replies });
      this.setupOutgoingReplyClickHandlers(replies, contactName);
    }
  },

  setupOutgoingReplyClickHandlers(replies, contactName) {
    if (this._outgoingReplyHandler) {
      this.chatEl.removeEventListener('click', this._outgoingReplyHandler);
    }

    this._outgoingReplyHandler = (e) => {
      if (this._outgoingReplySent) return;

      const chip = e.target.closest('.wait-time-choice');
      if (chip) {
        this._outgoingReplySent = true;
        const idx = parseInt(chip.dataset.index, 10);
        this.sendOutgoingReply(idx, replies, contactName);
        return;
      }

      const li = e.target.closest('.reply-options-list li');
      if (li) {
        const replyIdx = parseInt(li.dataset.replyIndex, 10);
        if (replyIdx < 0) return;
        this._outgoingReplySent = true;
        this.sendOutgoingReply(replyIdx, replies, contactName);
      }
    };

    this.chatEl.addEventListener('click', this._outgoingReplyHandler);
  },

  // Generate a plausible confirmation response based on the reply text.
  // SimSig's Place Call dialog response text is in a TLabel which has no HWND
  // and no UI Automation exposure, so it cannot be read programmatically.
  generateConfirmationFromReply(replyText) {
    const lower = replyText.toLowerCase();
    if (/block.*signal|signal.*block/i.test(replyText)) return 'Ok, no problem, I will mark the line as blocked';
    if (/unblock|remove.*block|clear.*block/i.test(replyText)) return 'Right, I will remove the block now, thanks';
    if (/permission.*enter|enter.*section/i.test(replyText)) return 'Ok, permission granted, thank you';
    if (/proceed|continue/i.test(replyText)) return 'Ok, will do, thanks';
    if (/stop|hold|wait/i.test(replyText)) return 'Ok, no problem, I will hold them';
    if (/caution/i.test(replyText)) return 'Right, understood, will proceed with caution';
    if (/wrong.*line|wrong.*road/i.test(replyText)) return 'Oh right, ok, thanks for letting me know';
    return 'Ok, lovely, thanks';
  },

  // Check if a reply option needs a headcode parameter (e.g. "permission for train")
  replyNeedsHeadcode(replyText) {
    const lower = replyText.toLowerCase();
    return /train|permission|pass.*signal|hold.*back/i.test(lower);
  },

  // Reverse NATO map: spoken word → single character
  NATO_REVERSE: {
    alpha: 'A', bravo: 'B', charlie: 'C', delta: 'D', echo: 'E',
    foxtrot: 'F', golf: 'G', hotel: 'H', india: 'I', juliet: 'J',
    kilo: 'K', lima: 'L', leema: 'L', mike: 'M', november: 'N',
    oscar: 'O', papa: 'P', quebec: 'Q', romeo: 'R', sierra: 'S',
    tango: 'T', uniform: 'U', victor: 'V', whiskey: 'W', xray: 'X',
    'x-ray': 'X', yankee: 'Y', zulu: 'Z',
    zero: '0', one: '1', two: '2', three: '3', four: '4',
    five: '5', six: '6', seven: '7', eight: '8', nine: '9', niner: '9',
  },

  // Extract a headcode (e.g. 1F32) from spoken text
  // Handles NATO phonetics ("three echo nine zero" → "3E90") and direct text
  extractHeadcode(transcript) {
    // First, convert NATO phonetic words and number words to characters
    const words = transcript.toLowerCase().split(/[\s,.-]+/);
    let decoded = '';
    for (const w of words) {
      if (this.NATO_REVERSE[w]) {
        decoded += this.NATO_REVERSE[w];
      } else if (/^[0-9A-Za-z]$/.test(w)) {
        decoded += w.toUpperCase();
      }
      // skip unrecognised words
    }
    // Try headcode pattern on decoded NATO string
    const natoMatch = decoded.match(/([0-9][A-Z][0-9]{2})/);
    if (natoMatch) return natoMatch[1];

    // Direct match on original transcript: "1F32", "4M95" etc.
    const direct = transcript.match(/([0-9]\s*[A-Z]\s*[0-9]\s*[0-9])/i);
    if (direct) return direct[1].replace(/\s/g, '').toUpperCase();
    // Strip spaces and try again on the whole string
    const stripped = transcript.replace(/\s+/g, '');
    const stripped2 = stripped.match(/([0-9][A-Z][0-9]{2})/i);
    if (stripped2) return stripped2[1].toUpperCase();
    // If NATO decoding produced at least 4 chars, use that
    if (decoded.length >= 4) return decoded.slice(0, 4);
    // Return raw cleaned text as fallback
    return transcript.replace(/\s+/g, '').toUpperCase();
  },

  async sendOutgoingReply(replyIndex, replies, contactName) {
    const replyText = replies[replyIndex] || '';
    const shortName = this.shortenCaller(contactName);
    let headCode = '';

    // Check if the reply already contains a headcode
    const hcMatch = replyText.match(/([0-9][A-Z][0-9]{2})/i);
    if (hcMatch) {
      headCode = hcMatch[1].toUpperCase();
    } else if (this.replyNeedsHeadcode(replyText)) {
      // Ask the user for the headcode via conversation
      const askMsg = 'Ok, what is their headcode?';
      this.addMessage({ type: 'driver', caller: shortName, text: askMsg });
      await this.speakAsDriver(askMsg, contactName);

      // Wait for user to speak the headcode
      let gotHeadcode = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        this.addMessage({ type: 'greeting', text: 'Hold PTT and say the headcode...' });
        try {
          const transcript = await this.recordAndTranscribe();
          if (transcript) {
            headCode = this.extractHeadcode(transcript);
            this.addMessage({ type: 'signaller', text: transcript });
            // Validate: must be digit-letter-digit-digit (e.g. 3E90)
            if (headCode && /^[0-9][A-Z][0-9]{2}$/.test(headCode)) {
              gotHeadcode = true;
              break;
            }
            headCode = '';
          }
        } catch (e) {
          // PTT cancelled — try again
        }
        if (!this._outgoingCall) return;
        const retry = "I didn't catch that. Can you give me the headcode? It's a number, letter, then two numbers.";
        this.addMessage({ type: 'driver', caller: shortName, text: retry });
        await this.speakAsDriver(retry, contactName);
      }
      if (!gotHeadcode) headCode = '0000';
    }

    // Show what we're sending
    this.addMessage({ type: 'loading', text: 'Sending...' });

    // Send reply to SimSig via Place Call dialog (keyboard input)
    const result = await window.simsigAPI.phone.placeCallReply(replyIndex, headCode);
    console.log('[OutgoingReply] result:', JSON.stringify(result));

    // Remove loading spinner
    this.messages = this.messages.filter((m) => m.type !== 'loading');

    // Show what we selected as a signaller message
    const displayReply = headCode && !hcMatch
      ? `${replyText} — ${headCode}`
      : replyText;
    this.addMessage({ type: 'signaller', text: displayReply });

    // Show the real response from the Place Call dialog (TMemo), or fall back to generated
    let confirmation = '';
    if (result && result.response && result.response.trim()) {
      confirmation = result.response.trim();
    } else {
      confirmation = this.generateConfirmationFromReply(replyText);
    }
    this.addMessage({ type: 'driver', caller: shortName, text: confirmation });
    await this.speakAsDriver(confirmation, contactName);

    // Listen for goodbye — user says "ok thanks bye" etc., TTS replies "Bye"
    await this._listenForGoodbye(contactName);

    this.stopBgNoise();
  },

  async _listenForGoodbye(contactName) {
    while (this._outgoingCall) {
      this.addMessage({ type: 'greeting', text: 'Hold PTT to say goodbye...' });

      try {
        const transcript = await this.recordAndTranscribe();
        if (!this._outgoingCall) return;
        if (transcript) {
          // At the goodbye stage, any speech ends the call
          this.addMessage({ type: 'signaller', text: transcript });
          const goodbyes = [
            'Ok, speak later, bye.',
            'Thanks, bye now.',
            'Bye bye.',
            'Cheers, bye.',
            'Right, thanks, bye.',
            'Ok, bye now.',
            'Ok, thanks for that, bye.',
            'Right oh, bye.',
            'Ok, thank you, bye now.',
            'Very good, thanks, bye.',
          ];
          const reply = goodbyes[Math.floor(Math.random() * goodbyes.length)];
          this.addMessage({ type: 'driver', text: reply });
          await this.speakAsDriver(reply, contactName);
          this.endOutgoingCall();
          return;
        }
      } catch (e) {
        // PTT cancelled or error — loop back and try again
      }
    }
  },

  endOutgoingCall() {
    // Stop any TTS immediately
    this.stopTTS();

    // Click "Hang up and close" on the Place Call dialog
    window.simsigAPI.phone.placeCallHangup().catch(() => {});

    if (this._outgoingContactName) {
      this._updatePhonebookInCall(this._outgoingContactName, false);
    }
    this._outgoingCall = false;
    window.simsigAPI.keys.setInCall(false);
    this._outgoingContactName = '';
    this._outgoingReplySent = false;
    this._outgoingReplies = null;
    if (this._outgoingReplyHandler) {
      this.chatEl.removeEventListener('click', this._outgoingReplyHandler);
      this._outgoingReplyHandler = null;
    }
    this.stopBgNoise();
    this.bgCallerType = 'train';
    this.messages = [];
    this.renderChat();
    this.hideNotification(); // includes _syncToRemote()

    // Resume incoming call notification if calls are waiting
    this._resumeIncoming();
  },

  // Handle phonebook dial triggered from browser remote action
  async _handleRemoteDial(index, name) {
    this.showDialingNotification(name);
    const res = await window.simsigAPI.phone.dialPhoneBook(index);
    if (res.error) {
      this.stopDialing();
      return;
    }
    // Minimum ring time before first check
    await new Promise((r) => setTimeout(r, 3000));
    for (let i = 0; i < 30; i++) {
      if (!this._dialingActive) return;
      const status = await window.simsigAPI.phone.placeCallStatus();
      if (status.connected) {
        this.stopDialing(true);
        this.showOutgoingCallNotification(name, status.message, status.replies);
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    this.stopDialing();
  },

  // Re-show incoming call notification after 1s, start ringing after 2s
  _resumeIncoming() {
    if (this._resumeTimer) clearTimeout(this._resumeTimer);
    if (this._resumeRingTimer) clearTimeout(this._resumeRingTimer);
    this._resumeTimer = setTimeout(() => {
      this._resumeTimer = null;
      if (this.calls.length > 0 && !this.inCall && !this._outgoingCall && !this._dialingActive) {
        const nextCall = this.calls[this.calls.length - 1];
        this.showNotification(nextCall.train || '');
        this._resumeRingTimer = setTimeout(() => {
          this._resumeRingTimer = null;
          if (this.calls.length > 0 && !this.inCall && !this._outgoingCall && !this._dialingActive) {
            this.startRinging();
          }
        }, 1000);
      }
    }, 1000);
  },

  _updatePhonebookInCall(contactName, active) {
    const rows = document.querySelectorAll('.phonebook-item');
    rows.forEach((row) => {
      const label = row.querySelector('.phonebook-name');
      const icon = row.querySelector('.phonebook-dial-icon');
      if (label && label.textContent === contactName) {
        if (active) {
          if (icon) {
            icon.dataset.originalHtml = icon.innerHTML;
            icon.innerHTML = '';
            icon.textContent = 'In Call';
            icon.classList.add('in-call');
          }
        } else {
          if (icon) {
            icon.innerHTML = icon.dataset.originalHtml || '&#128222;';
            icon.classList.remove('in-call');
          }
        }
      }
    });
  },

  showInCallNotification(trainText) {
    if (!this.notificationEl) return;
    this.notificationEl.classList.remove('hidden');
    const match = (trainText || '').match(/([0-9][A-Z][0-9]{2})/i);
    const headcode = match ? match[1].toUpperCase() : this.shortenCaller(trainText || '');
    this.notificationEl.classList.remove('flashing');
    this.notificationEl.classList.add('in-call');
    this.notificationTrainEl.textContent = headcode;
    if (this.notificationSignalEl) this.notificationSignalEl.textContent = '';
    if (this.notificationAnswerBtn) this.notificationAnswerBtn.textContent = '[End Call]';
    const icon = this.notificationEl.querySelector('#notification-icon');
    if (icon) icon.innerHTML = '&#128643;';
    // Update radio display to In Call
    const radioDisplay = document.getElementById('radio-display');
    if (radioDisplay) radioDisplay.classList.add('in-call');
    const line1 = document.getElementById('display-line-1');
    const line2 = document.getElementById('display-line-2');
    if (line1) line1.textContent = 'In Call';
    if (line2) line2.textContent = headcode;
    this._syncToRemote();
  },

  showNotification(trainText) {
    if (!this.notificationEl) return;
    this.notificationEl.classList.remove('hidden');
    const match = trainText.match(/([0-9][A-Z][0-9]{2})/i);
    const headcode = match ? match[1].toUpperCase() : this.shortenCaller(trainText);
    this.notificationTrainEl.textContent = headcode;
    if (this.notificationSignalEl) this.notificationSignalEl.textContent = '';
    if (this.notificationAnswerBtn) this.notificationAnswerBtn.textContent = '[Answer]';
    const icon = this.notificationEl.querySelector('#notification-icon');
    if (icon) icon.innerHTML = '&#128643;';
    this.notificationEl.classList.add('flashing');
    this._syncToRemote();
  },

  // Full reset — called on disconnect to dump all state
  reset() {
    // End any active call or outgoing call
    this.stopTTS();
    this.stopBgNoise();
    this.stopRinging();
    this.stopDialing();

    if (this._outgoingContactName) {
      this._updatePhonebookInCall(this._outgoingContactName, false);
    }

    // Clear all call state
    this.calls = [];
    this.messages = [];
    this.inCall = false;
    this._isOkOnly = false;
    this.initReady = false;
    this._callSeq++;
    this._replyClicked = false;
    this._hasReplyOptions = false;
    this._replySent = false;
    this._hangUpLocked = false;
    this._activeCallTrain = '';
    this._activeCallVoiceKey = '';
    this.currentHeadCode = '';
    this.currentSignalId = null;
    this.isShunterCall = false;
    this.isSignallerCall = false;
    this.isThirdPartyCall = false;
    this.bgCallerType = 'train';
    this.gameTime = '';
    this.trainSignalCache = {};

    // Clear outgoing call state
    this._outgoingCall = false;
    this._outgoingContactName = '';
    this._outgoingReplySent = false;
    this._outgoingReplies = null;
    this._dialingActive = false;

    // Remove delegated click handlers
    if (this._replyDelegateHandler) {
      this.chatEl.removeEventListener('click', this._replyDelegateHandler);
      this._replyDelegateHandler = null;
    }
    if (this._outgoingReplyHandler) {
      this.chatEl.removeEventListener('click', this._outgoingReplyHandler);
      this._outgoingReplyHandler = null;
    }

    window.simsigAPI.keys.setInCall(false);

    // Reset UI
    this.renderCalls();
    this.renderChat();
    this.hideNotification();
  },

  hideNotification() {
    if (!this.notificationEl) return;
    this.notificationEl.classList.add('hidden');
    this.notificationEl.classList.remove('flashing');
    this.notificationEl.classList.remove('in-call');
    this.notificationTrainEl.textContent = '';
    if (this.notificationSignalEl) this.notificationSignalEl.textContent = '';
    if (this.notificationAnswerBtn) this.notificationAnswerBtn.textContent = '';
    if (this.notificationEl.querySelector('#notification-icon')) {
      this.notificationEl.querySelector('#notification-icon').textContent = '';
    }
    // Reset radio display
    const radioDisplay = document.getElementById('radio-display');
    if (radioDisplay) radioDisplay.classList.remove('in-call');
    const line1 = document.getElementById('display-line-1');
    const line2 = document.getElementById('display-line-2');
    if (line1) line1.textContent = 'GSM-R';
    if (line2) line2.textContent = 'Ready';
    this._syncToRemote();
  },

  // Sync chat/notification state to browser clients (host only)
  _syncToRemote() {
    if (this._isBrowser) return;
    if (!window.simsigAPI.phone.chatSync) return;
    window.simsigAPI.phone.chatSync({
      messages: this.messages,
      inCall: this.inCall,
      activeCallTrain: this._activeCallTrain || '',
      outgoingCall: this._outgoingCall || false,
      currentHeadCode: this.currentHeadCode || '',
      currentSignalId: this.currentSignalId || '',
      isShunterCall: this.isShunterCall || false,
      isSignallerCall: this.isSignallerCall || false,
      isThirdPartyCall: this.isThirdPartyCall || false,
      silenceBtnVisible: this.silenceBtn && !this.silenceBtn.classList.contains('hidden'),
      notification: this._getNotificationState(),
    });
  },

  _getNotificationState() {
    if (!this.notificationEl) return { type: 'hidden' };
    if (this.notificationEl.classList.contains('hidden')) return { type: 'hidden' };
    const icon = this.notificationEl.querySelector('#notification-icon');
    return {
      type: this.notificationEl.classList.contains('in-call') ? 'in-call'
        : this.notificationEl.classList.contains('flashing') ? 'flashing' : 'visible',
      trainText: this.notificationTrainEl ? this.notificationTrainEl.textContent : '',
      buttonText: this.notificationAnswerBtn ? this.notificationAnswerBtn.textContent : '',
      iconHtml: icon ? icon.innerHTML : '',
    };
  },

  _applyNotification(state) {
    if (!this.notificationEl) return;
    if (state.type === 'hidden') {
      this.notificationEl.classList.add('hidden');
      this.notificationEl.classList.remove('flashing', 'in-call');
      return;
    }
    this.notificationEl.classList.remove('hidden');
    this.notificationEl.classList.toggle('in-call', state.type === 'in-call');
    this.notificationEl.classList.toggle('flashing', state.type === 'flashing');
    if (this.notificationTrainEl) this.notificationTrainEl.textContent = state.trainText || '';
    if (this.notificationAnswerBtn) this.notificationAnswerBtn.textContent = state.buttonText || '';
    const icon = this.notificationEl.querySelector('#notification-icon');
    if (icon && state.iconHtml) icon.innerHTML = state.iconHtml;
  },

  renderChat() {
    if (this.messages.length === 0) {
      this.chatEl.innerHTML = '<div class="chat-empty">No messages yet</div>';
      return;
    }

    this.chatEl.innerHTML = this.messages.filter((m) =>
      m.type === 'driver' || m.type === 'reply-options' || m.type === 'loading' || m.type === 'greeting'
    ).map((msg) => {
      if (msg.type === 'greeting') {
        return `<div class="chat-message chat-greeting">
          <div class="chat-message-label">SPEAK NOW</div>
          <div class="chat-message-text">${this.escapeHtml(msg.text)}</div>
          ${msg.time ? `<div class="chat-message-time">${this.escapeHtml(msg.time)}</div>` : ''}
        </div>`;
      }
      if (msg.type === 'loading') {
        return `<div class="chat-message chat-loading">
          <div class="spinner"></div>
          <div class="chat-message-text">${this.escapeHtml(msg.text)}</div>
        </div>`;
      }
      if (msg.type === 'driver') {
        return `<div class="chat-message chat-driver">
          <div class="chat-message-caller">${this.escapeHtml(msg.caller)}</div>
          <div class="chat-message-text">${this.escapeHtml(msg.text)}</div>
          ${msg.time ? `<div class="chat-message-time">${this.escapeHtml(msg.time)}</div>` : ''}
        </div>`;
      }
      if (msg.type === 'reply-options') {
        const replies = msg.replies || [];
        const hc = this.currentHeadCode || '';
        const sig = this.currentSignalId || '';
        const sigRef = sig ? ` signal ${sig}` : '';

        // Group wait options into one line, keep others separate
        const waitIndices = [];
        const waitMins = [];
        const callBackIndices = [];
        const callBackMins = [];
        const otherReplies = [];
        replies.forEach((r, i) => {
          const wm = r.match(/wait\s+(\d+)\s*min/i);
          const cbm = r.match(/call\s*back\s+in\s+(\d+)\s*min/i);
          if (wm) {
            waitIndices.push(i);
            waitMins.push(wm[1]);
          } else if (cbm) {
            callBackIndices.push(i);
            callBackMins.push(cbm[1]);
          } else {
            otherReplies.push({ raw: r, index: i });
          }
        });

        const items = [];
        if (waitMins.length > 0) {
          const timeParts = waitMins.map((m) =>
            `<span class="wait-time-choice" data-index="${waitIndices[waitMins.indexOf(m)]}">${m}</span>`
          ).join(' / ');
          if (this.isSignallerCall) {
            items.push({ html: `Understood, they can expect to wait ${timeParts} minutes further. Phone me back if it is longer than that.`, replyIndex: -1 });
          } else if (this.isThirdPartyCall) {
            items.push({ html: `Ok, tell the driver to remain at${this.escapeHtml(sigRef)} and wait ${timeParts} minutes. Get them to phone back if the signal hasn't cleared.`, replyIndex: -1 });
          } else {
            const waitWho = this.isShunterCall ? 'Shunter' : 'Driver';
            items.push({ html: `${waitWho}, Correct. Remain at${this.escapeHtml(sigRef)} and wait ${timeParts} minutes before phoning back.`, replyIndex: -1 });
          }
        }
        if (callBackMins.length > 0) {
          const timeParts = callBackMins.map((m) =>
            `<span class="wait-time-choice" data-index="${callBackIndices[callBackMins.indexOf(m)]}">${m}</span>`
          ).join(' / ');
          if (this.isSignallerCall) {
            items.push({ html: `Give me ${timeParts} minutes. Phone me back after that.`, replyIndex: -1 });
          } else if (this.isThirdPartyCall) {
            items.push({ html: `Ok, get the driver to call back in ${timeParts} minutes.`, replyIndex: -1 });
          } else {
            const cbWho = this.isShunterCall ? 'Shunter' : 'Driver';
            items.push({ html: `${cbWho}, Please call back in ${timeParts} minutes.`, replyIndex: -1 });
          }
        }
        otherReplies.forEach((o) => {
          items.push({ html: this.escapeHtml(this.formatReplyOption(o.raw)), replyIndex: o.index });
        });

        const optionsHtml = items.map((item) => `<li data-reply-index="${item.replyIndex}">${item.html}</li>`).join('');
        return `<div class="chat-message chat-reply-options">
          <div class="chat-message-label">YOUR REPLY OPTIONS</div>
          <ol class="reply-options-list">${optionsHtml}</ol>
          ${msg.time ? `<div class="chat-message-time">${this.escapeHtml(msg.time)}</div>` : ''}
        </div>`;
      }
      return '';
    }).join('');

    this.chatEl.scrollTop = this.chatEl.scrollHeight;
  },

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },
};
