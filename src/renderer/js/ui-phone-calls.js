const PhoneCallsUI = {
  listEl: null,
  countEl: null,
  chatEl: null,
  calls: [],
  messages: [],
  ringingAudio: null,
  wasRinging: false,
  inCall: false,
  voiceCache: {},       // caller → voice ID (ElevenLabs) or local profile
  elevenVoices: null,   // cached list of British voices from ElevenLabs

  init() {
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

    this.ringingAudio = new Audio('../../sounds/ringing.wav');
    this.ringingAudio.loop = true;

    // Silence ring for this call only
    this.silenceBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.silenced = true;
      this.ringingAudio.pause();
      this.ringingAudio.currentTime = 0;
      this.silenceBtn.classList.add('hidden');
    });

    // Click the notification box to answer the latest call or end the current call
    this.notificationEl.addEventListener('click', () => {
      if (this.inCall) {
        this.hangUp();
      } else if (this.calls.length > 0) {
        this.answerCall(this.calls.length - 1);
      }
    });

    // Gapless background noise via Web Audio API — alternate between two clips
    this.bgCtx = new AudioContext();
    this.bgBuffers = [];
    this.bgBufferIndex = 0;
    this.bgSource = null;
    this.bgGain = this.bgCtx.createGain();
    this.bgGain.connect(this.bgCtx.destination);
    this.bgGain.gain.value = 0.5;
    const bgFiles = ['../../sounds/background.wav', '../../sounds/background2.wav'];
    Promise.all(bgFiles.map((f) =>
      fetch(f).then((r) => r.arrayBuffer()).then((buf) => this.bgCtx.decodeAudioData(buf))
    )).then((buffers) => { this.bgBuffers = buffers; }).catch(() => {});

    // Pre-warm local voices as fallback
    speechSynthesis.getVoices();
    speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();

    // Pre-fetch ElevenLabs voices so first TTS is instant
    this.getElevenVoices();

    this.renderChat();
  },

  update(calls) {
    this.calls = calls || [];

    if (this.calls.length > 0 && !this.wasRinging && !this.inCall) {
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
    this.wasRinging = true;
    this.silenced = false;
    this.silenceBtn.classList.remove('hidden');
    if (this.isPaused()) return;
    this.ringingAudio.currentTime = 0;
    this.ringingAudio.play().catch(() => {});
  },

  stopRinging() {
    this.wasRinging = false;
    this.silenced = false;
    this.silenceBtn.classList.add('hidden');
    this.ringingAudio.pause();
    this.ringingAudio.currentTime = 0;
  },

  // Silence all audio immediately (called when sim pauses)
  muteAll() {
    this.ringingAudio.pause();
    this.ringingAudio.currentTime = 0;
  },

  // Resume ringing if calls are waiting (called when sim unpauses)
  resumeRinging() {
    if (this.calls.length > 0 && this.wasRinging && !this.inCall && !this.silenced) {
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

  // Fetch ElevenLabs British voices (cached)
  async getElevenVoices() {
    if (this.elevenVoices) return this.elevenVoices;
    try {
      const voices = await window.simsigAPI.tts.getVoices();
      this.elevenVoices = voices && voices.length > 0 ? voices : null;
      return this.elevenVoices;
    } catch {
      return null;
    }
  },

  // Pick a consistent ElevenLabs voice for a caller
  getElevenVoiceId(caller, voices) {
    if (this.voiceCache[caller]) return this.voiceCache[caller];
    const hash = this.hashString(caller);
    const voice = voices[hash % voices.length];
    this.voiceCache[caller] = voice.id;
    return voice.id;
  },

  // Fetch TTS audio from ElevenLabs (returns audioData bytes, does NOT play)
  async fetchElevenLabsAudio(text, voiceId) {
    const audioData = await window.simsigAPI.tts.speak(text, voiceId);
    return audioData || null;
  },

  // Start cab background noise (gapless via Web Audio API, alternates clips)
  startBgNoise() {
    if (!this.bgBuffers.length) return;
    if (this.bgSource) { try { this.bgSource.stop(); } catch {} }
    this.bgGain.gain.cancelScheduledValues(this.bgCtx.currentTime);
    this.bgGain.gain.value = 0.5;
    const buffer = this.bgBuffers[this.bgBufferIndex % this.bgBuffers.length];
    this.bgBufferIndex++;
    const source = this.bgCtx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(this.bgGain);
    source.start();
    this.bgSource = source;
  },

  // Fade out and stop cab background noise
  stopBgNoise() {
    if (!this.bgSource) return;
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
      audio.onended = () => { URL.revokeObjectURL(url); this.stopBgNoise(); resolve(true); };
      audio.onerror = () => { URL.revokeObjectURL(url); this.stopBgNoise(); resolve(false); };
      this.startBgNoise();
      audio.play().catch(() => { this.stopBgNoise(); resolve(false); });
    });
  },

  // Speak via ElevenLabs API (main process handles the HTTP call)
  async speakElevenLabs(text, voiceId) {
    const audioData = await this.fetchElevenLabsAudio(text, voiceId);
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

      this.startBgNoise();
      utterance.onend = () => { this.stopBgNoise(); resolve(); };
      utterance.onerror = () => { this.stopBgNoise(); resolve(); };
      speechSynthesis.speak(utterance);
    });
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

  // Build spoken message for CSD entry permission calls
  buildCsdSpokenMessage(panelName, position, csd) {
    const posStr = position ? `, ${position}` : '';
    let msg = `Hello, ${panelName} Signaller${posStr}, this is driver of ${csd.headcode} at ${csd.signal} signal within ${csd.entryPoint}. Request permission to enter`;
    if (csd.nextStop) {
      msg += `, next stop will be ${csd.nextStop}`;
      if (csd.platform) msg += ` Platform ${csd.platform}`;
    }
    return msg;
  },

  // Keyword patterns for matching user speech to SimSig reply options
  // Order matters — more specific patterns first
  REPLY_MATCHERS: [
    { pattern: /pass.*examine|authoris[ez].*pass.*examine|authoris[ez].*examine/, fragment: 'pass signal at stop and examine' },
    { pattern: /(?:15|fifteen|one[\s-]*five|1[\s-]*5)\s*min/, fragment: '15 minute' },
    { pattern: /(?<!\d)(?:0?2|two|to)\s*min/, fragment: '2 minute' },
    { pattern: /(?<!\d)(?:0?5|five)\s*min/, fragment: '5 minute' },
    { pattern: /authoris[ez].*pass|pass.*signal|pass\s*at\s*(?:stop|danger)/, fragment: 'authorise driver to pass' },
    { pattern: /examine.*line|examine\s*the/, fragment: 'examine the line' },
    { pattern: /permission|granted|enter|proceed/, fragment: 'permission granted' },
    { pattern: /understood|continue|obey|speaking.*control/, fragment: 'continue after speaking' },
  ],

  // Match user's spoken text against available reply options
  matchReply(transcript, replies) {
    const text = transcript.toLowerCase();
    for (const matcher of this.REPLY_MATCHERS) {
      if (matcher.pattern.test(text)) {
        const idx = replies.findIndex((r) => r.toLowerCase().includes(matcher.fragment));
        if (idx >= 0) return idx;
      }
    }
    return -1;
  },

  // Wait for PTT press, then record audio until PTT release, then transcribe
  async recordAndTranscribe() {
    try {
      // Wait for PTT press to start
      await this.waitForPTTPress();

      const settingsAll = await window.simsigAPI.settings.getAll();
      const deviceId = settingsAll.audio?.inputDeviceId;
      const constraints = deviceId && deviceId !== 'default'
        ? { audio: { deviceId: { exact: deviceId } } }
        : { audio: true };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);

      // Record while PTT is held
      const audioData = await new Promise((resolve) => {
        const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
        const chunks = [];
        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
        recorder.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          const blob = new Blob(chunks, { type: 'audio/webm' });
          const buffer = await blob.arrayBuffer();
          resolve(Array.from(new Uint8Array(buffer)));
        };

        recorder.start(100);

        // Stop when PTT is released
        this.waitForPTTRelease().then(() => {
          if (recorder.state === 'recording') recorder.stop();
        });
      });

      if (audioData.length < 500) return ''; // too short, nothing said

      console.log(`[STT] Recorded ${audioData.length} bytes, sending for transcription...`);
      const result = await window.simsigAPI.stt.transcribe(audioData);
      console.log('[STT] Result:', result);
      if (result && typeof result === 'object' && result.error) {
        console.error('[STT] Error:', result.error);
        return '';
      }
      return result || '';
    } catch (err) {
      console.error('[STT] Recording error:', err);
      return '';
    }
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

    // Pass signal at danger AND examine the line
    if (/pass.*signal.*at\s*stop.*examine|authoris[ez].*pass.*examine|ask.*pass.*examine/i.test(raw)) {
      return `Driver of ${hc}, this is${panelRef}. I am authorising you to pass${sigRef} at danger. I also require you to examine the line. Proceed at caution to the next signal and be prepared to stop short of any obstruction`;
    }
    // Pass signal at danger only
    if (/authoris[ez].*pass.*signal|ask.*pass.*signal|pass.*signal.*at\s*stop/i.test(raw)) {
      return `Driver of ${hc}, this is${panelRef}. I am authorising you to pass${sigRef} at danger. Proceed at caution to the next signal and be prepared to stop short of any obstruction`;
    }
    // Examine the line only
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
      return `Permission granted, ${permMatch[1]} you may enter`;
    }
    // "Please call back in N minutes"
    const callBackMatch = raw.match(/call\s*back\s+in\s+(\d+)\s*min/i);
    if (callBackMatch) {
      return `Please call back in ${callBackMatch[1]} minutes`;
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

    // Pass signal at danger + examine the line
    if (/pass.*signal.*at\s*(stop|danger).*examine/i.test(lower)) {
      return `Authorised to pass${sigRef} at danger, examine the line to the next signal, proceed at caution${trainRef}. Over`;
    }
    // Pass signal at danger only
    if (/pass.*signal.*at\s*(stop|danger)/i.test(lower)) {
      return `Authorised to pass${sigRef} at danger, proceed at caution to the next signal${trainRef}. Over`;
    }
    // Examine the line only
    if (/examine\s*the\s*line/i.test(lower)) {
      return `Examine the line from${sigRef} to the next signal, proceed at caution and report${trainRef}. Over`;
    }
    // Wait N minutes — no formal readback required, just acknowledge
    const waitMatch = lower.match(/wait\s+(\d+)\s*min/);
    if (waitMatch) {
      const n = parseInt(waitMatch[1], 10);
      const word = this.NUMBERS[n] || waitMatch[1];
      return `Understood, remain at${sigRef} and wait ${word} minutes${trainRef}. Over`;
    }
    // Call back in N minutes
    const callBackMatch = lower.match(/call\s*back\s+in\s+(\d+)\s*min/);
    if (callBackMatch) {
      const n = parseInt(callBackMatch[1], 10);
      const word = this.NUMBERS[n] || callBackMatch[1];
      return `Ok, I will call back in ${word} minutes${trainRef}. Over`;
    }
    // Continue after speaking to control
    if (/continue\s+after\s+speaking/i.test(lower) || /continue.*obey/i.test(lower)) {
      return `Understood, I will continue to obey all other aspects${trainRef}. Over`;
    }
    // Permission granted to enter
    if (/permission\s+granted/i.test(lower)) {
      return 'Thank you, entering now. Over';
    }
    return `Understood${trainRef}. Over`;
  },

  // Send a reply by index — shared by speech, click, and fallback button paths
  async sendReply(replyIndex, replies, caller) {
    // Show loading spinner immediately, send reply + fetch TTS in parallel
    this.addMessage({ type: 'loading', text: 'Driver responding...' });
    const confirmation = this.buildConfirmation(replies[replyIndex]);

    const voices = await this.getElevenVoices();
    let audioPromise = null;
    if (voices && voices.length > 0) {
      const voiceId = this.getElevenVoiceId(caller, voices);
      audioPromise = this.fetchElevenLabsAudio(this.phoneticize(confirmation), voiceId);
    }

    // Send reply to SimSig while TTS generates
    await window.simsigAPI.phone.replyCall(replyIndex, this.currentHeadCode);

    // Remove loading spinner, show confirmation text
    this.messages = this.messages.filter((m) => m.type !== 'loading');
    this.addMessage({ type: 'driver', caller, text: confirmation });

    // Play audio (already fetched or nearly done)
    if (audioPromise) {
      const audioData = await audioPromise;
      const ok = await this.playAudioData(audioData);
      if (!ok) await this.speakLocal(this.phoneticize(confirmation), caller);
    } else {
      await this.speakLocal(this.phoneticize(confirmation), caller);
    }
    this.showHangUpInChat();
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
  async handleReply(replies, caller) {
    // If only "Ok" is available, auto-reply and hang up
    if (replies.length === 1 && /^ok$/i.test(replies[0].trim())) {
      await window.simsigAPI.phone.replyCall(0, this.currentHeadCode);
      this.showHangUpInChat();
      return;
    }

    this._replyClicked = false;
    this.addMessage({ type: 'reply-options', replies });
    this.setupReplyClickHandlers(replies, caller);

    const MAX_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (this._replyClicked) return;
      this.addMessage({ type: 'greeting', text: 'Hold PTT and speak your reply...' });

      let transcript = '';
      try {
        transcript = await this.recordAndTranscribe();
      } catch (e) {
        if (this._replyClicked) return;
        break;
      }
      if (this._replyClicked) return;

      if (transcript) {
        const replyIndex = this.matchReply(transcript, replies);
        if (replyIndex >= 0) {
          await this.sendReply(replyIndex, replies, caller);
          return;
        }
      }

      // Not understood
      const sorry = "Sorry, I didn't understand that. Can you please repeat signaller";
      this.addMessage({ type: 'driver', caller, text: sorry });
      await this.speakAsDriver(sorry, caller);
    }

    if (this._replyClicked) return;

    // After max attempts, fall back to buttons
    this.addMessage({ type: 'system', text: 'Could not match — use buttons below' });
    await this.waitForReplyButton(replies, caller);
  },

  // End-call is handled via the notification box — no chat button needed
  showHangUpInChat() {},

  // Fallback: show clickable buttons for reply options
  waitForReplyButton(replies, caller) {
    return new Promise((resolve) => {
      const container = document.createElement('div');
      container.className = 'reply-buttons';

      const makeHandler = (index, reply) => async () => {
        container.remove();
        await window.simsigAPI.phone.replyCall(index, this.currentHeadCode);
        const confirmation = this.buildConfirmation(reply);
        this.addMessage({ type: 'driver', caller, text: confirmation });
        await this.speakAsDriver(confirmation, caller);
        this.showHangUpInChat();
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

  // Speak as driver — phoneticizes codes, tries ElevenLabs, falls back to local
  async speakAsDriver(text, caller) {
    if (this.isPaused()) return;
    const spoken = this.phoneticize(text);
    const voices = await this.getElevenVoices();
    if (voices && voices.length > 0) {
      const voiceId = this.getElevenVoiceId(caller, voices);
      const ok = await this.speakElevenLabs(spoken, voiceId);
      if (ok) return;
      console.warn('[TTS] ElevenLabs speak failed, falling back to local TTS');
    } else {
      console.warn('[TTS] No ElevenLabs voices available, using local TTS');
    }
    await this.speakLocal(spoken, caller);
  },

  // Wait for user to press and release PTT (signaller speaking)
  async waitForUserSpeech() {
    await this.waitForPTTPress();
    await this.waitForPTTRelease();
  },

  hangUp() {
    this.inCall = false;
    this.messages = [];
    if (this._replyDelegateHandler) {
      this.chatEl.removeEventListener('click', this._replyDelegateHandler);
      this._replyDelegateHandler = null;
    }
    this.renderChat();
    this.hideNotification();
    // If there are waiting calls, show the next one and start ringing
    if (this.calls.length > 0) {
      const nextCall = this.calls[this.calls.length - 1];
      this.showNotification(nextCall.train || '');
      this.startRinging();
    }
  },

  async answerCall(index) {
    this.inCall = true;
    this.stopRinging();

    const call = this.calls[index];
    const train = call ? call.train : '';
    this.showInCallNotification(train);

    const btn = this.listEl.querySelector(`.call-answer-btn[data-index="${index}"]`);
    if (btn) {
      btn.textContent = '...';
      btn.disabled = true;
    }

    this.addMessage({ type: 'system', text: 'Answering...' });

    // Fetch settings + voices IN PARALLEL with the PowerShell answer script
    // so they're ready the instant the answer result comes back
    const [result, settingsAll, voices] = await Promise.all([
      window.simsigAPI.phone.answerCall(index, train),
      window.simsigAPI.settings.getAll(),
      this.getElevenVoices(),
    ]);

    if (result.error) {
      this.addMessage({ type: 'error', text: result.error });
      return;
    }

    // Build greeting and driver message — settings + voices already loaded
    const panelName = settingsAll.signaller?.panelName || 'Panel';
    const position = this.extractPosition(result.title);
    const greeting = `Hello, ${panelName} Signaller${position ? ', ' + position : ''}, Go ahead`;
    const caller = (result.title || '').replace(/^Answer call from\s*/i, '') || result.train || '';
    const driverMsg = result.message || '';
    const csd = this.parseCsdMessage(driverMsg);

    // Extract signal and headcode EARLY so formatReplyOption can use them
    const sigMatch = driverMsg.match(/signal\s+([A-Z0-9]+)/i);
    this.currentSignalId = sigMatch ? sigMatch[1] : null;
    const titleMatch = (result.title || '').match(/([0-9][A-Z][0-9]{2})/i);
    const trainMatch = (result.train || train).match(/([0-9][A-Z][0-9]{2})/i);
    this.currentHeadCode = titleMatch ? titleMatch[1].toUpperCase()
      : trainMatch ? trainMatch[1].toUpperCase()
      : (result.train || train).trim();
    this.currentPanelName = panelName;

    // Build display and spoken messages based on call type
    let displayMsg, spokenMsg;
    if (csd) {
      displayMsg = `${csd.headcode} is ready at entry point ${csd.entryPoint} (${csd.signal}). Permission required to enter.`;
      spokenMsg = this.buildCsdSpokenMessage(panelName, position, csd);
    } else if (this.currentSignalId) {
      // Red signal / waiting at signal scenario
      displayMsg = `${this.currentHeadCode} waiting at red signal ${this.currentSignalId}`;
      spokenMsg = `Hello Signaller, this is driver of ${this.currentHeadCode}. I am at signal ${this.currentSignalId} displaying red`;
    } else {
      displayMsg = driverMsg;
      spokenMsg = `Hello, ${panelName} Signaller${position ? ', ' + position : ''}, this is ${driverMsg}`;
    }

    // Pre-generate TTS audio IN PARALLEL while user speaks the greeting
    let prefetchedAudio = null;
    let voiceId = null;
    if (voices && voices.length > 0) {
      voiceId = this.getElevenVoiceId(caller, voices);
      // Start fetching audio immediately — don't wait for user to finish speaking
      const audioPromise = this.fetchElevenLabsAudio(this.phoneticize(spokenMsg), voiceId);

      // Show greeting and wait for user speech AT THE SAME TIME as audio generates
      this.addMessage({ type: 'greeting', text: greeting });
      const [audio] = await Promise.all([audioPromise, this.waitForUserSpeech()]);
      prefetchedAudio = audio;
    } else {
      this.addMessage({ type: 'greeting', text: greeting });
      await this.waitForUserSpeech();
    }

    // Show driver message and play TTS
    this.addMessage({ type: 'driver', caller, text: displayMsg });

    if (prefetchedAudio) {
      const ok = await this.playAudioData(prefetchedAudio);
      if (!ok) await this.speakLocal(this.phoneticize(spokenMsg), caller);
    } else {
      await this.speakLocal(this.phoneticize(spokenMsg), caller);
    }
    console.log(`[Phone] Title: "${result.title}", Train: "${result.train}", HeadCode: "${this.currentHeadCode}"`);

    // Handle reply if reply options available
    if (result.replies && result.replies.length > 0) {
      await this.handleReply(result.replies, caller);
    }
  },

  addMessage(msg) {
    const now = new Date();
    const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    this.messages.push({ ...msg, time });
    this.renderChat();
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
        const trainText = this.escapeHtml(call.train || '');
        const headMatch = trainText.match(/([0-9][A-Z][0-9]{2})/i);
        const headcode = headMatch ? headMatch[1].toUpperCase() : trainText;
        return `<tr>
          <td class="col-train">${headcode}</td>
          <td class="col-signal"></td>
          <td class="col-action">
            <button class="call-answer-btn" data-index="${i}">Answer</button>
          </td>
        </tr>`;
      }).join('');

      // Only flash notification for new calls if not already in a call
      if (!this.inCall) {
        const latestCall = this.calls[this.calls.length - 1];
        this.showNotification(latestCall.train || '');
      }
    }

    this.listEl.querySelectorAll('.call-answer-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.target.dataset.index, 10);
        this.answerCall(idx);
      });
    });
  },

  showInCallNotification(trainText) {
    if (!this.notificationEl) return;
    const match = (trainText || '').match(/([0-9][A-Z][0-9]{2})/i);
    const headcode = match ? match[1].toUpperCase() : trainText || '';
    this.notificationEl.classList.remove('flashing');
    this.notificationEl.classList.add('in-call');
    this.notificationTrainEl.textContent = headcode;
    if (this.notificationSignalEl) this.notificationSignalEl.textContent = '';
    if (this.notificationAnswerBtn) this.notificationAnswerBtn.textContent = '[End Call]';
  },

  showNotification(trainText) {
    if (!this.notificationEl) return;
    const match = trainText.match(/([0-9][A-Z][0-9]{2})/i);
    const headcode = match ? match[1].toUpperCase() : trainText;
    this.notificationTrainEl.textContent = headcode;
    if (this.notificationSignalEl) this.notificationSignalEl.textContent = '';
    this.notificationEl.classList.add('flashing');
  },

  hideNotification() {
    if (!this.notificationEl) return;
    this.notificationEl.classList.remove('flashing');
    this.notificationEl.classList.remove('in-call');
    this.notificationTrainEl.textContent = '';
    if (this.notificationSignalEl) this.notificationSignalEl.textContent = '';
    if (this.notificationAnswerBtn) this.notificationAnswerBtn.textContent = '[Answer]';
  },

  renderChat() {
    if (this.messages.length === 0) {
      this.chatEl.innerHTML = '<div class="chat-empty">No driver messages yet</div>';
      return;
    }

    this.chatEl.innerHTML = this.messages.map((msg) => {
      if (msg.type === 'greeting') {
        return `<div class="chat-message chat-greeting">
          <div class="chat-message-label">SPEAK NOW</div>
          <div class="chat-message-text">${this.escapeHtml(msg.text)}</div>
          <div class="chat-message-time">${this.escapeHtml(msg.time)}</div>
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
          <div class="chat-message-time">${this.escapeHtml(msg.time)}</div>
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
        const otherReplies = [];
        replies.forEach((r, i) => {
          const wm = r.match(/wait\s+(\d+)\s*min/i);
          if (wm) {
            waitIndices.push(i);
            waitMins.push(wm[1]);
          } else {
            otherReplies.push({ raw: r, index: i });
          }
        });

        const items = [];
        if (waitMins.length > 0) {
          const timeParts = waitMins.map((m) =>
            `<span class="wait-time-choice" data-index="${waitIndices[waitMins.indexOf(m)]}">${m}</span>`
          ).join(' / ');
          items.push({ html: `${this.escapeHtml(hc)}, correct. Remain at${this.escapeHtml(sigRef)}. Standby for ${timeParts} minutes before phoning back`, replyIndex: -1 });
        }
        otherReplies.forEach((o) => {
          items.push({ html: this.escapeHtml(this.formatReplyOption(o.raw)), replyIndex: o.index });
        });

        const optionsHtml = items.map((item) => `<li data-reply-index="${item.replyIndex}">${item.html}</li>`).join('');
        return `<div class="chat-message chat-reply-options">
          <div class="chat-message-label">YOUR REPLY OPTIONS</div>
          <ol class="reply-options-list">${optionsHtml}</ol>
          <div class="chat-message-time">${this.escapeHtml(msg.time)}</div>
        </div>`;
      }
      if (msg.type === 'system') {
        return `<div class="chat-message chat-system">
          <div class="chat-message-text">${this.escapeHtml(msg.text)}</div>
          <div class="chat-message-time">${this.escapeHtml(msg.time)}</div>
        </div>`;
      }
      return `<div class="chat-message chat-error">
        <div class="chat-message-text">${this.escapeHtml(msg.text)}</div>
        <div class="chat-message-time">${this.escapeHtml(msg.time)}</div>
      </div>`;
    }).join('');

    this.chatEl.scrollTop = this.chatEl.scrollHeight;
  },

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },
};
