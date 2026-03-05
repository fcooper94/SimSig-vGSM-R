const AlertsFeed = {
  feedEl: null,
  _activeRedSignals: null, // Map: headcode → { signal, waited, addedAt, waitedAt }
  _activeFailures: [], // [{ status, reported }]
  _failureSeen: null, // Set for failure deduplication
  _reportedFailures: null, // Set of failure texts already reported to Route Control
  _waitedPairs: null, // Set of 'HC|SIG' pairs already auto-waited (for second-call detection)
  _onRenderCallback: null, // Called after render to update external UI (e.g. Route Control button)

  init() {
    this.feedEl = document.getElementById('alerts-feed');
    this._activeRedSignals = new Map();
    this._failureSeen = new Set();
    this._reportedFailures = new Set();
    this._waitedPairs = new Set();
    // Pre-load msg.wav for alerts
    this._msgAudio = new Audio('../../sounds/msg.wav');
    this._msgAudio.volume = 0.5;

    // Event delegation for Wait and Clear buttons
    this.feedEl.addEventListener('click', (e) => {
      const waitBtn = e.target.closest('.alert-wait-btn');
      if (waitBtn && !waitBtn.disabled) {
        const hc = waitBtn.dataset.headcode;
        const sig = waitBtn.dataset.signal;
        if (hc && sig) this._handleWait(hc, sig, waitBtn);
        return;
      }
      const clearBtn = e.target.closest('.alert-clear-btn');
      if (clearBtn) {
        const idx = parseInt(clearBtn.dataset.index, 10);
        if (!isNaN(idx)) this._clearFailure(idx);
      }
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
          this._activeRedSignals.set(hc, { signal: sig, waited: false, addedAt: Date.now(), waitedAt: 0 });
          changed = true;
        }
        continue;
      }

      // Detect failure fixes — "fixed", "restored", "repaired", "cleared"
      if (lower.includes('fixed') || lower.includes('restored') ||
          lower.includes('repaired') || lower.includes('cleared')) {
        const removed = this._removeMatchingFailure(text);
        if (removed) changed = true;
        continue;
      }

      // Parse failures
      if (lower.includes('failure') || lower.includes('track circuit') ||
          lower.includes('track section') || lower.includes('points fail') ||
          lower.includes('signal fail') || lower.includes('lamp fail')) {
        if (!this._failureSeen.has(text)) {
          this._failureSeen.add(text);
          this._activeFailures.push({ status: text, reported: false });
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
      this._activeFailures.push({ status: text, reported: false });
      added = true;
    }
    if (added) {
      this._playMsgSound();
      this.render();
    }
  },

  // Called on each phone calls update — prune trains that are no longer at red
  pruneFromCalls(calls) {
    if (!this._activeRedSignals || this._activeRedSignals.size === 0) return;

    const now = Date.now();
    const callingTrains = new Set(calls.map((c) => {
      const m = (c.train || '').match(/([0-9][A-Za-z]\d{2})/);
      return m ? m[1].toUpperCase() : (c.train || '').trim();
    }));

    let changed = false;
    for (const [hc, data] of this._activeRedSignals) {
      // Grace period: don't prune entries added less than 30s ago (driver hasn't called yet)
      if (now - data.addedAt < 30000) continue;

      if (data.waited) {
        // Waited entries: remove 3 minutes after wait was sent (driver would call back by then)
        if (data.waitedAt && now - data.waitedAt > 180000) {
          this._activeRedSignals.delete(hc);
          changed = true;
        }
      } else {
        // Non-waited entries: remove if the driver is no longer calling
        if (!callingTrains.has(hc)) {
          this._activeRedSignals.delete(hc);
          changed = true;
        }
      }
    }

    if (changed) this.render();
  },

  // Queue auto-wait in the main process — it will intercept the driver's call
  // when it arrives in the phone poll and silently answer+reply "Wait 2 minutes"
  _handleWait(headcode, signal, btn) {
    const key = headcode + '|' + signal;
    if (this._waitedPairs.has(key)) return;
    this._waitedPairs.add(key);

    // Mark as waited in active state
    const entry = this._activeRedSignals.get(headcode);
    if (entry) {
      entry.waited = true;
      entry.waitedAt = Date.now();
    }

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
      if (this._onRenderCallback) this._onRenderCallback();
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
      html += `<tr class="alert-failure-row"><td colspan="2">${this._esc(this._activeFailures[i].status)}</td>`
        + `<td class="col-action"><button class="alert-clear-btn" data-index="${i}">&times;</button></td></tr>`;
    }

    html += '</tbody></table>';
    this.feedEl.innerHTML = html;
    if (this._onRenderCallback) this._onRenderCallback();
  },

  clear() {
    this._activeRedSignals = new Map();
    this._activeFailures = [];
    this._failureSeen = new Set();
    this._reportedFailures = new Set();
    this._waitedPairs = new Set();
    if (this.feedEl) this.feedEl.innerHTML = '';
  },

  // Returns list of active failures for Route Control call
  getActiveFailures() {
    return this._activeFailures.map((f) => f.status);
  },

  // Returns list of unreported failures (not yet told to Route Control)
  getUnreportedFailures() {
    return this._activeFailures.filter((f) => !f.reported).map((f) => f.status);
  },

  // Returns list of already-reported failures
  getReportedFailures() {
    return this._activeFailures.filter((f) => f.reported).map((f) => f.status);
  },

  // Mark all current failures as reported to Route Control
  markFailuresReported() {
    for (const f of this._activeFailures) {
      f.reported = true;
      this._reportedFailures.add(f.status);
    }
  },

  // Try to remove a failure that matches a "fixed" message
  // e.g. "Track circuit failure fixed in the T104 area" matches "Track circuit failure detected in the T104 area"
  _removeMatchingFailure(fixText) {
    const fixLower = fixText.toLowerCase();
    // Extract location identifiers (e.g. "T104", "WK203", area names)
    const locMatch = fixText.match(/\b([A-Z]{1,3}\d{2,4})\b/i);
    const loc = locMatch ? locMatch[1].toUpperCase() : '';

    for (let i = this._activeFailures.length - 1; i >= 0; i--) {
      const failLower = this._activeFailures[i].status.toLowerCase();
      // Match if same location identifier appears in both
      if (loc) {
        const failLocMatch = this._activeFailures[i].status.match(/\b([A-Z]{1,3}\d{2,4})\b/i);
        if (failLocMatch && failLocMatch[1].toUpperCase() === loc) {
          // Same location and both about the same type of failure
          const sameType = (fixLower.includes('track') && failLower.includes('track')) ||
            (fixLower.includes('point') && failLower.includes('point')) ||
            (fixLower.includes('signal') && failLower.includes('signal')) ||
            (fixLower.includes('lamp') && failLower.includes('lamp'));
          if (sameType) {
            const removed = this._activeFailures.splice(i, 1)[0];
            this._failureSeen.delete(removed.status);
            this._reportedFailures.delete(removed.status);
            return true;
          }
        }
      }
      // Fallback: check if fix message contains same area text
      // e.g. "in the T104 area" appears in both
      const areaMatch = fixText.match(/in the (.+?) area/i);
      if (areaMatch) {
        const area = areaMatch[1].toLowerCase();
        if (failLower.includes(area)) {
          const removed = this._activeFailures.splice(i, 1)[0];
          this._failureSeen.delete(removed.status);
          this._reportedFailures.delete(removed.status);
          return true;
        }
      }
    }
    return false;
  },

  _clearFailure(index) {
    if (index >= 0 && index < this._activeFailures.length) {
      const removed = this._activeFailures.splice(index, 1)[0];
      if (removed) this._failureSeen.delete(removed.status);
      this.render();
    }
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
