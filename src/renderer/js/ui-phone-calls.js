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

    this.ringingAudio = new Audio('../../sounds/ringing.wav');
    this.ringingAudio.loop = true;

    // Pre-warm local voices as fallback
    speechSynthesis.getVoices();
    speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();

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
    this.ringingAudio.currentTime = 0;
    this.ringingAudio.play().catch(() => {});
  },

  stopRinging() {
    this.wasRinging = false;
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

  // Speak via ElevenLabs API (main process handles the HTTP call)
  async speakElevenLabs(text, voiceId) {
    const audioData = await window.simsigAPI.tts.speak(text, voiceId);
    if (!audioData) return false;

    return new Promise((resolve) => {
      const blob = new Blob([new Uint8Array(audioData)], { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => {
        URL.revokeObjectURL(url);
        resolve(true);
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(false);
      };
      audio.play().catch(() => resolve(false));
    });
  },

  // Fallback: local browser TTS with varied voice
  speakLocal(text, caller) {
    return new Promise((resolve) => {
      const voices = speechSynthesis.getVoices();
      const gbVoices = voices.filter((v) => v.lang.startsWith('en-GB'));
      const pool = gbVoices.length > 0 ? gbVoices : voices;
      const hash = this.hashString(caller);

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'en-GB';
      utterance.voice = pool[hash % pool.length] || null;
      utterance.pitch = 0.7 + ((hash >> 4) % 100) / 100 * 0.6;
      utterance.rate = 1.6 + ((hash >> 8) % 100) / 100 * 0.3;

      utterance.onend = resolve;
      utterance.onerror = resolve;
      speechSynthesis.speak(utterance);
    });
  },

  // Keyword patterns for matching user speech to SimSig reply options
  // Order matters — more specific patterns first
  REPLY_MATCHERS: [
    { pattern: /pass.*examine|authoris[ez].*pass.*examine|authoris[ez].*examine/, fragment: 'pass signal at stop and examine' },
    { pattern: /(?:15|fifteen|one\s*five)\s*min/, fragment: 'wait 15 minute' },
    { pattern: /(?<!\d)(?:0?2|two)\s*min/, fragment: 'wait 2 minute' },
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

  // Use Windows Speech Recognition with constrained grammar (via PowerShell)
  async recordAndTranscribe() {
    const result = await window.simsigAPI.stt.transcribe();
    console.log('[STT] Result:', result);
    if (result && typeof result === 'object' && result.error) {
      console.error('[STT] Error:', result.error);
      return '';
    }
    return result || '';
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
      this.addMessage({ type: 'greeting', text: 'Speak your reply...' });
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

  // Show a large hang up button at the bottom of the chat
  showHangUpInChat() {
    const btn = document.createElement('button');
    btn.className = 'chat-hang-up-btn';
    btn.textContent = 'Hang Up';
    btn.addEventListener('click', () => {
      btn.remove();
      this.hangUp();
    });
    this.chatEl.appendChild(btn);
    this.chatEl.scrollTop = this.chatEl.scrollHeight;
  },

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
    }
    await this.speakLocal(spoken, caller);
  },

  // Listen on mic, wait for user to speak then go silent
  waitForUserSpeech() {
    return new Promise(async (resolve) => {
      let stream;
      try {
        const settings = await window.simsigAPI.settings.getAll();
        const deviceId = settings.audio?.inputDeviceId;
        const constraints = deviceId && deviceId !== 'default'
          ? { audio: { deviceId: { exact: deviceId } } }
          : { audio: true };
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch {
        setTimeout(resolve, 2000);
        return;
      }

      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);

      const data = new Uint8Array(analyser.frequencyBinCount);
      const SPEECH_THRESHOLD = 30;
      const SILENCE_DURATION = 1200;

      let speaking = false;
      let silenceSince = 0;

      const check = () => {
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = sum / data.length;

        if (avg > SPEECH_THRESHOLD) {
          speaking = true;
          silenceSince = 0;
        } else if (speaking) {
          if (!silenceSince) {
            silenceSince = Date.now();
          } else if (Date.now() - silenceSince > SILENCE_DURATION) {
            stream.getTracks().forEach((t) => t.stop());
            ctx.close();
            resolve();
            return;
          }
        }

        requestAnimationFrame(check);
      };

      check();
    });
  },

  hangUp() {
    this.inCall = false;
    this.messages = [];
    this.renderChat();
    this.renderHangUpButton();
    // If there are waiting calls, start ringing again
    if (this.calls.length > 0) {
      this.startRinging();
    }
  },

  renderHangUpButton() {
    const existing = document.getElementById('hang-up-btn');
    if (existing) existing.remove();

    if (this.inCall) {
      const btn = document.createElement('button');
      btn.id = 'hang-up-btn';
      btn.textContent = 'Hang Up';
      btn.addEventListener('click', () => this.hangUp());
      document.getElementById('chat-header').appendChild(btn);
    }
  },

  async answerCall(index) {
    this.inCall = true;
    this.stopRinging();
    this.renderHangUpButton();

    const call = this.calls[index];
    const train = call ? call.train : '';

    const btn = this.listEl.querySelector(`.call-answer-btn[data-index="${index}"]`);
    if (btn) {
      btn.textContent = '...';
      btn.disabled = true;
    }

    const result = await window.simsigAPI.phone.answerCall(index, train);

    if (result.error) {
      this.addMessage({ type: 'error', text: result.error });
      return;
    }

    // Build greeting
    const settings = await window.simsigAPI.settings.getAll();
    const panelName = settings.signaller?.panelName || 'Panel';
    const position = this.extractPosition(result.title);
    const greeting = `Hello, ${panelName} Signaller${position ? ', ' + position : ''}, Go ahead`;

    // Show the greeting prompt and wait for user to say it
    this.addMessage({ type: 'greeting', text: greeting });
    await this.waitForUserSpeech();

    // After user finishes speaking, show and speak the driver's message
    const caller = (result.title || '').replace(/^Answer call from\s*/i, '') || result.train || '';
    const driverMsg = result.message || '';
    this.addMessage({ type: 'driver', caller, text: driverMsg });

    // Build full radio call for speech: driver addresses signaller then gives message
    const spokenMsg = `Hello, ${panelName} Signaller${position ? ', ' + position : ''}, this is ${driverMsg}`;
    await this.speakAsDriver(spokenMsg, caller);

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
    let html = '';

    if (this.calls.length === 0) {
      html = '<div class="no-calls">No outstanding calls</div>';
      this.countEl.classList.add('hidden');
    } else {
      this.countEl.textContent = this.calls.length;
      this.countEl.classList.remove('hidden');

      html = this.calls.map((call, i) => {
        return `<div class="phone-call-entry unanswered">
          <span class="call-train">${this.escapeHtml(call.train || '')}</span>
          <button class="call-answer-btn" data-index="${i}">Answer</button>
        </div>`;
      }).join('');
    }

    this.listEl.innerHTML = html;

    this.listEl.querySelectorAll('.call-answer-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.target.dataset.index, 10);
        this.answerCall(idx);
      });
    });
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
