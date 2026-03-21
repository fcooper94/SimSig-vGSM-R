const PhoneCallsUI = {
  listEl: null,
  countEl: null,
  chatEl: null,
  calls: [],
  messages: [],
  ringAudio: null,
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
    this.commsOverlay = document.getElementById('comms-overlay');
    // Click on backdrop (outside panel) closes comms if not in an active call
    if (this.commsOverlay) {
      this.commsOverlay.addEventListener('click', (e) => {
        if (e.target === this.commsOverlay && !this.inCall && !this._outgoingCall && !this._dialingActive && !this._playerCall) {
          this.hideCommsOverlay();
        }
      });
    }
    // Force-close button (top-right X) with confirmation
    const commsCloseBtn = document.getElementById('comms-close-btn');
    if (commsCloseBtn) {
      commsCloseBtn.addEventListener('click', () => {
        ConnectionUI.showConfirm('Force Close', 'Force close this call? This will end the call in SimSig.', () => {
          this._callSeq++;
          this.hangUp({ forceClose: true });
        });
      });
    }
    this.notificationEl = document.getElementById('incoming-notification');
    this.notificationTrainEl = document.getElementById('notification-train');
    this.notificationAnswerBtn = document.getElementById('notification-answer-btn');
    this.noCallsEl = document.getElementById('no-calls-message');
    this.tabIncomingEl = document.getElementById('tab-incoming');
    this.silenceBtn = document.getElementById('silence-btn');
    this.silenced = false;
    this._browserModeActive = false;
    if (!this._isBrowser && window.simsigAPI?.settings?.get) {
      window.simsigAPI.settings.get('web.enabled').then(v => { this._browserModeActive = !!v; }).catch(() => {});
    }

    // ── Compact mode notification mirror ─────────────────────────────
    const compactNotif = document.getElementById('compact-notification');
    if (compactNotif && this.notificationEl) {
      const compactTrain = document.getElementById('compact-notif-train');
      const compactAction = document.getElementById('compact-notif-action');
      const syncCompact = () => {
        const isActive = this.notificationEl.classList.contains('flashing') || this.notificationEl.classList.contains('in-call');
        if (!isActive) {
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
        // Show/hide comms overlay to mirror host
        if (this.commsOverlay) {
          this.commsOverlay.classList.toggle('hidden', !state.commsVisible);
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
        } else if (this._playerAnswerHandler) {
          this._playerAnswerHandler();
        } else if (this.calls.length > 0) {
          window.simsigAPI.phone.remoteAction({ type: 'answer' });
        }
      });

      // Silence button — still forward to host
      if (this.silenceBtn) this.silenceBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.simsigAPI.phone.silenceRing();
      });

      // No audio, TTS, or keybind setup on browser
      this.renderChat();
      return; // Skip all host-only init below
    }

    // ── Host mode (Electron) ─────────────────────────────────────────

    // Text input event delegation (for free-text prompts like platform number)
    this.chatEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.classList.contains('chat-text-field') && this._textInputResolve) {
        e.preventDefault();
        const value = e.target.value.trim();
        if (!value) return;
        const resolve = this._textInputResolve;
        this._textInputResolve = null;
        this.messages = this.messages.filter((m) => m.type !== 'text-input');
        this.renderChat();
        resolve(value);
      }
    });
    this.chatEl.addEventListener('click', (e) => {
      // "use text" link — cancel PTT and switch to text input
      if (e.target.closest('.use-text-link')) {
        this._useTextInput = true;
        return;
      }
      const submitBtn = e.target.closest('.chat-text-submit');
      if (submitBtn && this._textInputResolve) {
        const input = this.chatEl.querySelector('.chat-text-field');
        const value = input ? input.value.trim() : '';
        if (!value) return;
        const resolve = this._textInputResolve;
        this._textInputResolve = null;
        this.messages = this.messages.filter((m) => m.type !== 'text-input');
        this.renderChat();
        resolve(value);
      }
    });

    // Ringing audio — play full file, 1s gap, repeat
    this.ringAudio = new Audio('../../sounds/ringing.wav');
    this.ringAudio.volume = 0.5; // default, overridden by saved setting below
    this._ringLooping = false;
    this._ringTimer = null;
    this.ringAudio.addEventListener('ended', () => {
      if (!this._ringLooping) return;
      this._ringTimer = setTimeout(() => {
        if (!this._ringLooping) return;
        this.ringAudio.currentTime = 0;
        this.ringAudio.play().catch(() => {});
      }, 1000);
    });

    // Apply saved ring output device
    window.simsigAPI.settings.getAll().then((s) => {
      if (s.audio?.ringDeviceId && s.audio.ringDeviceId !== 'default') {
        this.setRingDevice(s.audio.ringDeviceId);
      }
      if (s.audio?.ringVolume != null) {
        this.ringAudio.volume = s.audio.ringVolume / 100;
      }
    });

    // Silence ring for this call only — broadcast to all clients
    if (this.silenceBtn) this.silenceBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.simsigAPI.phone.silenceRing();
    });

    // Listen for silence events (from this client or remote clients)
    window.simsigAPI.phone.onSilenceRing(() => {
      this.silenced = true;
      this._stopRingSource();
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
      if (action.type === 'answer' && !this.inCall && !this._outgoingCall && this._playerAnswerHandler) {
        this._playerAnswerHandler();
      } else if (action.type === 'answer' && !this.inCall && !this._outgoingCall && this.calls.length > 0) {
        this.answerCall(action.index != null ? action.index : this.calls.length - 1);
      } else if (action.type === 'reply' && this.inCall && !this._replySent && !this._replyClicked) {
        this._replyClicked = true;
        if (this._isOkOnly) {
          this.sendOkAndHangUp(this._replyCaller || this._activeCallVoiceKey || '');
        } else if (this._replyReplies) {
          this.sendReply(action.replyIndex, this._replyReplies, this._replyCaller);
        }
      } else if (action.type === 'reply' && this._outgoingCall && !this._outgoingReplySent && !this._outgoingReplyProcessing) {
        this._outgoingReplyProcessing = true;
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
          if (this._outgoingReplies && this._outgoingReplies.length > 0 && !this._outgoingReplySent && !this._awaitingHeadcode) return;
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
      if (this._playerCall) {
        this.hangUpPlayerCall();
        return;
      }
      if (this._outgoingCall) {
        if (this._outgoingReplies && this._outgoingReplies.length > 0 && !this._outgoingReplySent && !this._awaitingHeadcode) return;
        this.endOutgoingCall();
      } else if (this.inCall) {
        if (this._hasReplyOptions && !this._replySent) return; // must reply first
        if (this._hangUpLocked) return; // reply/goodbye still in progress
        this.hangUp();
      } else if (this._playerAnswerHandler) {
        this._playerAnswerHandler();
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
      // Answer incoming player call
      if (this._playerAnswerHandler && !this.inCall && !this._outgoingCall && !this._playerCall) {
        this._playerAnswerHandler();
        return;
      }
      if (!this.inCall && !this._outgoingCall && this.calls.length > 0 && !this._dialingActive) {
        this.answerCall(this.calls.length - 1);
      }
    });

    // Global keybind: Hang Up
    window.simsigAPI.keys.onHangUp(() => {
      if (typeof SettingsUI !== 'undefined' && SettingsUI.isListeningForKeybind) return;
      if (typeof SettingsUI !== 'undefined' && !SettingsUI.modal.classList.contains('hidden')) return;
      // Hang up player call
      if (this._playerCall) {
        this.hangUpPlayerCall();
        return;
      }
      if (this._playerDialing) {
        window.simsigAPI.player.cancelDial();
        this._playerDialing = false;
        this.stopDialing();
        return;
      }
      if (this._dialingActive) {
        this.stopDialing();
        window.simsigAPI.phone.placeCallHangup();
        this.addMessage({ type: 'system', text: 'Call cancelled' });
        this._resumeIncoming();
        return;
      }
      if (this._outgoingCall) {
        if (this._outgoingReplies && this._outgoingReplies.length > 0 && !this._outgoingReplySent && !this._awaitingHeadcode) return;
        this.endOutgoingCall();
      } else if (this.inCall) {
        if (this._hasReplyOptions && !this._replySent) return;
        if (this._hangUpLocked) return; // reply/goodbye still in progress
        this.hangUp();
      }
    });

    // Gapless background noise via Web Audio API — alternate between two clips
    this.bgCtx = new AudioContext();
    this.bgCtx.suspend(); // keep suspended until a call starts, to avoid interfering with ringing
    this.bgBuffers = [];
    this.bgBufferIndex = 0;
    this.bgSignallerBuffer = null;
    this.bgYardBuffer = null;
    this.bgStationBuffer = null;
    this.bgTrainRunningBuffer = null;
    this.bgTracksideBuffer = null;
    this.bgSource = null;
    this.bgCallerType = 'train'; // 'train' | 'signaller' | 'yard' | 'station' | 'trainrunning' | 'trackside'
    this.bgGain = this.bgCtx.createGain();
    this.bgGain.connect(this.bgCtx.destination);
    this.bgGain.gain.value = 0.5;
    const bgFiles = ['../../sounds/background.wav', '../../sounds/background2.wav'];
    Promise.all(bgFiles.map((f) =>
      fetch(f).then((r) => r.arrayBuffer()).then((buf) => this.bgCtx.decodeAudioData(buf))
    )).then((buffers) => { buffers.forEach((b) => this._crossfadeBuffer(b)); this.bgBuffers = buffers; }).catch(() => {});
    fetch('../../sounds/signaller-background.wav')
      .then((r) => r.arrayBuffer())
      .then((buf) => this.bgCtx.decodeAudioData(buf))
      .then((buffer) => { this._crossfadeBuffer(buffer); this.bgSignallerBuffer = buffer; })
      .catch(() => {});
    fetch('../../sounds/yard-background.wav')
      .then((r) => r.arrayBuffer())
      .then((buf) => this.bgCtx.decodeAudioData(buf))
      .then((buffer) => { this._crossfadeBuffer(buffer); this.bgYardBuffer = buffer; })
      .catch(() => {});
    fetch('../../sounds/station-background.wav')
      .then((r) => r.arrayBuffer())
      .then((buf) => this.bgCtx.decodeAudioData(buf))
      .then((buffer) => { this._crossfadeBuffer(buffer); this.bgStationBuffer = buffer; })
      .catch(() => {});
    fetch('../../sounds/trainrunning-background.wav')
      .then((r) => r.arrayBuffer())
      .then((buf) => this.bgCtx.decodeAudioData(buf))
      .then((buffer) => { this._crossfadeBuffer(buffer); this.bgTrainRunningBuffer = buffer; })
      .catch(() => {});
    fetch('../../sounds/trackside-background.wav')
      .then((r) => r.arrayBuffer())
      .then((buf) => this.bgCtx.decodeAudioData(buf))
      .then((buffer) => { this._crossfadeBuffer(buffer); this.bgTracksideBuffer = buffer; })
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
    this._syncToRemote();
    if (this.isPaused() || !this.initReady) return;
    this._startRingSource();
  },

  stopRinging() {
    if (this._isBrowser) return; // no audio on browser
    this.wasRinging = false;
    this.silenced = false;
    this._syncToRemote();
    this._stopRingSource();
  },

  _startRingSource() {
    if (this._ringLooping) return; // already playing
    this._stopRingSource();
    if (!this.ringAudio) return;
    this._ringLooping = true;
    this.ringAudio.currentTime = 0;
    this.ringAudio.play().catch(() => {});
  },

  _stopRingSource() {
    this._ringLooping = false;
    if (this._ringTimer) { clearTimeout(this._ringTimer); this._ringTimer = null; }
    if (this.ringAudio) {
      this.ringAudio.pause();
      this.ringAudio.currentTime = 0;
    }
  },

  setRingDevice(deviceId) {
    if (this.ringAudio && this.ringAudio.setSinkId) {
      this.ringAudio.setSinkId(deviceId || 'default').catch((e) => {
        console.warn('[Phone] Could not set ring output device:', e.message);
      });
    }
  },

  // Silence all audio immediately (called when sim pauses)
  muteAll() {
    if (this._isBrowser) return; // no audio on browser
    this._stopRingSource();
  },

  // Resume ringing if calls are waiting (called when sim unpaused)
  resumeRinging() {
    if (this._isBrowser) return; // no audio on browser
    if (this.calls.length > 0 && this.wasRinging && !this.inCall && !this._outgoingCall && !this._dialingActive && !this.silenced) {
      this._startRingSource();
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
  // Convert HH:MM times to natural spoken English (12h) before phoneticize mangles them
  naturalizeTimes(text) {
    const ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
      'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
    const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty'];
    const toWords = (n) => {
      if (n < 20) return ones[n];
      return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '');
    };
    return text.replace(/\b(\d{1,2}):(\d{2})\b/g, (_, hStr, mStr) => {
      const h24 = parseInt(hStr, 10);
      const m = parseInt(mStr, 10);
      const h12 = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24;
      if (m === 0) return `${toWords(h12)} o'clock`;
      if (m < 10) return `${toWords(h12)} oh ${toWords(m)}`;
      return `${toWords(h12)} ${toWords(m)}`;
    });
  },

  // Words that should be spoken as words, not spelled out as acronyms
  TTS_WORDS: { 'MOM': 'Mom', '3BRIDGES': 'Three Bridges', 'NSW': 'New South Wales' },

  // Route Control callsigns by sim name
  ROUTE_CONTROL: {
    'Aston': 'Midlands Control',
    'Basingstoke Main': 'Wessex Control',
    'Birmingham New Street': 'Midlands Control',
    'Brighton': 'Sussex Control',
    'Cardiff': 'Wales Control',
    'Cardiff Vale Of Glamorgan': 'Wales Control',
    'Cardiff Valleys': 'Wales Control',
    'Carlisle': 'North West Control',
    'Cathcart': 'Scotland Control',
    'Central Coast NSW': 'Sydney Trains Control',
    'Central Scotland': 'Scotland Control',
    'Cheshire Lines': 'North West Control',
    'Chester': 'Wales Control',
    'Chicago L': 'CTA Operations Control Center',
    'Cornwall': 'Western Control',
    'Coventry': 'West Coast South Control',
    'Cowlairs': 'Scotland Control',
    'Crewe': 'North West Control',
    'Derby': 'Midlands Control',
    'Doncaster PSB (North)': 'East Coast Control',
    'Doncaster PSB (South)': 'East Coast Control',
    'Doncaster PSB (Station)': 'East Coast Control',
    'East Coastway': 'Sussex Control',
    'Edge Hill': 'North West Control',
    'Edinburgh': 'Scotland Control',
    'Euston': 'West Coast South Control',
    'Exeter': 'Western Control',
    'Feltham': 'Wessex Control',
    'Fenchurch': 'Anglia Control',
    'Hereford': 'Western Control',
    'HongKongEast': 'MTR Operations Control Centre',
    'Hope Valley': 'North West Control',
    'Horsham': 'Sussex Control',
    'Huddersfield': 'North & East Control',
    'Hunts Cross': 'North West Control',
    'Huyton & St Helens': 'North West Control',
    "King's Cross": 'East Coast Control',
    'Lancing': 'Sussex Control',
    'Leamington Spa & Fenny Compton': 'Midlands Control',
    'Leeds Ardsley': 'North & East Control',
    'Leeds EastWest': 'North & East Control',
    'Leeds Northwest': 'North & East Control',
    'Liverpool Lime Street': 'North West Control',
    'Liverpool Street Station': 'Anglia Control',
    'Llangollen': 'Wales Control',
    'London Bridge ASC': 'Kent Control',
    'LTS': 'Anglia Control',
    'LUL Victoria line': 'Victoria Line Service Control',
    'Maidstone East SB': 'Kent Control',
    'Manchester East': 'North West Control',
    'Manchester North': 'North West Control',
    'Manchester Piccadilly': 'North West Control',
    'Manchester South': 'North West Control',
    'Marylebone': 'West Coast South Control',
    'Moss Vale': 'Sydney Trains Control',
    'Motherwell': 'Scotland Control',
    'Newport': 'Wales Control',
    'North East Scotland': 'Scotland Control',
    'North East Wales': 'Wales Control',
    'North Kent': 'Kent Control',
    'North Wales Coast': 'Wales Control',
    'Norwich': 'Anglia Control',
    'Oxford': 'Western Control',
    'Oxted': 'Sussex Control',
    'Paisley': 'Scotland Control',
    'Peak District': 'North West Control',
    'Penrith & St Marys NSW': 'Sydney Trains Control',
    'Penzance': 'Western Control',
    'Peterborough': 'East Coast Control',
    'Plymouth': 'Western Control',
    'Port Talbot': 'Wales Control',
    'Portsmouth': 'Wessex Control',
    'Royston': 'Anglia Control',
    'Rugby SCC 1+2 (South)': 'West Coast South Control',
    'Rugby SCC 3+4 (Centre)': 'West Coast South Control',
    'Rugby SCC 5+6 (North)': 'West Coast South Control',
    'Salisbury': 'Wessex Control',
    'Saltley': 'Midlands Control',
    'Sandhills IECC (Merseyrail)': 'Merseyrail Control',
    'Sheffield': 'North & East Control',
    'Shrewsbury': 'Wales Control',
    'Slough Panel': 'Western Control',
    'Stafford': 'West Coast South Control',
    'Staffordshire': 'West Coast South Control',
    'Stockport': 'North West Control',
    'Stourbridge Jn': 'Midlands Control',
    'Strathfield': 'Sydney Trains Control',
    'Swindon A & B IECC': 'Western Control',
    'Sydney Box': 'Sydney Trains Control',
    'Sydney North': 'Sydney Trains Control',
    'Telford & Oxley': 'West Coast South Control',
    'Three Bridges ASC': 'Sussex Control',
    'Tyneside IECC': 'East Coast Control',
    'Victoria Central': 'Kent Control',
    'Victoria South Eastern': 'Kent Control',
    'Walsall': 'Midlands Control',
    'Warrington PSB': 'North West Control',
    'Waterloo': 'Wessex Control',
    'Watford Jn': 'West Coast South Control',
    'Wembley Mainline': 'West Coast South Control',
    'Wembley Suburban': 'West Coast South Control',
    'West Anglia': 'Anglia Control',
    'West Hampstead': 'Anglia Control',
    'West Yorkshire': 'North & East Control',
    'Westbury': 'Western Control',
    'Wigan Wallgate': 'North West Control',
    'Wimbledon': 'Wessex Control',
    'Woking ASC': 'Wessex Control',
    'Wolverhampton': 'West Coast South Control',
    'York North and South': 'East Coast Control',
  },

  // Look up route control callsign for the current sim
  getRouteControl() {
    const panel = this.currentPanelName || '';
    // Exact match first
    if (this.ROUTE_CONTROL[panel]) return this.ROUTE_CONTROL[panel];
    // Fuzzy: check if panel starts with or contains a key
    const lp = panel.toLowerCase();
    for (const [key, val] of Object.entries(this.ROUTE_CONTROL)) {
      if (lp.startsWith(key.toLowerCase()) || key.toLowerCase().startsWith(lp)) return val;
    }
    return null;
  },

  phoneticize(text) {
    text = this.naturalizeTimes(text);
    // Strip portion suffixes from headcodes (e.g. "2K12-1" → "2K12")
    text = text.replace(/\b([0-9][A-Za-z][0-9]{2})-\d+\b/g, '$1');
    return text.replace(/\b[A-Z0-9]{2,}\b/gi, (match) => {
      // Check exception list — words that TTS should say as words
      if (this.TTS_WORDS[match.toUpperCase()]) return this.TTS_WORDS[match.toUpperCase()];
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
  // Cached by headcode so the same train always gets the same voice within a session
  getTTSVoiceId(caller, voices) {
    // All outgoing calls share the same voice for the session
    const cacheKey = this._outgoingCall ? '_outgoing' : (this._activeCallVoiceKey || this.currentHeadCode || caller);
    if (this.voiceCache[cacheKey]) return this.voiceCache[cacheKey];
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
    this.voiceCache[cacheKey] = voice.id;
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
    if (this.bgCtx.state === 'suspended') this.bgCtx.resume();
    let buffer;
    if (this.bgCallerType === 'yard' && this.bgYardBuffer) {
      buffer = this.bgYardBuffer;
    } else if (this.bgCallerType === 'station' && this.bgStationBuffer) {
      buffer = this.bgStationBuffer;
    } else if (this.bgCallerType === 'trainrunning' && this.bgTrainRunningBuffer) {
      buffer = this.bgTrainRunningBuffer;
    } else if (this.bgCallerType === 'trackside' && this.bgTracksideBuffer) {
      buffer = this.bgTracksideBuffer;
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
    this.bgGain.gain.value = this.bgCallerType === 'trackside' ? 0.25 : 0.5;
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
    setTimeout(() => {
      try { src.stop(); } catch {}
      if (!this.bgSource && this.bgCtx) this.bgCtx.suspend();
    }, 600);
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
      const voiceKey = this._activeCallVoiceKey || caller;
      const hash = this.hashString(voiceKey);

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'en-GB';
      utterance.voice = pool[hash % pool.length] || null;
      utterance.pitch = 0.7 + ((hash >> 4) % 100) / 100 * 0.6;
      utterance.rate = 1.0 + ((hash >> 8) % 100) / 100 * 0.2;

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
    let headcode, entryPoint, signal;

    // Format 1: "5A20 is ready at entry point Farnham CSD (WK440), scheduled 07:16."
    const fmt1 = msg.match(/(\w+)\s+is ready at entry point\s+(.+?)\s*\((\w+)\)/i);
    // Format 2: "6Y72 is ready at entry point 3Bridges T1210/TD132, scheduled 14:10."
    const fmt2 = !fmt1 ? msg.match(/(\w+)\s+is ready at entry point\s+(.+?)\s+([\w]+\/[\w]+)/i) : null;

    if (fmt1) {
      headcode = fmt1[1];
      entryPoint = fmt1[2].trim();
      signal = fmt1[3];
    } else if (fmt2) {
      headcode = fmt2[1];
      entryPoint = fmt2[2].trim();
      signal = fmt2[3];
    } else {
      return null;
    }

    // Extract scheduled time
    const schedMatch = msg.match(/scheduled\s+(\d{1,2}:\d{2})/i);
    const scheduled = schedMatch ? schedMatch[1] : '';

    // Route line: "07+17 Farnham CSD - Farnham (SWR 12 450)"
    const routeMatch = msg.match(/\d{2}\+\d{2}\s+.+?\s*-\s*(.+?)\s*\(/);
    const nextStop = routeMatch ? routeMatch[1].trim() : '';

    // Platform from timetable detail line: "Farnham 07:25    07:25    1"
    let platform = '';
    for (const line of msg.split('\n')) {
      const platMatch = line.match(/\d{2}:\d{2}\s+\d{2}:\d{2}\s+(\d+)/);
      if (platMatch) { platform = platMatch[1]; break; }
    }

    return { headcode, entryPoint, signal, nextStop, platform, scheduled };
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
      let msg;
      if (csd.signal.includes('/')) {
        // Format 2: "6Y72 is ready at entry point 3Bridges T1210/TD132, scheduled 14:10."
        msg = `Hello Signaller. This is the Shunter at ${csd.entryPoint}. I have ${csd.headcode} at entry point ${csd.signal} who is ready`;
        if (csd.scheduled) msg += `. Scheduled at ${csd.scheduled}`;
        msg += `. Request permission for them to enter`;
      } else {
        // Format 1: "5A20 is ready at entry point Farnham CSD (WK440), scheduled 07:16."
        msg = `Hello, ${panelName} Signaller, this is the Shunter within ${csd.entryPoint}. I have ${csd.headcode} at ${sigRef}. Request permission to enter`;
        if (csd.scheduled) msg += `. Scheduled at ${csd.scheduled}`;
      }
      if (csd.nextStop) {
        msg += `. Their next stop will be ${csd.nextStop}`;
        if (csd.platform) msg += ` Platform ${csd.platform}`;
      }
      return msg;
    }
    const posStr = position ? `, ${position}` : '';
    let msg = `Hello, ${panelName} Signaller${posStr}, this is driver of ${csd.headcode} at ${sigRef} within ${csd.entryPoint}. Request permission to enter`;
    if (csd.scheduled) msg += `. Scheduled at ${csd.scheduled}`;
    if (csd.nextStop) {
      msg += `, next stop will be ${csd.nextStop}`;
      if (csd.platform) msg += ` Platform ${csd.platform}`;
    }
    return msg;
  },

  // Shorten a caller name to at most 4 words, stripping parenthesised suffixes
  shortenCaller(name) {
    const short = name.replace(/\s*\([^)]*\)\s*/g, '').replace(/\s*\/.*$/, '').trim();
    // Strip portion suffixes from headcodes (e.g. "2K12-1" → "2K12")
    const cleaned = short.replace(/\b([0-9][A-Za-z][0-9]{2})-\d+\b/g, '$1');
    const words = cleaned.split(/\s+/);
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

  // Parse crew waiting messages — crew ready at station waiting for train to arrive
  // "Crew for 7V81 is ready and waiting for the train to arrive at East Croydon.."
  parseCrewWaitingMessage(msg) {
    const match = msg.match(/Crew for (\w+) is ready and waiting for the train to arrive at (.+?)\.{1,2}/i);
    if (!match) return null;
    return { headcode: match[1], location: match[2].trim() };
  },

  // Parse delay messages — driver reporting delayed at a location with a reason
  // "1C51 delayed at Three Bridges due to a technical fault, expected to depart at about 14:15"
  parseDelayMessage(msg) {
    const match = msg.match(/(\w+)\s+(?:is\s+)?delayed at\s+(.+?)\s+due to\s+(.+?)\s*(?:[,\.]\s*(?:expected to|expect to)\s+depart\s+(?:at\s+)?(?:about\s+)?(\d{1,2}:?\d{2})|$)/i);
    if (!match) return null;
    return { headcode: match[1], location: match[2].trim(), reason: match[3].trim(), departTime: match[4] || null };
  },

  // Parse route query messages — driver querying the route set at a signal
  // "Driver of 5M04 is querying the route set at signal VC662: booked via Balham"
  parseRouteQueryMessage(msg) {
    const match = msg.match(/querying the route set at signal\s+([A-Z0-9]+):\s*booked via\s+(.+)/i);
    if (!match) return null;
    return { signal: match[1], bookedVia: match[2].trim() };
  },

  // Parse technician "fixed" reports — signal/points/track section failure fixed
  // "Signal failure in the Interlocking ST (Selhurst) area fixed."
  // "Points failure at East Croydon fixed."
  // "Track section failure in the Selhurst area fixed."
  parseFixedReport(msg) {
    const match = msg.match(/(Signal failure|Points failure|Track section failure)\s+(?:in\s+(?:the\s+)?|at\s+)(.+?)\s*(?:area\s+)?fixed/i);
    if (!match) return null;
    return { type: match[1], location: match[2].replace(/\s*\([^)]*\)\s*$/, '').trim() };
  },

  // Parse "ready to depart" messages — driver resolved difficulties, now ready
  // "Ok, 2B10 is ready to depart"
  // "2S09 has resolved its difficulties and is now ready to depart from Clapham Junction (Windsor)"
  parseReadyToDepart(msg) {
    const match = msg.match(/(\w+).*?\bis\s+(?:now\s+)?ready\s+to\s+depart(?:\s+from\s+(.+?))?(?:\s*[,.]|$)/i);
    if (!match) return null;
    return { headcode: match[1], location: match[2] ? match[2].trim() : null };
  },

  // Keyword patterns for matching user speech to SimSig reply options
  // Order matters — more specific patterns first
  REPLY_MATCHERS: [
    // Crew waiting reply
    { pattern: /thank.*update|update.*driver/, fragment: 'crew for' },
    // Delay call replies (raw SimSig: "Ok, Driver, the signal will be replaced" / "OK, the signal will not be replaced")
    { pattern: /understood.*delayed|delayed.*understood/, fragment: 'delayed' },
    { pattern: /change.*aspect|expect.*change|aspect|replace|yes/, fragment: 'will be replaced', reject: 'will not be replaced' },
    { pattern: /thank.*driver|no\s*change|won'?t\s*change/, fragment: 'will not be replaced' },
    { pattern: /no.*(?:change|aspect|replaced)/, fragment: 'not be replaced' },
    { pattern: /no\s*obstruction|continue\s*normally/, fragment: 'no obstruction' },
    // Unlit signal — pass + examine (must be before generic pass+examine)
    { pattern: /pass.*unlit.*examine|unlit.*examine/, fragment: 'pass unlit signal and examine' },
    { pattern: /pass.*examine|authoris[ez].*pass.*examine|authoris[ez].*examine/, fragment: 'pass signal' },
    { pattern: /continue\s*examin/, fragment: 'continue examining' },
    // Route query / wrong route replies
    { pattern: /unable.*continue|can'?t.*continue|due to.*route/, fragment: 'unable to continue' },
    { pattern: /abandon.*timetable|timetable.*abandon/, fragment: 'abandon timetable' },
    { pattern: /bypass/, fragment: 'bypass' },
    { pattern: /change.*route|route.*change/, fragment: 'wait' },
    { pattern: /(?:15|fifteen|one[\s-]*five|1[\s-]*5)\s*min/, fragment: '15 minute' },
    { pattern: /(?<!\d)(?:0?2|two|to)\s*min/, fragment: '2 minute' },
    { pattern: /(?<!\d)(?:0?5|five)\s*min/, fragment: '5 minute' },
    { pattern: /booked\s*time|running\s*early|hold.*until/, fragment: 'booked' },
    { pattern: /wait/, fragment: '2 minute' },  // bare "wait" defaults to 2 min
    { pattern: /pass.*unlit|unlit.*pass/, fragment: 'pass unlit signal' },
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
    { pattern: /\bok\b|thanks|thank\s*you|cheers/, fragment: 'will not be replaced' },
  ],

  // "danger" and "stop" are interchangeable in SimSig signalling terminology
  SYNONYMS: [['danger', 'stop']],

  // Mock call data for the test call simulator (Ctrl+Shift+T)
  TEST_CALLS: {
    red_signal: {
      train: '3A90', title: 'Answer call from Driver (3A90)',
      message: 'I am at signal WK203 displaying red',
      replies: ['Wait 2 minutes for signal to show proceed before phoning back', 'Wait 5 minutes for signal to show proceed before phoning back', 'Wait 15 minutes for signal to show proceed before phoning back', 'Authorise driver to pass signal at stop', 'Ask driver to examine the line', 'Ask driver to pass signal at stop and examine the line'],
    },
    delay: {
      train: '1C51', title: 'Answer call from Driver (1C51)',
      message: '1C51 delayed at Three Bridges due to a technical fault, expected to depart at about 14:15',
      replies: ['Ok, 1C51 delayed', 'Yes, signal will be replaced', 'No, signal will not be replaced'],
    },
    csd: {
      train: '5A20', title: 'Answer call from Shunter (Brighton CSD)',
      message: '5A20 is ready at entry point Brighton CSD (WK440), scheduled 07:16.\n07+17 Brighton CSD - Hove (SWR 12 450)\n    Hove 07:25    07:25    1',
      replies: ['Permission granted for 5A20 to enter', 'Call back in 5 minutes'],
    },
    csd_entry: {
      train: '6Y72', title: 'Answer call from Shunter (Panel 4 (Three Bridges))',
      message: '6Y72 is ready at entry point 3Bridges T1210/TD132, scheduled 14:10.\n14:10    Three Bridges TL Up Depot-Dollands Moor (GBRF) ZZ (GBRF (6) 66 + 2\n    3Bridges Up TL NX 14:13    14:15    132    SL --- ---',
      replies: ['Permission granted for 6Y72 to enter', 'Please call back in 2 minutes', 'Please call back in 5 minutes', 'Please call back in 15 minutes'],
    },
    ready_at: {
      train: '5N53', title: 'Answer call from Driver (5N53)',
      message: '5N53 is ready at Wall Sidings',
      replies: ['Ok', 'Call back in 5 minutes'],
    },
    signaller: {
      train: '1L33', title: 'Answer call from Exeter Signaller',
      message: 'I have 1L33 waiting at Honiton',
      replies: ['Ok', 'Wait 5 minutes', 'Wait 15 minutes'],
    },
    red_signal_early: {
      train: '4Q08', title: 'Answer call from Train 4Q08 (Panel 4)',
      message: 'Driver of 4Q08 waiting at red signal VC833',
      replies: ['Wait 2 minutes for signal to show proceed before phoning back', 'Wait 5 minutes for signal to show proceed before phoning back', 'Wait 15 minutes for signal to show proceed before phoning back', 'Authorise driver to pass signal at stop', 'Ask driver to examine the line', 'Ask driver to pass signal at stop and examine the line', 'Wait for booked 05:07 for signal to show proceed before phoning back'],
    },
    early_run: {
      train: '4022', title: 'Answer call from Aynho Signaller',
      message: 'I have 4022 running early via Aynho Junction.\nIt can be in your area at about 05:00 if I let it continue.\nDo you want me to hold it until its booked time of 05:22?',
      replies: ['No, let 4022 run early', 'Please hold 4022 back'],
    },
    crew_waiting: {
      train: '7V81', title: 'Answer call from Crew for 7V81',
      message: 'Crew for 7V81 is ready and waiting for the train to arrive at East Croydon.. The crews will change over, any activities at that location will be performed including minimum dwell times, and then the train will be ready to depart.',
      replies: ['Ok, crew for 7V81 is ready and waiting for the train to arrive at East Croydon.'],
    },
    adverse_aspect: {
      train: '2W50', title: 'Answer call from Train 2W50 (Panel 1)',
      message: 'Driver of 2W50 reporting an adverse change of aspect at signal 32',
      replies: ['Driver, please continue after speaking to your control'],
    },
    unlit_signal: {
      train: '2W89', title: 'Answer call from Train 2W89 (Panel 2 (Purley))',
      message: 'Driver of 2W89 waiting at unlit signal T151',
      replies: ['Wait 2 minutes before phoning back', 'Wait 5 minutes before phoning back', 'Wait 15 minutes before phoning back', 'Authorise driver to pass unlit signal', 'Ask driver to pass unlit signal and examine the line'],
    },
    examine: {
      train: '3A90', title: 'Answer call from Driver (3A90)',
      message: 'After examining the line, no obstruction was found',
      replies: ['Ok, no obstruction found, continue normally', 'Continue examining the line'],
    },
    wrong_route: {
      train: '5M04', title: 'Answer call from Train 5M04 (Panel 2B)',
      message: 'Driver of 5M04 is querying the route set at signal VC662: booked via Balham',
      replies: ['Wait 5 minutes (signal may be replaced without penalty) before phoning back', 'Abandon timetable'],
    },
    fixed_report: {
      train: 'Technician', title: 'Answer call from Technician (Panel 1C (Selhurst))',
      message: 'Signal failure in the Interlocking ST (Selhurst) area fixed.',
      replies: ['Ok, signal failure in the Interlocking ST (Selhurst) area fixed.'],
    },
    ready_to_depart: {
      train: '2B10', title: 'Answer call from Driver (2B10)',
      message: 'Ok, 2B10 is ready to depart',
      replies: ['Ok, 2B10 is ready to depart'],
    },
  },

  simulateCall(type) {
    const mock = this.TEST_CALLS[type];
    if (!mock) return;
    // Add mock call to the list and trigger answer flow
    this.calls.push({ train: mock.train, status: 'Unanswered' });
    this.renderCalls();
    this._simulateResult = { ...mock };
    this.answerCall(this.calls.length - 1);
  },

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
          const idx = replies.findIndex((r) => {
            const rLower = r.toLowerCase();
            return rLower.includes(frag) && (!matcher.reject || !rLower.includes(matcher.reject));
          });
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

  // Wait for PTT press, record audio, then transcribe via Whisper (Chatterbox server)
  async recordAndTranscribe() {
    try {
      await this.waitForPTTPress();
      if (this.bgGain) this.bgGain.gain.value = 0;

      console.log('[STT] PTT pressed — recording audio...');
      const audioData = await this._recordPCMWhilePTT();
      if (this.bgGain) this.bgGain.gain.value = 0.5;

      if (!audioData || audioData.length === 0) {
        console.log('[STT] No audio recorded');
        return '';
      }

      // Send to Whisper via main process
      console.log(`[STT] Sending ${audioData.length} samples to Whisper...`);
      const result = await window.simsigAPI.stt.transcribe([...audioData]);

      if (result && typeof result === 'object' && result.error) {
        console.error('[STT] Whisper error:', result.error);
        return '';
      }
      const text = (typeof result === 'string' ? result : result?.text || '').trim();
      console.log(`[STT] Whisper result: "${text}"`);
      return text;
    } catch (err) {
      if (this.bgGain) this.bgGain.gain.value = 0.5;
      if (err.message === 'reply_clicked' || err.message === 'use_text') throw err;
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
      if (this._replyClicked || (this._outgoingCall && this._outgoingReplyProcessing)) { reject(new Error('reply_clicked')); return; }
      if (this._useTextInput) { reject(new Error('use_text')); return; }
      if (typeof PTTUI !== 'undefined' && PTTUI.isActive) { console.log('[PTT] Already active — resolving immediately'); resolve(); return; }
      console.log(`[PTT] Waiting for PTT press... (keybind=${typeof PTTUI !== 'undefined' ? PTTUI.keybind : 'N/A'}, inCall=${this.inCall})`);
      const check = () => {
        if (this._replyClicked || (this._outgoingCall && this._outgoingReplyProcessing)) { reject(new Error('reply_clicked')); return; }
        if (this._useTextInput) { reject(new Error('use_text')); return; }
        if (typeof PTTUI !== 'undefined' && PTTUI.isActive) {
          console.log('[PTT] PTT detected!');
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

    // Technician fixed report — failure resolved
    if (/(?:signal|points|track\s*section)\s*failure.*fixed/i.test(raw)) {
      return 'Good news. Thanks for your help. I shall commence normal working';
    }

    // Third-party calls (token hut, ground frame, etc.) — talk about the driver, not to them
    if (this.isThirdPartyCall) {
      if (/ok.*no\s*obstruction/i.test(raw)) {
        return `Ok, thank you. No obstructions found`;
      }
      if (/pass.*unlit.*signal.*examine|ask.*pass.*unlit.*examine/i.test(raw)) {
        return `Ok, the driver of ${hc} is authorised to pass${sigRef} in its unlit state. Tell them to proceed at caution and examine the line. They need to report any obstructions`;
      }
      if (/authoris[ez].*pass.*unlit|pass.*unlit.*signal/i.test(raw)) {
        return `Ok, the driver of ${hc} is authorised to pass${sigRef} in its unlit state. Tell them to proceed at caution to the next signal`;
      }
      if (/pass.*signal.*at\s*stop.*examine|pass.*signal.*danger.*examine|authoris[ez].*pass.*examine|ask.*pass.*examine/i.test(raw)) {
        return `Ok, the driver of ${hc} is authorised to pass${sigRef} at danger. Tell them to proceed at caution and continue to examine the line. They need to report any obstructions`;
      }
      if (/authoris[ez].*pass.*signal|ask.*pass.*signal|pass.*signal.*at\s*stop/i.test(raw)) {
        return `Ok, the driver of ${hc} is authorised to pass${sigRef} at danger. Tell them to proceed at caution to the next signal and be prepared to stop short of any obstruction`;
      }
      if (/continue\s*examin/i.test(raw)) {
        return `Ok, tell the driver to continue examining the line and report further`;
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

    // Ready to depart reply — driver resolved difficulties
    if (/ok.*is\s+ready\s+to\s+depart/i.test(raw)) {
      return `Hello ${hc}, I understand you are now ready to depart. Thanks, Signaller out`;
    }

    // Crew waiting reply
    if (/ok.*crew for.*ready and waiting/i.test(raw)) {
      return 'Thank you for the update driver';
    }

    // Delay call replies
    if (/ok.*\w+\s+delayed/i.test(raw)) {
      const reason = this._delayReason || 'a delay';
      return `Thanks Driver, understood you are delayed due to ${reason}`;
    }
    if (/yes.*signal\s+will\s+be\s+replaced/i.test(raw)) {
      return 'Thank you driver, you can expect a change of aspect';
    }
    if (/no.*signal\s+will\s+not\s+be\s+replaced/i.test(raw)) {
      return 'Thank you driver';
    }
    // "Ok, no obstruction found" — acknowledge examine line result
    if (/ok.*no\s*obstruction/i.test(raw)) {
      return `Thanks Driver, I copy that no obstructions were found`;
    }
    // Unlit signal — pass in unlit state + examine line
    if (/pass.*unlit.*signal.*examine|ask.*pass.*unlit.*examine/i.test(raw)) {
      return `Driver of ${hc}, this is${panelRef}. We have a signal lamp failure here at${sigRef}. I am authorising you to pass${sigRef} in its unlit state. Proceed at caution to the next signal and examine the line. Report any obstructions`;
    }
    // Unlit signal — pass in unlit state only
    if (/authoris[ez].*pass.*unlit|pass.*unlit.*signal/i.test(raw)) {
      return `Driver of ${hc}, this is${panelRef}. We have a signal lamp failure here at${sigRef}. I am authorising you to pass${sigRef} in its unlit state. Proceed at caution to the next signal`;
    }
    // Pass signal at danger AND continue examining the line
    if (/pass.*signal.*at\s*stop.*examine|pass.*signal.*danger.*examine|authoris[ez].*pass.*examine|ask.*pass.*examine/i.test(raw)) {
      return `Driver of ${hc}, this is${panelRef}. I am authorising you to pass${sigRef} at danger. Proceed at caution to the next signal and be prepared to stop short of any obstruction. Please continue to examine the line and report further`;
    }
    // Pass signal at danger only
    if (/authoris[ez].*pass.*signal|ask.*pass.*signal|pass.*signal.*at\s*stop/i.test(raw)) {
      return `Driver of ${hc}, this is${panelRef}. I am authorising you to pass${sigRef} at danger. Proceed at caution to the next signal and be prepared to stop short of any obstruction`;
    }
    // Continue examining the line (no pass at danger)
    if (/continue\s*examin/i.test(raw)) {
      return `Thanks Driver, can you continue to examine the line and report further`;
    }
    // Examine the line only (initial request)
    if (/ask.*examine|examine\s*the\s*line/i.test(raw)) {
      return `${hc}, I need you to examine the line between${sigRef} and the next signal. Proceed at caution and report any obstructions`;
    }
    // Route query replies — wrong route, driver booked via somewhere else
    if (this.isRouteQuery) {
      const rqWait = raw.match(/wait\s+(\d+)\s*min/i);
      if (rqWait) {
        return `Hello driver of ${hc} standing at${sigRef} signal. Please remain at ${sig} and wait ${rqWait[1]} minutes. The route will be set so you can pass via ${this._routeQueryVia || 'your booked location'}`;
      }
      if (/abandon\s*timetable/i.test(raw)) {
        return `Hello driver of ${hc} standing at${sigRef} signal. I am advised by route control that you are to abandon your timetable`;
      }
      const bypassMatch = raw.match(/bypass\s+(.+?)\s+and\s+then\s+keep\s+to\s+timetable/i);
      if (bypassMatch) {
        return `Hello driver of ${hc} standing at${sigRef} signal. I am advised by route control that you are to bypass ${bypassMatch[1]} and continue with the remainder of your timetable`;
      }
    }
    // Wait N minutes
    const waitMatch = raw.match(/wait\s+(\d+)\s*min/i);
    if (waitMatch) {
      return `Hello ${hc}, standing at${sigRef}, showing red. Please wait ${waitMatch[1]} minutes`;
    }
    // "Driver, please continue after speaking to your control"
    if (/continue\s+after\s+speaking/i.test(raw)) {
      if (this.isAdverseAspect) {
        return `Hello Driver. Please continue and obey all other signals`;
      }
      return `${hc}, understood. Continue normally unless otherwise instructed`;
    }
    // "Permission granted for 5A20 to enter"
    const permMatch = raw.match(/permission\s+granted\s+for\s+(\w+)\s+to\s+enter/i);
    if (permMatch) {
      if (this.isShunterCall) return `Ok, ${permMatch[1]} has permission to enter. Thank you Signaller`;
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
      return `Can you hold ${holdBackMatch[1]} back until their booked time`;
    }
    // "Please call back in N minutes"
    const callBackMatch = raw.match(/call\s*back\s+in\s+(\d+)\s*min/i);
    if (callBackMatch) {
      if (this.isShunterCall) return `Hello Shunter, call back in ${callBackMatch[1]} minutes`;
      return `Driver, please call back in ${callBackMatch[1]} minutes`;
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
    console.log('[Phone] buildConfirmation rawReply:', JSON.stringify(replyText));
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
      if (/pass.*unlit.*examine|lamp failure.*examine/i.test(lower)) {
        return `Ok, I will let the driver know they are authorised to pass${sigRef} in its unlit state and to examine the line`;
      }
      if (/pass.*unlit|lamp failure/i.test(lower)) {
        return `Ok, I will tell the driver they are authorised to pass${sigRef} in its unlit state`;
      }
      if (/pass.*signal.*at\s*(stop|danger).*examine/i.test(lower) || /pass.*at\s*danger.*continue.*examine/i.test(lower)) {
        return `Ok, I will let the driver know they are authorised to pass${sigRef} at danger and to continue examining the line`;
      }
      if (/pass.*signal.*at\s*(stop|danger)/i.test(lower)) {
        return `Ok, I will tell the driver they are authorised to pass${sigRef} at danger`;
      }
      if (/no\s*obstruction/i.test(lower)) {
        return 'Ok, I will let them know. No obstructions found';
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

    // "No obstructions found" — examine result acknowledgement
    if (/no\s*obstruction/i.test(lower)) {
      return `Understood, no obstructions${trainRef}`;
    }
    // Unlit signal — pass + examine
    if (/pass.*unlit.*examine|lamp failure.*examine/i.test(lower)) {
      return `Authorised to pass${sigRef} in its unlit state, proceed at caution and examine the line${trainRef}`;
    }
    // Unlit signal — pass only
    if (/pass.*unlit|lamp failure/i.test(lower)) {
      return `Authorised to pass${sigRef} in its unlit state, proceed at caution to the next signal${trainRef}`;
    }
    // Pass signal at danger + continue examining the line
    if (/pass.*signal.*at\s*(stop|danger).*examine/i.test(lower) || /pass.*at\s*danger.*continue.*examine/i.test(lower)) {
      return `Authorised to pass${sigRef} at danger, continue to examine the line, proceed at caution${trainRef}`;
    }
    // Pass signal at danger only
    if (/pass.*signal.*at\s*(stop|danger)/i.test(lower)) {
      return `Authorised to pass${sigRef} at danger, proceed at caution to the next signal${trainRef}`;
    }
    // Continue examining the line (from examine result callback)
    if (/continue.*examin/i.test(lower) || /examin.*line.*report/i.test(lower)) {
      return `Ok Signaller, I will continue to examine the line and report further${trainRef}`;
    }
    // Examine the line only (initial request from red signal)
    if (/ask.*examine|examine\s*the\s*line/i.test(lower)) {
      return `Examine the line from${sigRef} to the next signal, proceed at caution and report${trainRef}`;
    }
    // Route query readbacks
    if (this.isRouteQuery) {
      const rqWait = lower.match(/wait\s+(\d+)\s*min/);
      if (rqWait) {
        return `Understood, I shall wait ${rqWait[1]} minutes${trainRef}`;
      }
      if (/abandon.*timetable/i.test(lower)) {
        return `Understood, I shall abandon the timetable${trainRef}`;
      }
      if (/bypass\s+(.+?)\s+and\s+continue/i.test(lower)) {
        const bp = lower.match(/bypass\s+(.+?)\s+and\s+continue/i);
        return `Understood, I shall bypass ${bp[1]} and continue with the remainder of the timetable${trainRef}`;
      }
    }
    // Wait for booked time — train is early, hold at signal until booked departure
    const bookedMatch = lower.match(/wait\s+(?:for\s+)?booked\s+(\d{2}:\d{2})/);
    if (bookedMatch) {
      return `Ok, I will wait here at${sigRef} until booked time and call you back if no change of aspect`;
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
      if (this.isShunterCall) return `Ok, I will call back in ${word} minutes`;
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
    if (/permission\s+granted/i.test(lower) || /has\s+permission\s+to\s+enter/i.test(lower)) {
      if (this.isShunterCall) return `Ok, ${hc} has permission to enter. I will let them know`;
      return `Permission granted, ${hc} can enter`;
    }
    // Ready to depart — driver says goodbye and ends call
    if (/ready\s+to\s+depart/i.test(lower)) {
      return `Ready to depart, thanks Signaller. Goodbye`;
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
  // Returns true if this reply type needs no driver readback (just a goodbye)
  _isNoReadbackReply(replyText) {
    const lower = replyText.toLowerCase();
    // Delay acknowledgments, crew waiting, signal replacement yes/no, no obstructions
    return /ok.*\w+\s+delayed/i.test(lower)
      || /ok.*crew for.*ready and waiting/i.test(lower)
      || /yes.*signal\s+will\s+be\s+replaced/i.test(lower)
      || /no.*signal\s+will\s+not\s+be\s+replaced/i.test(lower)
      || /no\s*obstruction.*found/i.test(lower)
      || /(?:signal|points|track\s*section)\s*failure.*fixed/i.test(lower);
  },

  async sendReply(replyIndex, replies, caller) {
    const myCallId = this._callSeq;
    this._hangUpLocked = true; // prevent hangup keybind/click during reply flow
    this.addMessage({ type: 'loading', text: 'Replying...' });

    const rawReply = replies[replyIndex];
    const skipReadback = this._isNoReadbackReply(rawReply);

    // Store route query details so we can call Route Control about it later
    if (this.isRouteQuery) {
      this._lastRouteQuery = {
        headcode: this.currentHeadCode,
        signal: this.currentSignalId,
        bookedVia: this._routeQueryVia,
        replyRaw: rawReply,
      };
    }

    // Send reply to SimSig — PS script handles headcode entry dialogs automatically
    await window.simsigAPI.phone.replyCall(replyIndex, this.currentHeadCode);
    if (myCallId !== this._callSeq) return;
    this._replySent = true;
    this.messages = this.messages.filter((m) => m.type !== 'loading');

    if (skipReadback) {
      // No readback needed — sign off directly
      this.addMessage({ type: 'greeting', text: 'Signaller Out' });
      this._hangUpLocked = false;
      this.hangUp();
      return;
    }

    // Standard flow: driver readback → wait for goodbye
    const confirmation = this.buildConfirmation(rawReply);

    const voices = await this.getTTSVoices();
    if (myCallId !== this._callSeq) return;
    let audioPromise = null;
    if (voices && voices.length > 0) {
      const voiceId = this.getTTSVoiceId(caller, voices);
      audioPromise = this.fetchTTSAudio(this.phoneticize(confirmation), voiceId);
    }

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
    // After driver readback, show sign-off prompt
    this._hangUpLocked = false;
    this.addMessage({ type: 'greeting', text: 'Signaller Out' });
    this.hangUp();
  },

  // Send "Ok" reply to SimSig, show "Ok, Thanks", then sign off
  async sendOkAndHangUp(caller) {
    const myCallId = this._callSeq;
    this._replyClicked = true;
    this._hangUpLocked = true;
    this.addMessage({ type: 'loading', text: 'Replying...' });
    await window.simsigAPI.phone.replyCall(0, this.currentHeadCode);
    if (myCallId !== this._callSeq) return;
    this._replySent = true;
    this.messages = this.messages.filter((m) => m.type !== 'loading');
    const okText = this.isSignallerCall ? 'Ok, Thanks. I will take a look now' : 'Ok, Thanks';
    this.addMessage({ type: 'signaller', text: okText });
    this.addMessage({ type: 'greeting', text: 'Signaller Out' });
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

      // Ok-only reply: any PTT press+release sends it (no transcript needed)
      if (okOnly) {
        await this.sendOkAndHangUp(caller);
        return;
      }

      if (transcript) {
        const replyIndex = this.matchReply(transcript, replies);
        if (replyIndex >= 0) {
          await this.sendReply(replyIndex, replies, caller);
          return;
        }
        // Transcript didn't match any reply — ask again
        if (callId !== this._callSeq) return;
        const sorry = "Can you say again please";
        this.addMessage({ type: 'driver', caller, text: sorry });
        await this.speakAsDriver(sorry, caller);
        if (callId !== this._callSeq) return;
      }
      // Empty transcript (STT failed) — loop silently, keep click handlers active
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
      this.addMessage({ type: 'greeting', text: 'Hold PTT to sign off...' });

      try {
        await this.recordAndTranscribe();
        if (!this.inCall || callId !== this._callSeq) return;
        // PTT was pressed and released — signaller signs off, then hang up
        this.addMessage({ type: 'signaller', text: 'Signaller Out' });
        this.hangUp();
        return;
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

  hangUp({ forceClose = false } = {}) {
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
    this.isUnlitSignal = false;
    this.isAdverseAspect = false;
    this.isReadyToDepart = false;
    this.isRouteQuery = false;
    this._routeQueryVia = null;
    this._replyClicked = false;
    this._hasReplyOptions = false;
    this._replySent = false;
    this._hangUpLocked = false;
    this._activeCallTrain = '';
    this._activeCallVoiceKey = '';
    this.stopBgNoise();
    this.bgCallerType = 'train';
    this.messages = [];
    this.hideCommsOverlay();
    if (this._replyDelegateHandler) {
      this.chatEl.removeEventListener('click', this._replyDelegateHandler);
      this._replyDelegateHandler = null;
    }
    this.renderChat();
    this.renderCalls();
    this.hideNotification();
    this._syncToRemote();
    if (this._updateRcState) this._updateRcState();

    // Dismiss TAnswerCallForm in SimSig — force-close uses a safe script
    // that won't consume queued calls; normal hangup uses the full script
    if (forceClose) {
      window.simsigAPI.phone.forceCloseCall().catch(() => {});
    } else {
      window.simsigAPI.phone.hideAnswerDialog().catch(() => {});
    }
    // If there are waiting calls, show the next one and start ringing
    if (this.calls.length > 0) {
      const nextCall = this.calls[this.calls.length - 1];
      this.showNotification(nextCall.train || '');
      this.startRinging();
    }
  },

  async answerCall(index) {
    // Lock out new calls while comms overlay is open (inCall OR stale overlay)
    if (this.inCall || (this.commsOverlay && !this.commsOverlay.classList.contains('hidden'))) return;
    this.inCall = true;
    this._hangUpLocked = true; // lock hangup until call flow is ready
    const callId = ++this._callSeq; // unique ID to detect stale async continuations
    window.simsigAPI.keys.setInCall(true);
    this._replyClicked = false;
    this.showCommsOverlay();
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

    // Fetch settings + voices IN PARALLEL with the answer script (or mock data)
    const answerSource = this._simulateResult
      ? Promise.resolve(this._simulateResult)
      : window.simsigAPI.phone.answerCall(index, train);
    this._simulateResult = null;
    const [result, settingsAll, voices] = await Promise.all([
      answerSource,
      window.simsigAPI.settings.getAll(),
      this.getTTSVoices(),
    ]);
    if (callId !== this._callSeq) return; // call was hung up while awaiting

    if (result.error) {
      // Call no longer exists — remove it from local list and reset state
      this.inCall = false;
      window.simsigAPI.keys.setInCall(false);
      this.hideCommsOverlay();
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
    const delay = !csd && !readyAt && !earlyRun && !sigAdvisory ? this.parseDelayMessage(driverMsg) : null;
    const crewWaiting = !csd && !readyAt && !earlyRun && !sigAdvisory && !delay ? this.parseCrewWaitingMessage(driverMsg) : null;
    const fixedReport = this.parseFixedReport(driverMsg);
    const routeQuery = this.parseRouteQueryMessage(driverMsg);
    const readyToDepart = this.parseReadyToDepart(driverMsg);

    // Start background noise for the duration of the call
    // Signaller → office ambience, shunter/CSD/yard → yard noise, train → cab noise
    this.bgCallerType = this.getCallerType(caller, driverMsg);
    this.isShunterCall = /shunter/i.test(caller);
    // Third-party calls: caller is not a Driver, not a Signaller, not a Shunter
    // (e.g. token hut, ground frame, level crossing) — use third-person phrasing
    // readyAt means the message says "XXXX is ready at..." — that's a driver/shunter, not third-party
    this.isThirdPartyCall = !this.isShunterCall && !this.isSignallerCall && !readyAt
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
      spokenMsg = this.buildCsdSpokenMessage(panelName, position, csd, caller);
      displayMsg = spokenMsg;
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
        const raHc = this.currentHeadCode || readyAt.headcode;
        let msg = `Hello, this is the Shunter in ${readyAt.location}. Train ${raHc} is ready`;
        if (readyAt.nextStop) {
          msg += `. Next stop is ${readyAt.nextStop}`;
          if (readyAt.platform) msg += ` Platform ${readyAt.platform}`;
        }
        spokenMsg = msg;
        displayMsg = msg;
      } else {
        const raHc = this.currentHeadCode || readyAt.headcode;
        displayMsg = `Driver of ${raHc}. I am waiting to enter at ${readyAt.location}.`;
        spokenMsg = `Hello ${panelName} Signaller. This is driver of ${raHc}. I am waiting to enter at ${readyAt.location}`;
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
    } else if (delay) {
      this._delayReason = delay.reason;
      const delayHc = this.currentHeadCode || delay.headcode;
      // Convert "driver needing X" → "I need X" for natural first-person speech
      const driverNeeding = delay.reason.match(/^driver\s+needing\s+(.+)/i);
      const fpReason = driverNeeding ? `I need ${driverNeeding[1]}` : delay.reason;
      const isPersonal = /^I need/i.test(fpReason);
      const quickPart = isPersonal ? ' I will be as quick as I can.' : '';
      const timePart = delay.departTime ? ` We should be ready to depart at ${delay.departTime}` : '';
      spokenMsg = `Hello Signaller, this is driver of ${delayHc} at ${delay.location}. We are going to be delayed as ${fpReason}.${quickPart}${timePart}`;
      displayMsg = spokenMsg;
    } else if (crewWaiting) {
      this.bgCallerType = 'station';
      this.stopBgNoise();
      this.startBgNoise();
      const cwHc = this.currentHeadCode || crewWaiting.headcode;
      spokenMsg = `Hello Signaller, this is the driver of ${cwHc}. I am waiting at ${crewWaiting.location} station for the train to arrive. As soon as the train is here, my crew and I will complete all our required activities and be ready to depart as soon as possible`;
      displayMsg = spokenMsg;
    } else if (fixedReport) {
      // Technician reporting a failure fixed — use trackside background
      this.bgCallerType = 'trackside';
      this.stopBgNoise();
      this.startBgNoise();
      const failLower = fixedReport.type.toLowerCase();
      spokenMsg = `Hello Signaller, this is the MOM down at the ${failLower} in the ${fixedReport.location} area. Good news, the team have been able to fix the issue and you may resume normal working`;
      displayMsg = spokenMsg;
    } else if (isExamineResult && this.currentHeadCode) {
      // Examine line result — driver is moving, use train running background
      this.bgCallerType = 'trainrunning';
      this.stopBgNoise();
      this.startBgNoise();
      displayMsg = `${this.currentHeadCode} has examined the line. No obstructions found.`;
      spokenMsg = `Hello Signaller, this is driver of ${this.currentHeadCode}. I have examined the line as requested and found no obstructions`;
    } else if (routeQuery) {
      // Route query — driver questioning the set route (booked via somewhere else)
      this.isRouteQuery = true;
      this._routeQueryVia = routeQuery.bookedVia;
      // Pre-store for Route Control call (updated again in sendReply with the chosen reply)
      this._lastRouteQuery = { headcode: this.currentHeadCode, signal: routeQuery.signal, bookedVia: routeQuery.bookedVia, replyRaw: null };
      displayMsg = `${this.currentHeadCode} querying route at signal ${routeQuery.signal}, booked via ${routeQuery.bookedVia}`;
      spokenMsg = `Hello Signaller, this is driver of ${this.currentHeadCode} at ${routeQuery.signal}. I wanted to query the set route as I am booked via ${routeQuery.bookedVia}`;
    } else if (/adverse\s+change\s+of\s+aspect/i.test(driverMsg) && this.currentSignalId) {
      // Adverse change of aspect — driver received a more restrictive signal unexpectedly
      this.isAdverseAspect = true;
      displayMsg = `${this.currentHeadCode} reporting adverse change of aspect at signal ${this.currentSignalId}`;
      spokenMsg = `Hello Signaller, this is driver of ${this.currentHeadCode}. I have received an adverse change of aspect at signal ${this.currentSignalId}`;
    } else if (this.currentSignalId && /unlit\s+signal/i.test(driverMsg)) {
      // Unlit signal — signal lamp failure
      this.isUnlitSignal = true;
      displayMsg = `${this.currentHeadCode} waiting at unlit signal ${this.currentSignalId}`;
      spokenMsg = `Hello Signaller, this is driver of ${this.currentHeadCode}. I have come to a stop at signal ${this.currentSignalId} as it is showing no aspect`;
    } else if (readyToDepart) {
      // Driver resolved difficulties and is now ready to depart
      this.isReadyToDepart = true;
      const rdHc = this.currentHeadCode || readyToDepart.headcode;
      const rdLoc = readyToDepart.location ? ` from ${readyToDepart.location}` : '';
      spokenMsg = `Hello Signaller, this is driver of ${rdHc}. We have resolved our issue and are now ready to depart${rdLoc}`;
      displayMsg = spokenMsg;
    } else if (driverMsg) {
      // No specific pattern matched — show raw SimSig message
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
    this.notificationEl.classList.remove('in-call');
    this.notificationEl.classList.add('flashing');
    const readyText = this.notificationEl.querySelector('#notification-ready-text');
    if (readyText) readyText.style.display = 'none';
    this._setTrainText(contactName);
    if (this.notificationAnswerBtn) { this.notificationAnswerBtn.textContent = '[Cancel]'; this.notificationAnswerBtn.style.display = 'block'; }
    const icon = this.notificationEl.querySelector('#notification-icon');
    if (icon) icon.style.display = 'block';
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
    gain.gain.setValueAtTime(2, ctx.currentTime);
    gain.gain.setValueAtTime(2, ctx.currentTime + dur - 0.05);
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
    this.showCommsOverlay();
    this._outgoingContactName = contactName;
    this._outgoingReplySent = false;
    this._outgoingReplyProcessing = false;
    this.notificationEl.classList.remove('flashing');
    this.notificationEl.classList.add('in-call');
    const readyText = this.notificationEl.querySelector('#notification-ready-text');
    if (readyText) readyText.style.display = 'none';
    this._setTrainText(contactName);
    if (this.notificationAnswerBtn) { this.notificationAnswerBtn.textContent = '[Hang Up]'; this.notificationAnswerBtn.style.display = 'block'; }
    const icon = this.notificationEl.querySelector('#notification-icon');
    if (icon) icon.style.display = 'block';
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
        if (this._outgoingReplySent || this._outgoingReplyProcessing || !this._outgoingCall) return;
        this.addMessage({ type: 'greeting', text: 'Hold PTT and speak your reply...' });

        let transcript = '';
        try {
          transcript = await this.recordAndTranscribe();
        } catch (e) {
          if (this._outgoingReplySent || this._outgoingReplyProcessing || !this._outgoingCall) return;
          break;
        }
        if (this._outgoingReplySent || this._outgoingReplyProcessing || !this._outgoingCall) return;

        if (transcript) {
          console.log(`[PlaceCall] Heard: "${transcript}", matching against:`, replies);
          const replyIndex = this.matchReply(transcript, replies);
          console.log(`[PlaceCall] Match result: index=${replyIndex}`);
          if (replyIndex >= 0) {
            this._outgoingReplyProcessing = true;
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

      if (this._outgoingReplySent || this._outgoingReplyProcessing || !this._outgoingCall) return;
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
      if (this._outgoingReplySent || this._outgoingReplyProcessing) return;

      const chip = e.target.closest('.wait-time-choice');
      if (chip) {
        this._outgoingReplyProcessing = true;
        const idx = parseInt(chip.dataset.index, 10);
        this.sendOutgoingReply(idx, replies, contactName);
        return;
      }

      const li = e.target.closest('.reply-options-list li');
      if (li) {
        const replyIdx = parseInt(li.dataset.replyIndex, 10);
        if (replyIdx < 0) return;
        this._outgoingReplyProcessing = true;
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
    if (/permission|request.*train/i.test(replyText)) return 'Ok, permission granted, thank you';
    if (/proceed|continue/i.test(replyText)) return 'Ok, will do, thanks';
    if (/stop|hold|wait/i.test(replyText)) return 'Ok, no problem, I will hold them';
    if (/caution/i.test(replyText)) return 'Right, understood, will proceed with caution';
    if (/wrong.*line|wrong.*road/i.test(replyText)) return 'Oh right, ok, thanks for letting me know';
    return 'Ok, lovely, thanks';
  },

  // Check if a reply option needs a headcode parameter (e.g. "permission for train", "platform alteration")
  replyNeedsHeadcode(replyText) {
    return /train|permission|pass.*signal|hold.*back|platform|alternat/i.test(replyText);
  },

  // Check if a reply option needs a second parameter (platform number)
  replyNeedsPlatform(replyText) {
    return /platform|alternat/i.test(replyText);
  },

  // Show a free-text input in the chat and return a Promise that resolves with the typed value
  promptForText(label, placeholder) {
    return new Promise((resolve) => {
      this._textInputResolve = resolve;
      this.addMessage({ type: 'text-input', label, placeholder });
    });
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

  // Record voice for headcode/platform/readback prompts inside sendOutgoingReply.
  // Temporarily clears _outgoingReplyProcessing so waitForPTTPress doesn't reject,
  // then restores it. Safe because _outgoingReplySent prevents any re-entry.
  async _recordForReplyPrompt() {
    this._outgoingReplyProcessing = false;
    try { return await this.recordAndTranscribe(); }
    finally { this._outgoingReplyProcessing = true; }
  },

  async sendOutgoingReply(replyIndex, replies, contactName) {
    // Guard: prevent double-entry (voice match + click can race)
    if (this._outgoingReplySent) return;
    this._outgoingReplySent = true;
    // Keep _outgoingReplyProcessing true until voice reply loop's waitForPTTPress can see it
    // (cleared before each internal recordAndTranscribe call via _recordForReplyPrompt)
    const replyText = replies[replyIndex] || '';
    const shortName = this.shortenCaller(contactName);
    let headCode = '';

    // Check if the reply already contains a headcode
    const hcMatch = replyText.match(/([0-9][A-Z][0-9]{2})/i);
    if (hcMatch) {
      headCode = hcMatch[1].toUpperCase();
    } else if (this.replyNeedsHeadcode(replyText)) {
      // Ask the user for the headcode via voice (NATO phonetics supported)
      this._awaitingHeadcode = true;
      const askMsg = 'Ok, what is their headcode?';
      this.addMessage({ type: 'driver', caller: shortName, text: askMsg });
      await this.speakAsDriver(askMsg, contactName);
      if (!this._outgoingCall) { this._awaitingHeadcode = false; return; }

      this._useTextInput = false;
      let promptShown = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!promptShown) {
          this.addMessage({ type: 'greeting', text: 'Hold PTT and speak the headcode (e.g. "three echo nine zero")', hasTextOption: true });
          promptShown = true;
        }
        const transcript = await this._recordForReplyPrompt();
        if (!this._outgoingCall) { this._awaitingHeadcode = false; return; }
        if (this._useTextInput) break; // user clicked "use text"

        // Empty transcript — silently wait for the next attempt
        if (!transcript || !transcript.trim()) continue;

        headCode = this.extractHeadcode(transcript);
        if (headCode) break;

        // Non-empty but couldn't extract — tell user
        if (attempt < 2) {
          this.addMessage({ type: 'system', text: `I didn't catch that — try again (attempt ${attempt + 2}/3)` });
        }
      }
      // Voice failed or user chose text — fall back to text input
      if (!headCode) {
        this._useTextInput = false;
        headCode = await this.promptForText('ENTER HEADCODE', 'e.g. 3E90');
        if (!this._outgoingCall) { this._awaitingHeadcode = false; return; }
        if (headCode) headCode = headCode.toUpperCase();
        if (!headCode || !/^[0-9][A-Z][0-9]{2}$/.test(headCode)) headCode = '0000';
      }
      this._awaitingHeadcode = false;
      if (!this._outgoingCall) return;
    }

    // If reply needs a platform parameter (e.g. Platform Alteration), ask via voice first
    let param2 = '';
    if (this.replyNeedsPlatform(replyText)) {
      const askPlatform = 'And what is the new platform?';
      this.addMessage({ type: 'driver', caller: shortName, text: askPlatform });
      await this.speakAsDriver(askPlatform, contactName);
      if (!this._outgoingCall) return;

      this._useTextInput = false;
      let promptShown = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!promptShown) {
          this.addMessage({ type: 'greeting', text: 'Hold PTT and speak the platform number (e.g. "platform 3")', hasTextOption: true });
          promptShown = true;
        }
        const transcript = await this._recordForReplyPrompt();
        if (!this._outgoingCall) return;
        if (this._useTextInput) break; // user clicked "use text"

        if (!transcript || !transcript.trim()) continue;

        // Extract platform from speech — look for a number/letter combo
        const platMatch = transcript.match(/(\d+[A-Za-z]?)/);
        if (platMatch) { param2 = platMatch[1].toUpperCase(); break; }

        if (attempt < 2) {
          this.addMessage({ type: 'system', text: `I didn't catch that — try again (attempt ${attempt + 2}/3)` });
        }
      }

      // Voice failed or user chose text — fall back to text input
      if (!param2) {
        this._useTextInput = false;
        param2 = await this.promptForText('ENTER PLATFORM', 'e.g. 2, 3A');
        if (!this._outgoingCall) return;
      }
    }

    // Show what we're sending
    this.addMessage({ type: 'loading', text: 'Sending...' });

    // Send reply to SimSig via Place Call dialog (keyboard input)
    const result = await window.simsigAPI.phone.placeCallReply(replyIndex, headCode, param2, contactName);
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
      console.log('[OutgoingReply] Using SimSig response:', confirmation);
    } else {
      confirmation = this.generateConfirmationFromReply(replyText);
      console.log('[OutgoingReply] No SimSig response, using generated:', confirmation);
    }
    this.addMessage({ type: 'driver', caller: shortName, text: confirmation });
    await this.speakAsDriver(confirmation, contactName);
    if (!this._outgoingCall) return;

    // Wait for user to readback the response, then sign off
    this.addMessage({ type: 'greeting', text: 'Hold PTT to readback and sign off...' });
    try {
      const readback = await this._recordForReplyPrompt();
      if (!this._outgoingCall) return;
      if (readback) {
        this.addMessage({ type: 'signaller', text: readback });
      }
    } catch { /* PTT cancelled — continue to goodbye */ }
    if (!this._outgoingCall) return;

    // Caller says goodbye
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
    const byeMsg = goodbyes[Math.floor(Math.random() * goodbyes.length)];
    this.addMessage({ type: 'driver', caller: shortName, text: byeMsg });
    await this.speakAsDriver(byeMsg, contactName);

    this._outgoingReplyProcessing = false;
    this.endOutgoingCall();
    this.stopBgNoise();
  },

  async _listenForGoodbye(contactName) {
    while (this._outgoingCall) {
      this.addMessage({ type: 'greeting', text: 'Hold PTT to sign off...' });

      try {
        const transcript = await this.recordAndTranscribe();
        if (!this._outgoingCall) return;
        if (transcript) {
          this.addMessage({ type: 'signaller', text: 'Signaller Out' });
          const goodbyes = [
            'Ok, speak later, bye.',
            'Thanks, bye now.',
            'Cheers, bye.',
            'Right, thanks, bye.',
            'Ok, bye now.',
            'Right oh, bye.',
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
    this._awaitingHeadcode = false;
    window.simsigAPI.keys.setInCall(false);
    this._outgoingContactName = '';
    this._outgoingReplySent = false;
    this._outgoingReplyProcessing = false;
    this._outgoingReplies = null;
    if (this._outgoingReplyHandler) {
      this.chatEl.removeEventListener('click', this._outgoingReplyHandler);
      this._outgoingReplyHandler = null;
    }
    this.stopBgNoise();
    this.bgCallerType = 'train';
    this.hideCommsOverlay();
    this.messages = [];
    this.renderChat();
    this.hideNotification(); // includes _syncToRemote()
    if (this._updateRcState) this._updateRcState();

    // Resume incoming call notification if calls are waiting
    this._resumeIncoming();
  },

  // Dial Route Control — simulated call reporting active failures
  async dialRouteControl() {
    const callsign = this.getRouteControl();
    if (!callsign) {
      console.warn('[RouteControl] No route control found for panel:', this.currentPanelName);
      return;
    }
    if (this.inCall || this._outgoingCall || this._dialingActive) return;

    const hasFailures = typeof AlertsFeed !== 'undefined' && AlertsFeed.getActiveFailures().length > 0;
    const hasWrongRoute = !!this._lastRouteQuery;

    // Check there's something to report
    if (!hasFailures && !hasWrongRoute) {
      console.log('[RouteControl] Nothing to report');
      return;
    }

    // Show dialing state with ringing
    this.showDialingNotification('Route Control');

    // Simulate ringing for 2–4 seconds
    const ringTime = 2000 + Math.random() * 2000;
    await new Promise((r) => setTimeout(r, ringTime));
    if (!this._dialingActive) return; // user cancelled

    // Stop ringing and enter call state
    this.stopDialing(true);
    this._outgoingCall = true;
    this._outgoingContactName = 'Route Control';
    this._outgoingReplySent = false;
    this._outgoingReplyProcessing = false;
    window.simsigAPI.keys.setInCall(true);
    this.showCommsOverlay();
    this.notificationEl.classList.remove('flashing');
    this.notificationEl.classList.add('in-call');
    const readyText = this.notificationEl.querySelector('#notification-ready-text');
    if (readyText) readyText.style.display = 'none';
    this._setTrainText('Route Control');
    if (this.notificationAnswerBtn) { this.notificationAnswerBtn.textContent = '[Hang Up]'; this.notificationAnswerBtn.style.display = 'block'; }
    const rcIcon = this.notificationEl.querySelector('#notification-icon');
    if (rcIcon) rcIcon.style.display = 'block';
    this._updatePhonebookInCall('Route Control', true);

    // Use signaller background noise
    this.bgCallerType = 'signaller';
    this.startBgNoise();

    // Route Control answers
    const greeting = `Hello, ${callsign}`;
    this.addMessage({ type: 'driver', caller: callsign, text: greeting });
    this._syncToRemote();

    await this.speakAsDriver(greeting, callsign);
    if (!this._outgoingCall) return;

    // Build reply options — failures + wrong route if applicable
    const panelName = this.currentPanelName || 'Panel';
    const allFailures = typeof AlertsFeed !== 'undefined' ? AlertsFeed.getActiveFailures() : [];

    // Show each failure as a separate reply option
    const replies = allFailures.map((f) => 'I am showing a ' + this._formatFailureForSpeech(f));

    // Add wrong route option if pending
    const wrongRouteIdx = replies.length; // index of the wrong route option (if added)
    const rq = this._lastRouteQuery;
    if (rq) {
      replies.push(`I have set the wrong route for ${rq.headcode} at signal ${rq.signal}. The driver is booked via ${rq.bookedVia}`);
    }
    this._outgoingReplySent = false;
    this._outgoingReplyProcessing = false;
    let selectedIdx = -1;

    // Click handler for reply options
    const rcClickHandler = (e) => {
      if (this._outgoingReplySent) return;
      const li = e.target.closest('.reply-options-list li');
      if (li) {
        selectedIdx = parseInt(li.dataset.replyIndex, 10);
        if (isNaN(selectedIdx)) selectedIdx = 0;
        this._outgoingReplySent = true;
        this._outgoingReplyProcessing = true; // break waitForPTTPress
        this.chatEl.removeEventListener('click', rcClickHandler);
      }
    };

    // Voice reply loop — record, transcribe, match (same as outgoing calls)
    const MAX_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (this._outgoingReplySent || !this._outgoingCall) break;

      this.addMessage({ type: 'reply-options', replies });
      this.addMessage({ type: 'greeting', text: 'Hold PTT to report to Route Control...' });
      this.renderChat();
      this._syncToRemote();
      this.chatEl.addEventListener('click', rcClickHandler);

      let transcript = '';
      try {
        transcript = await this.recordAndTranscribe();
      } catch (e) {
        if (this._outgoingReplySent || !this._outgoingCall) break;
        continue;
      }
      if (this._outgoingReplySent || !this._outgoingCall) break;

      if (transcript) {
        console.log(`[RouteControl] Heard: "${transcript}", matching against:`, replies);
        const matchIdx = this.matchReply(transcript, replies);
        if (matchIdx >= 0) {
          selectedIdx = matchIdx;
          this._outgoingReplySent = true;
          this.addMessage({ type: 'signaller', text: transcript });
          break;
        }
      }

      // Not understood — ask again
      if (attempt < MAX_ATTEMPTS - 1) {
        const sorry = 'Can you say again please';
        this.addMessage({ type: 'driver', caller: callsign, text: sorry });
        await this.speakAsDriver(sorry, callsign);
      }
    }
    this.chatEl.removeEventListener('click', rcClickHandler);
    this._outgoingReplyProcessing = false;
    if (!this._outgoingCall) return;

    // If not matched via voice or click, fallback to clickable options
    if (selectedIdx < 0) {
      this.addMessage({ type: 'reply-options', replies });
      this.renderChat();
      this._syncToRemote();
      selectedIdx = await new Promise((resolve) => {
        const fallbackClick = (e) => {
          const li = e.target.closest('.reply-options-list li');
          if (li) {
            this.chatEl.removeEventListener('click', fallbackClick);
            const idx = parseInt(li.dataset.replyIndex, 10);
            resolve(isNaN(idx) ? 0 : idx);
          }
        };
        this.chatEl.addEventListener('click', fallbackClick);
      });
      if (!this._outgoingCall) return;
    }

    // Show what we said
    this.addMessage({ type: 'signaller', text: replies[selectedIdx] || replies[0] });
    this.renderChat();
    this._syncToRemote();

    // Pause briefly before Route Control responds
    await new Promise((r) => setTimeout(r, 500));
    if (!this._outgoingCall) return;

    const isWrongRoute = rq && selectedIdx === wrongRouteIdx;

    if (isWrongRoute) {
      // --- Wrong route flow ---
      const abandon = Math.random() < 0.5;
      let rcAdvice;
      if (abandon) {
        rcAdvice = `Hello Signaller, please advise the driver of ${rq.headcode} that they are to abandon their timetable`;
      } else {
        rcAdvice = `Hello Signaller, please advise the driver of ${rq.headcode} that they are to continue with the remainder of their timetable if possible`;
      }

      this.addMessage({ type: 'driver', caller: callsign, text: rcAdvice });
      this._syncToRemote();
      await this.speakAsDriver(rcAdvice, callsign);
      if (!this._outgoingCall) return;

      if (abandon) {
        // Abandon — straightforward readback
        const readback = `Understood, I will advise ${rq.headcode} that they are to abandon their timetable`;

        this.addMessage({ type: 'greeting', text: 'Hold PTT to acknowledge...' });
        this.renderChat();
        this._syncToRemote();

        try {
          const ackTranscript = await this.recordAndTranscribe();
          if (!this._outgoingCall) return;
          this.addMessage({ type: 'signaller', text: ackTranscript || readback });
        } catch {
          if (!this._outgoingCall) return;
          this.addMessage({ type: 'signaller', text: readback });
        }
        this.renderChat();
        this._syncToRemote();
        if (!this._outgoingCall) return;
      } else {
        // Continue — offer two reply options: accept or challenge
        const acceptReply = `Understood, I will advise ${rq.headcode} that they are to continue with the remainder of their timetable`;
        const challengeReply = `Due to the route set, they are unable to continue with their timetable`;
        const rqReplies = [acceptReply, challengeReply];

        this.addMessage({ type: 'reply-options', replies: rqReplies });
        this.addMessage({ type: 'greeting', text: 'Hold PTT to reply...' });
        this.renderChat();
        this._syncToRemote();

        // Click + voice selection
        let rqSelectedIdx = -1;
        this._outgoingReplySent = false;
        this._outgoingReplyProcessing = false;

        const rqClickHandler = (e) => {
          if (this._outgoingReplySent) return;
          const li = e.target.closest('.reply-options-list li');
          if (li) {
            rqSelectedIdx = parseInt(li.dataset.replyIndex, 10);
            if (isNaN(rqSelectedIdx)) rqSelectedIdx = 0;
            this._outgoingReplySent = true;
            this._outgoingReplyProcessing = true;
            this.chatEl.removeEventListener('click', rqClickHandler);
          }
        };

        for (let attempt = 0; attempt < 3; attempt++) {
          if (this._outgoingReplySent || !this._outgoingCall) break;
          this.chatEl.addEventListener('click', rqClickHandler);

          let transcript = '';
          try {
            transcript = await this.recordAndTranscribe();
          } catch (e) {
            if (this._outgoingReplySent || !this._outgoingCall) break;
            continue;
          }
          if (this._outgoingReplySent || !this._outgoingCall) break;

          if (transcript) {
            const matchIdx = this.matchReply(transcript, rqReplies);
            if (matchIdx >= 0) {
              rqSelectedIdx = matchIdx;
              this._outgoingReplySent = true;
              break;
            }
          }
        }
        this.chatEl.removeEventListener('click', rqClickHandler);
        this._outgoingReplyProcessing = false;
        if (!this._outgoingCall) return;

        // Fallback to click if not matched
        if (rqSelectedIdx < 0) {
          this.addMessage({ type: 'reply-options', replies: rqReplies });
          this.renderChat();
          this._syncToRemote();
          rqSelectedIdx = await new Promise((resolve) => {
            const fallback = (e) => {
              const li = e.target.closest('.reply-options-list li');
              if (li) {
                this.chatEl.removeEventListener('click', fallback);
                const idx = parseInt(li.dataset.replyIndex, 10);
                resolve(isNaN(idx) ? 0 : idx);
              }
            };
            this.chatEl.addEventListener('click', fallback);
          });
          if (!this._outgoingCall) return;
        }

        // Show what we said
        this.addMessage({ type: 'signaller', text: rqReplies[rqSelectedIdx] });
        this.renderChat();
        this._syncToRemote();

        if (rqSelectedIdx === 1) {
          // Challenged — RC changes to abandon
          await new Promise((r) => setTimeout(r, 500));
          if (!this._outgoingCall) return;

          const revised = `Ok, in that case, advise ${rq.headcode} to abandon timetable`;
          this.addMessage({ type: 'driver', caller: callsign, text: revised });
          this._syncToRemote();
          await this.speakAsDriver(revised, callsign);
          if (!this._outgoingCall) return;

          // Readback the revised instruction
          const revisedReadback = `Understood, I will advise ${rq.headcode} that they are to abandon their timetable`;
          this.addMessage({ type: 'greeting', text: 'Hold PTT to acknowledge...' });
          this.renderChat();
          this._syncToRemote();

          try {
            const ackTranscript = await this.recordAndTranscribe();
            if (!this._outgoingCall) return;
            this.addMessage({ type: 'signaller', text: ackTranscript || revisedReadback });
          } catch {
            if (!this._outgoingCall) return;
            this.addMessage({ type: 'signaller', text: revisedReadback });
          }
          this.renderChat();
          this._syncToRemote();
          if (!this._outgoingCall) return;
        }
      }

      // Route Control confirms and says goodbye
      await new Promise((r) => setTimeout(r, 300));
      if (!this._outgoingCall) return;

      const rcBye = "That's correct, bye";
      this.addMessage({ type: 'driver', caller: callsign, text: rcBye });
      this._syncToRemote();
      await this.speakAsDriver(rcBye, callsign);

      this._lastRouteQuery = null;
      this.addMessage({ type: 'signaller', text: 'Signaller Out' });
      this.stopBgNoise();
      this.endOutgoingCall();
      return;
    } else {
      // --- Failure report flow ---
      const selectedFailure = allFailures[selectedIdx] || allFailures[0];
      const isAlreadyReported = typeof AlertsFeed !== 'undefined' &&
        AlertsFeed._activeFailures[selectedIdx] && AlertsFeed._activeFailures[selectedIdx].reported;

      // Check if we've already reported other failures this session
      const prevReportedCount = typeof AlertsFeed !== 'undefined' && AlertsFeed._reportedFailures
        ? AlertsFeed._reportedFailures.size : 0;
      const badDayPrefix = (!isAlreadyReported && prevReportedCount > 0)
        ? `Hi ${panelName}, it really isn't your day today! ` : '';

      let response;
      if (isAlreadyReported) {
        response = `Hi ${panelName}. Yes, we are already aware of that issue. No update yet. The MOM will call you as soon as they have an update.`;
      } else {
        const ack = 'a ' + this._formatFailureForSpeech(selectedFailure);
        response = `${badDayPrefix || `Hi ${panelName}. `}Understood you are showing ${ack}. We will arrange some S&T guys to investigate. Also, we are going to send a MOM down incase a line block is required. They will call you with an update.`;
      }

      // Mark only the selected failure as reported
      if (typeof AlertsFeed !== 'undefined' && AlertsFeed._activeFailures[selectedIdx]) {
        AlertsFeed._activeFailures[selectedIdx].reported = true;
        AlertsFeed._reportedFailures.add(selectedFailure);
      }

      this.addMessage({ type: 'driver', caller: callsign, text: response });
      this._syncToRemote();
      await this.speakAsDriver(response, callsign);
      if (!this._outgoingCall) return;

      // Wait for user to acknowledge (PTT or click)
      this.addMessage({ type: 'greeting', text: 'Hold PTT to acknowledge...' });
      this.renderChat();
      this._syncToRemote();

      try {
        const ackTranscript = await this.recordAndTranscribe();
        if (!this._outgoingCall) return;
        this.addMessage({ type: 'signaller', text: ackTranscript || 'Ok, that\'s understood' });
      } catch {
        if (!this._outgoingCall) return;
        this.addMessage({ type: 'signaller', text: 'Ok, that\'s understood' });
      }
      this.renderChat();
      this._syncToRemote();
      if (!this._outgoingCall) return;
    }

    // Route Control says goodbye and we hang up
    const goodbyes = [
      'Ok, thanks for letting us know. Bye.',
      'Right, thanks. Bye now.',
      'Ok, cheers. Bye.',
      'Very good, thanks. Bye now.',
      'Ok, thanks. Speak later, bye.',
    ];
    const bye = goodbyes[Math.floor(Math.random() * goodbyes.length)];
    this.addMessage({ type: 'driver', caller: callsign, text: bye });
    this._syncToRemote();
    await this.speakAsDriver(bye, callsign);

    this.addMessage({ type: 'signaller', text: 'Signaller Out' });
    this.stopBgNoise();
    this.endOutgoingCall();
  },

  // Format a failure status string for natural speech
  _formatFailureForSpeech(failureText) {
    // Already fairly natural — just lowercase the first letter and strip trailing period
    let text = failureText.replace(/\.\s*$/, '').trim();
    // Make "detected" optional for brevity in speech
    text = text.replace(/\s+detected\b/i, '');
    // Lowercase first char for mid-sentence use
    return text.charAt(0).toLowerCase() + text.slice(1);
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
      const status = await window.simsigAPI.phone.placeCallStatus(name);
      if (status.connected && status.replies && status.replies.length > 0) {
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
    const rows = document.querySelectorAll('.pb-row');
    rows.forEach((row) => {
      const nameCell = row.querySelector('.pb-cell-name');
      if (nameCell && nameCell.textContent === contactName) {
        row.classList.toggle('in-call', active);
      }
    });
  },

  showInCallNotification(trainText) {
    if (!this.notificationEl) return;
    const match = (trainText || '').match(/([0-9][A-Z][0-9]{2})/i);
    const headcode = match ? match[1].toUpperCase() : this.shortenCaller(trainText || '');
    this.notificationEl.classList.remove('flashing');
    this.notificationEl.classList.add('in-call');
    const readyText = this.notificationEl.querySelector('#notification-ready-text');
    if (readyText) readyText.style.display = 'none';
    this._setTrainText(headcode);
    if (this.notificationAnswerBtn) { this.notificationAnswerBtn.textContent = '[End Call]'; this.notificationAnswerBtn.style.display = 'block'; }
    const icon = this.notificationEl.querySelector('#notification-icon');
    if (icon) icon.style.display = 'block';
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
    this.notificationEl.classList.remove('flashing', 'in-call');
    const match = trainText.match(/([0-9][A-Z][0-9]{2})/i);
    const headcode = match ? match[1].toUpperCase() : this.shortenCaller(trainText);
    // Hide ready text, show call elements
    const readyText = this.notificationEl.querySelector('#notification-ready-text');
    if (readyText) readyText.style.display = 'none';
    this._setTrainText(headcode);
    if (this.notificationAnswerBtn) { this.notificationAnswerBtn.textContent = '[Answer]'; this.notificationAnswerBtn.style.display = 'block'; }
    const icon = this.notificationEl.querySelector('#notification-icon');
    if (icon) icon.style.display = 'block';
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
    this.isUnlitSignal = false;
    this.bgCallerType = 'train';
    this.gameTime = '';
    this.trainSignalCache = {};

    // Clear outgoing call state
    this._outgoingCall = false;
    this._outgoingContactName = '';
    this._outgoingReplySent = false;
    this._outgoingReplyProcessing = false;
    this._outgoingReplies = null;
    this._dialingActive = false;
    if (this._ringDebounce) { clearTimeout(this._ringDebounce); this._ringDebounce = null; }

    // Clear player call state
    if (this._playerCall || this._playerDialing) {
      this._closeWebRTC();
    }
    this._playerCall = false;
    this._playerDialing = false;
    this._playerRinging = false;
    this._playerCallPanel = '';
    this._playerAnswerHandler = null;

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
    this.hideCommsOverlay();
  },

  hideNotification() {
    if (!this.notificationEl) return;
    this.notificationEl.classList.remove('flashing', 'in-call');
    // Hide call elements, show ready text
    if (this.notificationTrainEl) { this.notificationTrainEl.textContent = ''; this.notificationTrainEl.style.display = 'none'; this.notificationTrainEl.style.fontSize = ''; }
    if (this.notificationAnswerBtn) { this.notificationAnswerBtn.style.display = 'none'; }
    const icon = this.notificationEl.querySelector('#notification-icon');
    if (icon) icon.style.display = 'none';
    const readyText = this.notificationEl.querySelector('#notification-ready-text');
    if (readyText) readyText.style.display = 'inline';
    // Reset radio display
    const radioDisplay = document.getElementById('radio-display');
    if (radioDisplay) radioDisplay.classList.remove('in-call');
    const line1 = document.getElementById('display-line-1');
    const line2 = document.getElementById('display-line-2');
    if (line1) line1.textContent = 'GSM-R';
    if (line2) line2.textContent = 'Ready';
    this._syncToRemote();
  },

  _setTrainText(text) {
    if (!this.notificationTrainEl) return;
    this.notificationTrainEl.textContent = text;
    this.notificationTrainEl.style.display = 'block';
    // Start at default size, shrink until it fits the container
    const maxWidth = this.notificationEl.clientWidth - 10;
    let size = 22;
    this.notificationTrainEl.style.fontSize = size + 'px';
    const maxHeight = this.notificationTrainEl.clientHeight; // capped by CSS max-height
    while (size > 10 && (this.notificationTrainEl.scrollWidth > maxWidth
        || this.notificationTrainEl.scrollHeight > maxHeight)) {
      size--;
      this.notificationTrainEl.style.fontSize = size + 'px';
    }
  },

  showCommsOverlay() {
    // When browser mode is active, only the browser client shows the comms panel
    if (this._browserModeActive) return;
    if (this.commsOverlay) this.commsOverlay.classList.remove('hidden');
  },

  hideCommsOverlay() {
    if (this.commsOverlay) this.commsOverlay.classList.add('hidden');
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
      commsVisible: this.commsOverlay ? !this.commsOverlay.classList.contains('hidden') : false,
      notification: this._getNotificationState(),
    });
  },

  _getNotificationState() {
    if (!this.notificationEl) return { type: 'ready' };
    const icon = this.notificationEl.querySelector('#notification-icon');
    const isReady = !this.notificationEl.classList.contains('in-call') && !this.notificationEl.classList.contains('flashing');
    return {
      type: isReady ? 'ready'
        : this.notificationEl.classList.contains('in-call') ? 'in-call' : 'flashing',
      trainText: this.notificationTrainEl ? this.notificationTrainEl.textContent : '',
      buttonText: this.notificationAnswerBtn ? this.notificationAnswerBtn.textContent : '',
    };
  },

  _applyNotification(state) {
    if (!this.notificationEl) return;
    const readyText = this.notificationEl.querySelector('#notification-ready-text');
    const icon = this.notificationEl.querySelector('#notification-icon');
    if (state.type === 'ready') {
      this.notificationEl.classList.remove('flashing', 'in-call');
      if (this.notificationTrainEl) this.notificationTrainEl.style.display = 'none';
      if (this.notificationAnswerBtn) this.notificationAnswerBtn.style.display = 'none';
      if (icon) icon.style.display = 'none';
      if (readyText) readyText.style.display = 'inline';
      return;
    }
    if (readyText) readyText.style.display = 'none';
    this.notificationEl.classList.toggle('in-call', state.type === 'in-call');
    this.notificationEl.classList.toggle('flashing', state.type === 'flashing');
    this._setTrainText(state.trainText || '');
    if (this.notificationAnswerBtn) { this.notificationAnswerBtn.textContent = state.buttonText || ''; this.notificationAnswerBtn.style.display = 'block'; }
    if (icon) icon.style.display = 'block';
  },

  renderChat() {
    if (this.messages.length === 0) {
      this.chatEl.innerHTML = '<div class="chat-empty">No messages yet</div>';
      return;
    }

    this.chatEl.innerHTML = this.messages.filter((m) =>
      m.type === 'driver' || m.type === 'signaller' || m.type === 'system' || m.type === 'reply-options' || m.type === 'loading' || m.type === 'greeting' || m.type === 'text-input'
    ).map((msg) => {
      if (msg.type === 'greeting') {
        const textLink = msg.hasTextOption ? ' <span class="use-text-link">use text</span>' : '';
        return `<div class="chat-message chat-greeting">
          <div class="chat-message-label">SPEAK NOW${textLink}</div>
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
      if (msg.type === 'signaller') {
        return `<div class="chat-message chat-signaller">
          <div class="chat-message-text">${this.escapeHtml(msg.text)}</div>
        </div>`;
      }
      if (msg.type === 'system') {
        return `<div class="chat-message chat-system">
          <div class="chat-message-text">${this.escapeHtml(msg.text)}</div>
        </div>`;
      }
      if (msg.type === 'reply-options') {
        const replies = msg.replies || [];
        const hc = this.currentHeadCode || '';
        const sig = this.currentSignalId || '';
        const sigRef = sig ? ` signal ${sig}` : '';

        // Route query — show 2 custom options, both send the wait reply
        if (this.isRouteQuery) {
          const waitIdx = replies.findIndex((r) => /wait\s+\d+\s*min/i.test(r));
          const wm = waitIdx >= 0 ? replies[waitIdx].match(/wait\s+(\d+)\s*min/i) : null;
          const mins = wm ? wm[1] : '5';
          const idx = waitIdx >= 0 ? waitIdx : 0;
          const via = this.escapeHtml(this._routeQueryVia || 'your booked location');
          const items = [
            { html: `Hello driver of ${this.escapeHtml(hc)} at ${this.escapeHtml(sig)}. Please wait at ${this.escapeHtml(sig)} for ${mins} minutes while I speak with Route Control.`, replyIndex: idx },
            { html: `Hello driver of ${this.escapeHtml(hc)} at ${this.escapeHtml(sig)}. Please wait at ${this.escapeHtml(sig)} for ${mins} minutes. I will reset the route so you are able to pass via ${via}.`, replyIndex: idx },
          ];
          const optionsHtml = items.map((item) => `<li data-reply-index="${item.replyIndex}">${item.html}</li>`).join('');
          return `<div class="chat-message chat-reply-options">
            <div class="chat-message-label">YOUR REPLY OPTIONS</div>
            <ol class="reply-options-list">${optionsHtml}</ol>
            ${msg.time ? `<div class="chat-message-time">${this.escapeHtml(msg.time)}</div>` : ''}
          </div>`;
        }

        // Group wait options into one line, keep others separate
        const waitIndices = [];
        const waitMins = [];
        const callBackIndices = [];
        const callBackMins = [];
        let bookedReply = null;
        const otherReplies = [];
        replies.forEach((r, i) => {
          const wm = r.match(/wait\s+(\d+)\s*min/i);
          const cbm = r.match(/call\s*back\s+in\s+(\d+)\s*min/i);
          const bm = r.match(/wait\s+(?:for\s+)?booked\s+(\d{2}:\d{2})/i);
          if (bm) {
            bookedReply = { index: i, time: bm[1] };
          } else if (wm) {
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
        if (bookedReply) {
          items.push({ html: `Driver, as you are running early, wait at${this.escapeHtml(sigRef)} until your booked time of ${bookedReply.time}, before calling back`, replyIndex: bookedReply.index });
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
            if (this.isShunterCall) {
              items.push({ html: `Hello Shunter, call back in ${timeParts} minutes.`, replyIndex: -1 });
            } else {
              items.push({ html: `Driver, Please call back in ${timeParts} minutes.`, replyIndex: -1 });
            }
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
      if (msg.type === 'text-input') {
        return `<div class="chat-message chat-text-input">
          <div class="chat-message-label">${this.escapeHtml(msg.label || 'ENTER VALUE')}</div>
          <div class="chat-input-row">
            <input type="text" class="chat-text-field" placeholder="${this.escapeHtml(msg.placeholder || '')}" />
            <button class="chat-text-submit">Send</button>
          </div>
        </div>`;
      }
      return '';
    }).join('');

    this.chatEl.scrollTop = this.chatEl.scrollHeight;

    // Auto-focus text input if present
    const textField = this.chatEl.querySelector('.chat-text-field');
    if (textField) textField.focus();
  },

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },

  // ── Player-to-Player Calls ──────────────────────────────────────────

  _playerCall: false,           // true when in a player call
  _playerCallPanel: '',         // peer's panel name
  _playerCallPeerId: null,      // peer's relay ID (for WebRTC signaling)
  _playerDialing: false,        // true while dialing a player
  _playerPeerConnection: null,  // RTCPeerConnection
  _playerLocalStream: null,     // local mic stream
  _playerRemoteAudio: null,     // Audio element for remote stream
  _playerPttListener: null,
  _webRTCSettingUp: false,      // true while getUserMedia is pending (signals buffered)
  _pendingWebRTCSignals: null,  // signals buffered during setup

  // Called when user dials a player from the Global phonebook
  async dialPlayer(peer) {
    if (this._playerCall || this._playerDialing || this.inCall || this._outgoingCall) return;
    this._playerDialing = true;
    this._playerCallPanel = peer.panel;

    // Show dialing notification (reuses existing UI)
    this.showDialingNotification(peer.panel);

    // Set up notification answer button as cancel
    const cancelHandler = () => {
      if (this._playerDialing) {
        window.simsigAPI.player.cancelDial();
        this._playerDialing = false;
        this.stopDialing();
      }
    };
    if (this.notificationAnswerBtn) {
      this.notificationAnswerBtn.onclick = cancelHandler;
    }

    // Actually dial via main process
    const result = await window.simsigAPI.player.dial(peer.id);
    if (this.notificationAnswerBtn) this.notificationAnswerBtn.onclick = null;

    if (!this._playerDialing) return; // cancelled
    this._playerDialing = false;

    if (result.error) {
      this.stopDialing();
      return;
    }

    // Call connected — stop the dialing tone before entering call
    this.stopDialing(true);
    const peerId = result.peerId || peer.id;
    this._startPlayerCall(peer.panel, peerId, true);
  },

  // Called when we receive an incoming player call
  handleIncomingPlayerCall(peerPanel, peerId) {
    if (this.inCall || this._outgoingCall || this._playerCall || this._playerDialing || this._dialingActive || this._playerRinging) {
      // Busy — auto-reject happens in main process
      return;
    }
    this._playerRinging = true;
    this._playerCallPanel = peerPanel;
    this._playerCallPeerId = peerId;

    // Show incoming call notification
    this.stopRinging();
    if (this.notificationEl) {
      this.notificationEl.classList.remove('in-call');
      this.notificationEl.classList.add('flashing');
      const readyText = this.notificationEl.querySelector('#notification-ready-text');
      if (readyText) readyText.style.display = 'none';
      this._setTrainText(peerPanel);
      if (this.notificationAnswerBtn) {
        this.notificationAnswerBtn.textContent = '[Answer]';
        this.notificationAnswerBtn.style.display = 'block';
      }
      const icon = this.notificationEl.querySelector('#notification-icon');
      if (icon) icon.style.display = 'block';
    }

    // Start ringing sound
    this.startRinging();

    // Answer button handler
    const answerHandler = () => {
      this._playerRinging = false;
      this.stopRinging();
      window.simsigAPI.player.answer();
      this._startPlayerCall(peerPanel, this._playerCallPeerId, false);
    };

    if (this.notificationAnswerBtn) {
      this.notificationAnswerBtn.onclick = answerHandler;
    }

    // Also wire up the keybind answer
    this._playerAnswerHandler = answerHandler;

    // Set up reject on silence btn or after timeout
    // (auto-reject handled in main process after 30s)
  },

  handlePlayerCallAnswered(data) {
    // For incoming call that we answered — WebRTC already set up as answerer
    // For outgoing call — _startPlayerCall already called from dialPlayer (as offer)
  },

  handlePlayerCallEnded() {
    console.log('[PlayerCall] handlePlayerCallEnded — ringing:', this._playerRinging, 'inCall:', this._playerCall, 'dialing:', this._playerDialing);
    this._endPlayerCall('Peer hung up');
  },

  handlePlayerCallRejected(reason) {
    this._playerDialing = false;
    this.stopDialing();
  },

  handleWebRTCSignal(data) {
    const { signal } = data;
    const log = (msg) => { console.log(msg); window.simsigAPI.app.log(msg); };
    log(`[WebRTC] handleWebRTCSignal: ${signal?.type}, pc=${!!this._playerPeerConnection}, setting=${this._webRTCSettingUp}`);
    if (!this._playerPeerConnection || this._webRTCSettingUp) {
      // PC not ready yet — buffer until _setupWebRTC completes
      if (!this._pendingWebRTCSignals) this._pendingWebRTCSignals = [];
      this._pendingWebRTCSignals.push(signal);
      log(`[WebRTC] Buffered ${signal?.type} (${this._pendingWebRTCSignals.length} pending)`);
      return;
    }
    this._processWebRTCSignal(signal);
  },

  _flushPendingIce() {
    const pc = this._playerPeerConnection;
    if (!pc || !this._pendingIceCandidates?.length) return;
    const log = (msg) => { console.log(msg); window.simsigAPI.app.log(msg); };
    log(`[WebRTC] Flushing ${this._pendingIceCandidates.length} buffered ICE candidates`);
    for (const candidate of this._pendingIceCandidates) {
      pc.addIceCandidate(candidate).catch(err => log(`[WebRTC] addIceCandidate error: ${err}`));
    }
    this._pendingIceCandidates = [];
  },

  _processWebRTCSignal(signal) {
    const pc = this._playerPeerConnection;
    if (!pc) return;
    const log = (msg) => { console.log(msg); window.simsigAPI.app.log(msg); };
    if (signal.type === 'offer') {
      log('[WebRTC] Processing offer — setRemoteDescription → createAnswer → setLocalDescription');
      pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp })
        .then(() => { this._flushPendingIce(); return pc.createAnswer(); })
        .then(answer => pc.setLocalDescription(answer).then(() => {
          log('[WebRTC] Answer set — sending answer');
          window.simsigAPI.player.sendWebRTCSignal(this._playerCallPeerId, { type: 'answer', sdp: answer.sdp });
        }))
        .catch(err => log(`[WebRTC] offer/answer error: ${err}`));
    } else if (signal.type === 'answer') {
      log('[WebRTC] Processing answer — setRemoteDescription');
      pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp })
        .then(() => { log('[WebRTC] Remote description set OK'); this._flushPendingIce(); })
        .catch(err => log(`[WebRTC] setRemoteDescription error: ${err}`));
    } else if (signal.type === 'ice') {
      if (!pc.remoteDescription) {
        if (!this._pendingIceCandidates) this._pendingIceCandidates = [];
        this._pendingIceCandidates.push(signal.candidate);
        log(`[WebRTC] Buffered ICE candidate (${this._pendingIceCandidates.length} pending, no remote desc yet)`);
      } else {
        pc.addIceCandidate(signal.candidate)
          .catch(err => log(`[WebRTC] addIceCandidate error: ${err}`));
      }
    }
  },

  _startPlayerCall(peerPanel, peerId, isOffer) {
    this._playerCall = true;
    this._playerCallPanel = peerPanel;
    this._playerCallPeerId = peerId;
    window.simsigAPI.keys.setInCall(true);

    // Update notification to "in call"
    this.stopRinging();
    if (this.notificationEl) {
      this.notificationEl.classList.remove('flashing');
      this.notificationEl.classList.add('in-call');
      this._setTrainText(peerPanel);
      if (this.notificationAnswerBtn) {
        this.notificationAnswerBtn.textContent = '[Hang Up]';
        this.notificationAnswerBtn.style.display = 'block';
        this.notificationAnswerBtn.onclick = () => this.hangUpPlayerCall();
      }
    }

    // Update radio display
    const radioDisplay = document.getElementById('radio-display');
    const line1 = document.getElementById('display-line-1');
    const line2 = document.getElementById('display-line-2');
    if (radioDisplay) radioDisplay.classList.add('in-call');
    if (line1) line1.textContent = 'Player Call';
    if (line2) line2.textContent = peerPanel;

    // Start background noise (radio static)
    this.bgCallerType = 'signaller';
    this.startBgNoise();

    // Set up WebRTC connection
    this._setupWebRTC(isOffer);
  },

  async _setupWebRTC(isOffer) {
    // STUN for direct P2P + TURN relay for when NAT blocks direct UDP
    const STUN = { iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      {
        urls: [
          'turn:openrelay.metered.ca:80',
          'turn:openrelay.metered.ca:80?transport=tcp',
          'turn:openrelay.metered.ca:443',
          'turn:openrelay.metered.ca:443?transport=tcp',
        ],
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
    ] };
    const pc = new RTCPeerConnection(STUN);

    // Set PC immediately so ICE/answer signals can be buffered rather than dropped
    this._playerPeerConnection = pc;
    this._webRTCSettingUp = true; // block signal processing until tracks are added
    this._pendingWebRTCSignals = [];

    // Remote audio
    pc.ontrack = (event) => {
      const msg = `[WebRTC] ontrack — kind: ${event.track.kind}, streams: ${event.streams.length}`;
      const iceAtTrack = `[WebRTC] ontrack — kind: ${event.track.kind}, streams: ${event.streams.length}, ICE state at track: ${pc.iceConnectionState}`;
      console.log(iceAtTrack);
      window.simsigAPI.app.log(iceAtTrack);
      if (!this._playerRemoteAudio) {
        this._playerRemoteAudio = document.createElement('audio');
        this._playerRemoteAudio.autoplay = true;
        this._playerRemoteAudio.volume = 1.0;
        document.body.appendChild(this._playerRemoteAudio);
      }
      this._playerRemoteAudio.srcObject = event.streams[0] || new MediaStream([event.track]);
      this._playerRemoteAudio.play().then(() => {
        window.simsigAPI.app.log('[WebRTC] Remote audio playing');
      }).catch(err => {
        const e = `[WebRTC] Remote audio play() failed: ${err}`;
        console.warn(e);
        window.simsigAPI.app.log(e);
      });
    };

    // ICE connection state — log for diagnostics (piped to main process terminal)
    pc.oniceconnectionstatechange = () => {
      const msg = `[WebRTC] ICE state: ${pc.iceConnectionState}`;
      console.log(msg);
      window.simsigAPI.app.log(msg);
    };

    pc.onconnectionstatechange = () => {
      const msg = `[WebRTC] Connection state: ${pc.connectionState}`;
      console.log(msg);
      window.simsigAPI.app.log(msg);
    };

    // Poll ICE state and RTP stats every 2s
    let lastBytesSent = 0, lastBytesRecv = 0;
    const statePoller = setInterval(async () => {
      if (!this._playerPeerConnection || this._playerPeerConnection !== pc) { clearInterval(statePoller); return; }
      const ice = pc.iceConnectionState, conn = pc.connectionState;
      try {
        const stats = await pc.getStats();
        let bytesSent = 0, bytesRecv = 0, pktSent = 0, pktRecv = 0;
        stats.forEach(s => {
          if (s.type === 'outbound-rtp' && s.kind === 'audio') { bytesSent = s.bytesSent || 0; pktSent = s.packetsSent || 0; }
          if (s.type === 'inbound-rtp'  && s.kind === 'audio') { bytesRecv = s.bytesReceived || 0; pktRecv = s.packetsReceived || 0; }
        });
        const sentDelta = bytesSent - lastBytesSent;
        const recvDelta = bytesRecv - lastBytesRecv;
        lastBytesSent = bytesSent; lastBytesRecv = bytesRecv;
        window.simsigAPI.app.log(`[WebRTC] ICE:${ice} conn:${conn} | sent:${pktSent}pkts(+${sentDelta}B) recv:${pktRecv}pkts(+${recvDelta}B)`);
      } catch (_) {
        window.simsigAPI.app.log(`[WebRTC] Poll — ICE: ${ice}, conn: ${conn}`);
      }
      if (ice === 'failed' || ice === 'closed' || conn === 'failed' || conn === 'closed') clearInterval(statePoller);
    }, 2000);

    // ICE candidates — forward via relay
    pc.onicecandidate = (event) => {
      if (event.candidate && this._playerCallPeerId) {
        const c = event.candidate;
        window.simsigAPI.app.log(`[WebRTC] ICE candidate: ${c.type || 'unknown'} ${c.protocol || ''} ${c.address || ''}`);
        // Use toJSON() — RTCIceCandidate is a DOM object and won't survive contextBridge/IPC
        window.simsigAPI.player.sendWebRTCSignal(this._playerCallPeerId, {
          type: 'ice', candidate: c.toJSON(),
        });
      }
    };

    // Get mic stream — muted by default (PTT controls it)
    let localStream = null;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      this._playerLocalStream = localStream;
    } catch (err) {
      console.error('[WebRTC] getUserMedia error:', err);
    }

    if (localStream) {
      for (const track of localStream.getAudioTracks()) {
        track.enabled = false; // start muted — PTT unmutes
        pc.addTrack(track, localStream);
      }
    }

    // PTT controls the local audio track
    this._playerPttListener = window.simsigAPI.ptt.onStateChange((active) => {
      if (!this._playerCall || !this._playerLocalStream) return;
      for (const track of this._playerLocalStream.getAudioTracks()) {
        track.enabled = active;
      }
      window.simsigAPI.app.log(`[WebRTC] PTT ${active ? 'ON — transmitting' : 'OFF — muted'}`);
    });

    // Tracks added — now safe to process signals
    this._webRTCSettingUp = false;

    if (isOffer) {
      const log = (msg) => { console.log(msg); window.simsigAPI.app.log(msg); };
      log('[WebRTC] createOffer — creating offer');
      pc.createOffer()
        .then(offer => pc.setLocalDescription(offer).then(() => {
          log('[WebRTC] Offer set — sending offer');
          window.simsigAPI.player.sendWebRTCSignal(this._playerCallPeerId, { type: 'offer', sdp: offer.sdp });
        }))
        .catch(err => log(`[WebRTC] createOffer error: ${err}`));
    }

    // Flush any signals that arrived while we were waiting for getUserMedia
    const pending = this._pendingWebRTCSignals || [];
    this._pendingWebRTCSignals = null;
    for (const signal of pending) {
      this._processWebRTCSignal(signal);
    }
  },

  _closeWebRTC() {
    if (this._playerPttListener) { this._playerPttListener(); this._playerPttListener = null; }
    if (this._playerLocalStream) {
      this._playerLocalStream.getTracks().forEach(t => t.stop());
      this._playerLocalStream = null;
    }
    if (this._playerRemoteAudio) {
      this._playerRemoteAudio.srcObject = null;
      if (this._playerRemoteAudio.parentNode) this._playerRemoteAudio.parentNode.removeChild(this._playerRemoteAudio);
      this._playerRemoteAudio = null;
    }
    if (this._playerPeerConnection) {
      this._playerPeerConnection.close();
      this._playerPeerConnection = null;
    }
    this._webRTCSettingUp = false;
    this._pendingWebRTCSignals = null;
    this._pendingIceCandidates = null;
  },

  hangUpPlayerCall() {
    window.simsigAPI.player.hangUp();
    this._endPlayerCall('Call ended');
  },

  _endPlayerCall(reason) {
    console.log('[PlayerCall] _endPlayerCall:', reason, 'call:', this._playerCall, 'dialing:', this._playerDialing, 'ringing:', this._playerRinging);
    if (!this._playerCall && !this._playerDialing && !this._playerRinging) {
      console.log('[PlayerCall] _endPlayerCall — no active state, skipping');
      return;
    }
    this._playerRinging = false;
    this._closeWebRTC();
    this.stopBgNoise();
    this.stopRinging();

    this._playerCall = false;
    this._playerDialing = false;
    this._playerCallPeerId = null;
    window.simsigAPI.keys.setInCall(false);

    // Clean up notification button handler
    if (this.notificationAnswerBtn) this.notificationAnswerBtn.onclick = null;

    if (this._playerAnswerHandler) {
      this._playerAnswerHandler = null;
    }

    this.hideNotification();

    // Reset radio display
    const radioDisplay = document.getElementById('radio-display');
    const line1 = document.getElementById('display-line-1');
    const line2 = document.getElementById('display-line-2');
    if (radioDisplay) radioDisplay.classList.remove('in-call');
    if (line1) line1.textContent = 'GSM-R';
    if (line2) line2.textContent = 'Ready';

    this._resumeIncoming();
  },
};
