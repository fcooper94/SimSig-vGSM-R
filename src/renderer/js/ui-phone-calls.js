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

  startRinging() {
    this.wasRinging = true;
    this.silenced = false;
    this.silenceBtn.classList.remove('hidden');
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
    K: 'Kilo', L: 'Lima', M: 'Mike', N: 'November', O: 'Oscar',
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

  // Keyword patterns for matching user speech to SimSig reply options
  // Order matters — more specific patterns first
  REPLY_MATCHERS: [
    { pattern: /pass.*examine|authoris[ez].*pass.*examine|authoris[ez].*examine/, fragment: 'pass signal at stop and examine' },
    { pattern: /(?:15|fifteen|one[\s-]*five|1[\s-]*5)\s*min/, fragment: 'wait 15 minute' },
    { pattern: /(?<!\d)(?:0?2|two|to)\s*min/, fragment: 'wait 2 minute' },
    { pattern: /(?<!\d)(?:0?5|five)\s*min/, fragment: 'wait 5 minute' },
    { pattern: /authoris[ez].*pass|pass.*signal|pass\s*at\s*(?:stop|danger)/, fragment: 'authorise driver to pass' },
    { pattern: /examine.*line|examine\s*the/, fragment: 'examine the line' },
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
    return new Promise((resolve) => {
      if (typeof PTTUI !== 'undefined' && PTTUI.isActive) {
        resolve();
        return;
      }
      const check = () => {
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

  // Build driver readback confirmation for a reply
  buildConfirmation(replyText) {
    const lower = replyText.toLowerCase();
    const signalId = this.currentSignalId || '';
    // "Pass signal at danger" readback with signal ID
    if (/pass.*signal/i.test(lower) && !/examine/i.test(lower) && signalId) {
      return `Ok, I will pass signal ${signalId} at danger. I will obey all other signals. Over`;
    }
    return `Ok, I will ${lower}, over`;
  },

  // Full reply flow: show options, listen for speech, match keywords, send to SimSig
  async handleReply(replies, caller) {
    // If only "Ok" is available, auto-reply and hang up
    if (replies.length === 1 && /^ok$/i.test(replies[0].trim())) {
      await window.simsigAPI.phone.replyCall(0, this.currentHeadCode);
      this.showHangUpInChat();
      return;
    }

    this.addMessage({ type: 'reply-options', replies });

    const MAX_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      this.addMessage({ type: 'greeting', text: 'Hold PTT and speak your reply...' });
      const transcript = await this.recordAndTranscribe();

      if (transcript) {
        const replyIndex = this.matchReply(transcript, replies);
        if (replyIndex >= 0) {
          await window.simsigAPI.phone.replyCall(replyIndex, this.currentHeadCode);
          const confirmation = this.buildConfirmation(replies[replyIndex]);
          this.addMessage({ type: 'driver', caller, text: confirmation });
          await this.speakAsDriver(confirmation, caller);
          this.showHangUpInChat();
          return;
        }
      }

      // Not understood
      const sorry = "Sorry, I didn't understand that. Can you please repeat signaller";
      this.addMessage({ type: 'driver', caller, text: sorry });
      await this.speakAsDriver(sorry, caller);
    }

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
      replies.forEach((reply, i) => {
        const btn = document.createElement('button');
        btn.className = 'reply-btn';
        btn.textContent = reply;
        btn.addEventListener('click', async () => {
          container.remove();
          await window.simsigAPI.phone.replyCall(i, this.currentHeadCode);
          const confirmation = this.buildConfirmation(reply);
          this.addMessage({ type: 'driver', caller, text: confirmation });
          await this.speakAsDriver(confirmation, caller);
          this.showHangUpInChat();
          resolve();
        });
        container.appendChild(btn);
      });
      this.chatEl.appendChild(container);
      this.chatEl.scrollTop = this.chatEl.scrollHeight;
    });
  },

  // Speak as driver — phoneticizes codes, tries ElevenLabs, falls back to local
  async speakAsDriver(text, caller) {
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
    const spokenMsg = `Hello, ${panelName} Signaller${position ? ', ' + position : ''}, this is ${driverMsg}`;

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

    // Show driver message and play pre-fetched audio instantly
    this.addMessage({ type: 'driver', caller, text: driverMsg });

    if (prefetchedAudio) {
      const ok = await this.playAudioData(prefetchedAudio);
      if (!ok) await this.speakLocal(this.phoneticize(spokenMsg), caller);
    } else {
      await this.speakLocal(this.phoneticize(spokenMsg), caller);
    }

    // Extract signal ID from driver's message for use in confirmations
    const sigMatch = driverMsg.match(/signal\s+([A-Z0-9]+)/i);
    this.currentSignalId = sigMatch ? sigMatch[1] : null;

    // Extract headcode from the dialog title (e.g. "Answer call from Train 1C33 (Cross)")
    // This is the most reliable source — it's the actual train SimSig answered
    const titleMatch = (result.title || '').match(/([0-9][A-Z][0-9]{2})/i);
    const trainMatch = (result.train || train).match(/([0-9][A-Z][0-9]{2})/i);
    this.currentHeadCode = titleMatch ? titleMatch[1].toUpperCase()
      : trainMatch ? trainMatch[1].toUpperCase()
      : (result.train || train).trim();
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
      this.hideNotification();
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
      if (msg.type === 'driver') {
        return `<div class="chat-message chat-driver">
          <div class="chat-message-caller">${this.escapeHtml(msg.caller)}</div>
          <div class="chat-message-text">${this.escapeHtml(msg.text)}</div>
          <div class="chat-message-time">${this.escapeHtml(msg.time)}</div>
        </div>`;
      }
      if (msg.type === 'reply-options') {
        const optionsHtml = (msg.replies || []).map((r) => {
          // Replace "at stop" with "at danger" for display
          const display = r.replace(/\bat stop\b/gi, 'at danger');
          return `<li>${this.escapeHtml(display)}</li>`;
        }).join('');
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
