const AlertsFeed = {
  feedEl: null,
  _activeRedSignals: null, // Map: headcode → { signal, waited }
  _activeFailures: [], // [{ status }]
  _failureSeen: null, // Set for failure deduplication
  _waitedPairs: null, // Set of 'HC|SIG' pairs already auto-waited (for second-call detection)

  init() {
    this.feedEl = document.getElementById('alerts-feed');
    this._activeRedSignals = new Map();
    this._failureSeen = new Set();
    this._waitedPairs = new Set();
    // Pre-load msg.wav for alerts
    this._msgAudio = new Audio('../../sounds/msg.wav');
    this._msgAudio.volume = 0.5;

    // Event delegation for Wait buttons
    this.feedEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.alert-wait-btn');
      if (!btn || btn.disabled) return;
      const hc = btn.dataset.headcode;
      const sig = btn.dataset.signal;
      if (hc && sig) this._handleWait(hc, sig, btn);
    });
  },

  // Process raw lines read from SimSig's message log
  addMessageLogLines(lines) {
    let changed = false;

    for (const raw of lines) {
      const trimmed = raw.trim();
      if (!trimmed) continue;

      // Strip timestamp prefix: "HH:MM:SS rest" or "HH:MM rest"
      const tsMatch = trimmed.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s+(.+)$/);
      const text = tsMatch ? tsMatch[2] : trimmed;
      const lower = text.toLowerCase();

      // Parse "1K35 waiting at red signal T33"
      const redMatch = text.match(/^(\w+)\s+waiting at red signal\s+(\S+)/i);
      if (redMatch) {
        const hc = redMatch[1];
        const sig = redMatch[2];
        const key = hc + '|' + sig;
        // If already waited for this exact pair, skip — let the phone ring through
        if (this._waitedPairs.has(key)) continue;
        const existing = this._activeRedSignals.get(hc);
        if (!existing || existing.signal !== sig) {
          this._activeRedSignals.set(hc, { signal: sig, waited: false });
          changed = true;
        }
        continue;
      }

      // Parse failures
      if (lower.includes('failure') || lower.includes('track circuit') ||
          lower.includes('track section') || lower.includes('points fail') ||
          lower.includes('signal fail') || lower.includes('lamp fail')) {
        if (!this._failureSeen.has(text)) {
          this._failureSeen.add(text);
          this._activeFailures.push({ status: text });
          changed = true;
        }
        continue;
      }

      // Any other message starting with a headcode — train moved on, remove from active
      const hcMatch = text.match(/^([0-9][A-Za-z]\d{2})\s/);
      if (hcMatch) {
        const hc = hcMatch[1].toUpperCase();
        if (this._activeRedSignals.has(hc)) {
          this._activeRedSignals.delete(hc);
          changed = true;
        }
      }
    }

    if (changed) {
      this._playMsgSound();
      this.render();
    }
  },

  // Called from app.js when failure dialogs are dismissed
  addFailure(texts) {
    let added = false;
    for (const raw of texts) {
      const text = raw.replace(/^(Message|Warning|Info|Error)\s*\|\s*/i, '').trim();
      if (!text) continue;
      const lower = text.toLowerCase();
      if (!lower.includes('failure') && !lower.includes('track circuit') &&
          !lower.includes('track section') && !lower.includes('points fail') &&
          !lower.includes('signal fail') && !lower.includes('lamp fail')) continue;
      if (this._failureSeen.has(text)) continue;
      this._failureSeen.add(text);
      this._activeFailures.push({ status: text });
      added = true;
    }
    if (added) {
      this._playMsgSound();
      this.render();
    }
  },

  // Queue auto-wait in the main process — it will intercept the driver's call
  // when it arrives in the phone poll and silently answer+reply "Wait 2 minutes"
  _handleWait(headcode, signal, btn) {
    const key = headcode + '|' + signal;
    if (this._waitedPairs.has(key)) return;
    this._waitedPairs.add(key);

    // Mark as waited in active state
    const entry = this._activeRedSignals.get(headcode);
    if (entry) entry.waited = true;

    // Disable button immediately
    btn.textContent = 'Waited';
    btn.disabled = true;

    // Tell main process to intercept this headcode when the driver calls
    window.simsigAPI.phone.autoWait(headcode);
    console.log(`[AlertsFeed] Queued auto-wait for ${headcode} at ${signal}`);

    // If the call already arrived, suppress it from PhoneCallsUI immediately
    if (typeof PhoneCallsUI !== 'undefined') {
      const hadCall = PhoneCallsUI.calls.some((c) => c.train === headcode);
      if (hadCall) {
        PhoneCallsUI.calls = PhoneCallsUI.calls.filter((c) => c.train !== headcode);
        PhoneCallsUI.renderCalls();
        if (PhoneCallsUI.calls.length === 0 && PhoneCallsUI.wasRinging) {
          PhoneCallsUI.stopRinging();
        }
      }
    }
  },

  render() {
    if (!this.feedEl) return;

    const hasRedSignals = this._activeRedSignals && this._activeRedSignals.size > 0;
    const hasFailures = this._activeFailures.length > 0;

    if (!hasRedSignals && !hasFailures) {
      this.feedEl.innerHTML = '';
      return;
    }

    let html = '<table id="alerts-table"><thead><tr>'
      + '<th class="col-train">Train</th>'
      + '<th class="col-signal">Signal</th>'
      + '<th class="col-action">Action</th>'
      + '</tr></thead><tbody>';

    // Red signals — most recently added first
    const redEntries = [...this._activeRedSignals.entries()].reverse();
    for (const [hc, data] of redEntries) {
      html += `<tr><td>${this._esc(hc)}</td>`
        + `<td>${this._esc(data.signal)}</td>`
        + `<td class="col-action"><button class="alert-wait-btn" `
        + `data-headcode="${this._esc(hc)}" data-signal="${this._esc(data.signal)}" `
        + `${data.waited ? 'disabled' : ''}>${data.waited ? 'Waited' : 'Wait'}</button></td></tr>`;
    }

    // Failures — most recently added first
    for (let i = this._activeFailures.length - 1; i >= 0; i--) {
      html += `<tr class="alert-failure-row"><td colspan="3">${this._esc(this._activeFailures[i].status)}</td></tr>`;
    }

    html += '</tbody></table>';
    this.feedEl.innerHTML = html;
  },

  clear() {
    this._activeRedSignals = new Map();
    this._activeFailures = [];
    this._failureSeen = new Set();
    this._waitedPairs = new Set();
    if (this.feedEl) this.feedEl.innerHTML = '';
  },

  _playMsgSound() {
    if (this._msgAudio) {
      this._msgAudio.currentTime = 0;
      this._msgAudio.play().catch(() => {});
    }
  },

  // Test simulator for alerts (Ctrl+Shift+T dialog)
  simulateAlert(type) {
    const sigId = 'T' + (200 + Math.floor(Math.random() * 100));
    const headcodes = ['1A42', '2B57', '3C19', '5R72', '9F08', '6Y31'];
    const hc = headcodes[Math.floor(Math.random() * headcodes.length)];
    switch (type) {
      case 'red_signal':
        this.addMessageLogLines([`12:00:00 ${hc} waiting at red signal ${sigId}`]);
        break;
      case 'tcf':
        this.addFailure([`Track circuit failure detected in the ${sigId} area`]);
        break;
      case 'points':
        this.addFailure([`Points failure detected in the Interlocking area at ${sigId}`]);
        break;
      case 'signal_lamp':
        this.addFailure([`Signal lamp failure at signal ${sigId}`]);
        break;
    }
  },

  _esc(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  },
};
