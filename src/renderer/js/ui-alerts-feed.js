const AlertsFeed = {
  feedEl: null,
  waitedFeedEl: null, // Right panel — waited trains
  detailEl: null, // Detail panel in right panel
  detailTextEl: null,
  detailWaitBtn: null,
  indicatorEl: null, // Yellow notification icon in toolbar
  _activeRedSignals: null, // Map: headcode → { signal, waited, addedAt, waitedAt }
  _activeFailures: [], // [{ status, reported }]
  _failureSeen: null, // Set for failure deduplication
  _reportedFailures: null, // Set of failure texts already reported to Route Control
  _waitedPairs: null, // Set of 'HC|SIG' pairs already auto-waited
  _onRenderCallback: null, // Called after render to update external UI (e.g. Route Control button)
  _selectedHc: null, // Currently selected headcode (for detail panel)
  _stateRestored: false, // Prevents duplicate restoreState calls
  _clockValidated: false, // Whether clock-based timetable check has run
  _lastClockSeconds: 0, // Last known game clock seconds
  _initialLogProcessed: false, // True after first log batch received

  init() {
    this.feedEl = document.getElementById('alerts-feed');
    this.waitedFeedEl = document.getElementById('waited-feed');
    this.detailEl = document.getElementById('alert-detail');
    this.detailTextEl = document.getElementById('alert-detail-text');
    this.detailWaitBtn = document.getElementById('alert-detail-wait');
    this.indicatorEl = document.getElementById('alert-indicator');
    this._activeRedSignals = new Map();
    this._failureSeen = new Set();
    this._reportedFailures = new Set();
    this._waitedPairs = new Set();
    this._msgAudio = new Audio('../../sounds/msg.wav');
    this._msgAudio.volume = 0.5;

    // Left panel: clicking a train moves it to the right panel (selects it)
    this.feedEl.addEventListener('click', (e) => {
      const clearBtn = e.target.closest('.alert-clear-btn');
      if (clearBtn) {
        const idx = parseInt(clearBtn.dataset.index, 10);
        if (!isNaN(idx)) this._clearFailure(idx);
        return;
      }
      const row = e.target.closest('tr[data-hc]');
      if (row) {
        this._selectedHc = row.dataset.hc;
      } else if (this._selectedHc) {
        this._selectedHc = null;
      } else {
        return;
      }
      this.render();
      this.renderWaited();
    });

    // Right panel: clicking a train toggles selection; clicking empty space deselects
    this.waitedFeedEl.addEventListener('click', (e) => {
      const row = e.target.closest('tr[data-hc]');
      if (row) {
        this._selectTrain(row.dataset.hc);
      } else if (this._selectedHc) {
        this._selectedHc = null;
        this.render();
        this.renderWaited();
      }
    });

    // Detail panel buttons
    this.detailWaitBtn.addEventListener('click', () => {
      if (this._selectedHc) {
        const entry = this._activeRedSignals.get(this._selectedHc);
        if (entry && !entry.waited) this._handleWait(this._selectedHc, entry.signal);
      }
    });
    document.getElementById('alert-detail-remove').addEventListener('click', () => {
      if (this._selectedHc) this._removeTrain(this._selectedHc);
    });

    // Yellow indicator click — select first un-waited train
    if (this.indicatorEl) {
      this.indicatorEl.addEventListener('click', () => {
        for (const [hc, data] of this._activeRedSignals) {
          if (!data.waited && hc !== this._selectedHc) {
            this._selectedHc = hc;
            this.render();
            this.renderWaited();
            return;
          }
        }
      });
    }
  },

  _selectTrain(hc) {
    // Toggle: click same train again deselects
    if (this._selectedHc === hc) {
      this._selectedHc = null;
    } else {
      this._selectedHc = hc;
    }
    this.render();
    this.renderWaited();
  },

  // Pre-scan a batch to find trains with movement appearing after their last "waiting at red" line.
  // Used on initial load so we don't show trains that already moved within the same log batch.
  _findMovedAfterRed(lines) {
    const lastRedIdx = new Map(); // hc → line index of last "waiting at red"
    const movers = new Set();
    lines.forEach((raw, idx) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      const tsMatch = trimmed.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s+(.+)$/);
      const text = tsMatch ? tsMatch[2] : trimmed;
      const redMatch = text.match(/^(\w+)\s+waiting at red signal\s+(\S+)/i);
      if (redMatch) { lastRedIdx.set(redMatch[1].toUpperCase(), idx); return; }
      const moveHc = this._extractMovementHeadcode(text);
      if (moveHc && lastRedIdx.has(moveHc) && idx > lastRedIdx.get(moveHc)) movers.add(moveHc);
    });
    return movers;
  },

  addMessageLogLines(lines) {
    let changed = false;

    // On the first batch, pre-scan to find trains that have moved — skip adding them
    const isInitialLoad = !this._initialLogProcessed;
    this._initialLogProcessed = true;
    const skipReds = isInitialLoad ? this._findMovedAfterRed(lines) : null;

    for (const raw of lines) {
      const trimmed = raw.trim();
      if (!trimmed) continue;

      const tsMatch = trimmed.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s+(.+)$/);
      const text = tsMatch ? tsMatch[2] : trimmed;
      const lower = text.toLowerCase();

      const redMatch = text.match(/^(\w+)\s+waiting at red signal\s+(\S+)/i);
      if (redMatch) {
        const hc = redMatch[1].toUpperCase();
        if (skipReds?.has(hc)) continue; // movement found later in this batch — skip
        const sig = redMatch[2];
        const existing = this._activeRedSignals.get(hc);
        if (!existing || existing.signal !== sig) {
          if (existing && existing.waited && existing.signal !== sig) {
            window.simsigAPI.phone.clearAutoWait(hc);
            this._waitedPairs.delete(hc + '|' + existing.signal);
          }
          if (this._selectedHc === hc) this._selectedHc = null;
          this._activeRedSignals.set(hc, { signal: sig, waited: false, addedAt: Date.now(), waitedAt: 0 });
          changed = true;
        }
        continue;
      }

      if (lower.includes('fixed') || lower.includes('restored') ||
          lower.includes('repaired') || lower.includes('cleared')) {
        const removed = this._removeMatchingFailure(text);
        if (removed) changed = true;
        continue;
      }

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

      // Detect movement: headcode at start of line, or in a STEP/LOCATION entry
      const moveHc = this._extractMovementHeadcode(text);
      if (moveHc) {
        const entry = this._activeRedSignals.get(moveHc);
        if (entry) {
          if (entry.waited) {
            // Clean up the auto-wait that was queued for this train
            window.simsigAPI.phone.clearAutoWait(moveHc);
            this._waitedPairs.delete(moveHc + '|' + entry.signal);
          }
          if (this._selectedHc === moveHc) this._selectedHc = null;
          this._activeRedSignals.delete(moveHc);
          changed = true;
        }
      }
    }

    if (changed) {
      this._playMsgSound();
      this.render();
      this.renderWaited();
      this._saveState();
    }
  },

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
      this._saveState();
    }
  },

  pruneFromCalls(calls) {
    if (!this._activeRedSignals || this._activeRedSignals.size === 0) return;

    const now = Date.now();
    const callingTrains = new Set(calls.map((c) => {
      const m = (c.train || '').match(/([0-9][A-Za-z]\d{2})/);
      return m ? m[1].toUpperCase() : (c.train || '').trim();
    }));

    let changed = false;
    for (const [hc, data] of this._activeRedSignals) {
      if (now - data.addedAt < 30000) continue;
      if (data.waited) {
        // Keep waited entries until train moves
      } else {
        if (!callingTrains.has(hc)) {
          if (this._selectedHc === hc) this._selectedHc = null;
          this._activeRedSignals.delete(hc);
          changed = true;
        }
      }
    }

    if (changed) {
      this.render();
      this.renderWaited();
      this._saveState();
    }
  },

  async _handleWait(headcode, signal) {
    // Cross-check the message log: warn if the train has moved since the alert was raised
    const entry = this._activeRedSignals.get(headcode);
    if (entry && window.simsigAPI && window.simsigAPI.phone.getRecentLog) {
      try {
        const result = await window.simsigAPI.phone.getRecentLog(headcode, entry.addedAt);
        const movementLines = (result.lines || []).filter((line) => {
          const tsMatch = line.match(/^\d{1,2}:\d{2}(?::\d{2})?\s+(.+)$/);
          const body = tsMatch ? tsMatch[1] : line;
          if (/waiting at red signal/i.test(body)) return false;
          return this._extractMovementHeadcode(body) === headcode;
        });
        if (movementLines.length > 0) {
          const preview = movementLines[movementLines.length - 1];
          // eslint-disable-next-line no-alert
          const proceed = confirm(`${headcode} may have already moved:\n"${preview}"\n\nStill send WAIT?`);
          if (!proceed) return;
        }
      } catch (e) {
        console.warn('[AlertsFeed] getRecentLog failed:', e);
      }
    }

    const key = headcode + '|' + signal;
    const alreadySent = this._waitedPairs.has(key);
    this._waitedPairs.add(key);

    if (entry) {
      entry.waited = true;
      entry.waitedAt = Date.now();
    }

    // Only send auto-wait if we haven't already for this headcode+signal
    if (!alreadySent) window.simsigAPI.phone.autoWait(headcode, signal);
    console.log(`[AlertsFeed] Queued auto-wait for ${headcode} at ${signal}`);

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

    // Keep selected so detail updates with disabled Wait button
    this.render();
    this.renderWaited();
    this._saveState();
  },

  _removeTrain(hc) {
    if (this._activeRedSignals.has(hc)) {
      if (this._selectedHc === hc) this._selectedHc = null;
      this._activeRedSignals.delete(hc);
      this.render();
      this.renderWaited();
      this._saveState();
    }
  },

  // Left panel: un-waited red signals + failures
  render() {
    if (!this.feedEl) return;

    const leftTrains = [];
    if (this._activeRedSignals) {
      for (const [hc, data] of this._activeRedSignals) {
        // Un-waited and not currently selected (selected trains move to right)
        if (!data.waited && hc !== this._selectedHc) leftTrains.push([hc, data]);
      }
    }
    const hasLeftTrains = leftTrains.length > 0;
    const hasFailures = this._activeFailures.length > 0;

    this._updateIndicator(hasLeftTrains);

    if (!hasLeftTrains && !hasFailures) {
      this.feedEl.innerHTML = '';
      if (this._onRenderCallback) this._onRenderCallback();
      return;
    }

    let html = '<table id="alerts-table"><tbody>';

    const reversed = [...leftTrains].reverse();
    for (const [hc, data] of reversed) {
      const sel = this._selectedHc === hc ? ' class="alert-row-selected"' : '';
      html += `<tr data-hc="${this._esc(hc)}"${sel}>`
        + `<td class="col-alert-train">&#9993; ${this._esc(hc)} (${this._esc(data.signal)})</td>`
        + `<td class="col-alert-status">at sig</td></tr>`;
    }

    for (let i = this._activeFailures.length - 1; i >= 0; i--) {
      html += `<tr class="alert-failure-row"><td>${this._esc(this._activeFailures[i].status)}</td>`
        + `<td class="col-alert-status"><button class="alert-clear-btn" data-index="${i}">&times;</button></td></tr>`;
    }

    html += '</tbody></table>';
    this.feedEl.innerHTML = html;
    if (this._onRenderCallback) this._onRenderCallback();
  },

  // Right panel: waited trains + detail for selected train
  renderWaited() {
    if (!this.waitedFeedEl) return;

    const rightTrains = [];
    if (this._activeRedSignals) {
      for (const [hc, data] of this._activeRedSignals) {
        // Show waited trains + the currently selected train (even if not yet waited)
        if (data.waited || hc === this._selectedHc) rightTrains.push([hc, data]);
      }
    }

    if (rightTrains.length === 0) {
      this.waitedFeedEl.innerHTML = '';
    } else {
      let html = '<table id="waited-table"><tbody>';
      const reversed = [...rightTrains].reverse();
      for (const [hc, data] of reversed) {
        const sel = this._selectedHc === hc ? ' class="alert-row-selected"' : '';
        const label = data.waited
          ? `&#9993; ${this._esc(hc)} [WAIT]`
          : `&#9993; ${this._esc(hc)} (${this._esc(data.signal)})`;
        const status = data.waited ? 'wait' : 'at sig';
        html += `<tr data-hc="${this._esc(hc)}"${sel}>`
          + `<td class="col-waited-train">${label}</td>`
          + `<td class="col-waited-status">${status}</td></tr>`;
      }
      html += '</tbody></table>';
      this.waitedFeedEl.innerHTML = html;
    }

    // Show detail panel for whichever train is selected
    this._renderDetail();
  },

  _renderDetail() {
    if (!this._selectedHc || !this._activeRedSignals.has(this._selectedHc)) {
      this._hideDetail();
      return;
    }
    const data = this._activeRedSignals.get(this._selectedHc);
    this.detailTextEl.textContent = `${this._selectedHc} Standing at Signal ${data.signal}`;
    this.detailEl.classList.remove('hidden');

    // Disable Wait if already waited
    if (data.waited) {
      this.detailWaitBtn.disabled = true;
      this.detailWaitBtn.textContent = 'Waited';
    } else {
      this.detailWaitBtn.disabled = false;
      this.detailWaitBtn.textContent = 'Wait';
    }
  },

  _hideDetail() {
    if (this.detailEl) this.detailEl.classList.add('hidden');
  },

  _updateIndicator(hasLeftTrains) {
    if (!this.indicatorEl) return;
    if (hasLeftTrains) {
      this.indicatorEl.classList.add('active');
      this.indicatorEl.disabled = false;
    } else {
      this.indicatorEl.classList.remove('active');
      this.indicatorEl.disabled = true;
    }
  },

  clear() {
    this._activeRedSignals = new Map();
    this._activeFailures = [];
    this._failureSeen = new Set();
    this._reportedFailures = new Set();
    this._waitedPairs = new Set();
    this._selectedHc = null;
    this._stateRestored = false;
    this._initialLogProcessed = false;
    if (this.feedEl) this.feedEl.innerHTML = '';
    if (this.waitedFeedEl) this.waitedFeedEl.innerHTML = '';
    this._hideDetail();
    if (this.indicatorEl) {
      this.indicatorEl.classList.remove('active');
      this.indicatorEl.disabled = true;
    }
  },

  getActiveFailures() {
    return this._activeFailures.map((f) => f.status);
  },

  getUnreportedFailures() {
    return this._activeFailures.filter((f) => !f.reported).map((f) => f.status);
  },

  getReportedFailures() {
    return this._activeFailures.filter((f) => f.reported).map((f) => f.status);
  },

  markFailuresReported() {
    for (const f of this._activeFailures) {
      f.reported = true;
      this._reportedFailures.add(f.status);
    }
  },

  _removeMatchingFailure(fixText) {
    const fixLower = fixText.toLowerCase();
    const locMatch = fixText.match(/\b([A-Z]{1,3}\d{2,4})\b/i);
    const loc = locMatch ? locMatch[1].toUpperCase() : '';

    for (let i = this._activeFailures.length - 1; i >= 0; i--) {
      const failLower = this._activeFailures[i].status.toLowerCase();
      if (loc) {
        const failLocMatch = this._activeFailures[i].status.match(/\b([A-Z]{1,3}\d{2,4})\b/i);
        if (failLocMatch && failLocMatch[1].toUpperCase() === loc) {
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
      this._saveState();
    }
  },

  _playMsgSound() {
    // Don't play alert sound while phone is ringing — avoids audio interference
    if (typeof PhoneCallsUI !== 'undefined' && PhoneCallsUI.wasRinging) return;
    if (this._msgAudio) {
      this._msgAudio.currentTime = 0;
      this._msgAudio.play().catch(() => {});
    }
  },

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

  _getStorageKey() {
    const panel = (typeof PhoneCallsUI !== 'undefined' && PhoneCallsUI.currentPanelName) || '';
    return panel ? 'alertsFeed_' + panel : '';
  },

  _saveState() {
    const key = this._getStorageKey();
    if (!key) return;
    try {
      const signals = [];
      for (const [hc, data] of this._activeRedSignals) {
        signals.push({ hc, signal: data.signal, waited: data.waited, waitedAt: data.waitedAt, addedAt: data.addedAt });
      }
      const state = {
        signals,
        failures: this._activeFailures,
        failureSeen: [...this._failureSeen],
        reportedFailures: [...this._reportedFailures],
        waitedPairs: [...this._waitedPairs],
        clockSeconds: this._lastClockSeconds,
      };
      localStorage.setItem(key, JSON.stringify(state));
    } catch (e) { /* ignore */ }
  },

  restoreState() {
    if (this._stateRestored) return;
    this._stateRestored = true;
    const key = this._getStorageKey();
    if (!key) return;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const state = JSON.parse(raw);
      if (state.signals && state.signals.length > 0) {
        const now = Date.now();
        const STALE_MS = 45 * 60 * 1000; // 45 minutes — train has almost certainly moved
        for (const s of state.signals) {
          const savedAt = s.addedAt || s.waitedAt || 0;
          if (savedAt && (now - savedAt) > STALE_MS) continue; // skip stale entries
          this._activeRedSignals.set(s.hc, {
            signal: s.signal, waited: s.waited,
            addedAt: s.addedAt || now, waitedAt: s.waitedAt || 0,
          });
          // Re-queue auto-wait in the main process so repeat calls are intercepted
          if (s.waited) {
            window.simsigAPI.phone.autoWait(s.hc, s.signal);
          }
        }
      }
      if (state.failures) this._activeFailures = state.failures;
      if (state.failureSeen) this._failureSeen = new Set(state.failureSeen);
      if (state.reportedFailures) this._reportedFailures = new Set(state.reportedFailures);
      if (state.waitedPairs) this._waitedPairs = new Set(state.waitedPairs);
      this.render();
      this.renderWaited();
    } catch (e) { /* ignore */ }
  },

  onClockUpdate(clockSeconds) {
    this._lastClockSeconds = clockSeconds;
    // On first clock update after restore, check if this is a different timetable
    if (!this._clockValidated && this._stateRestored) {
      this._clockValidated = true;
      const key = this._getStorageKey();
      if (!key) return;
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return;
        const saved = JSON.parse(raw);
        // If saved clock is more than 30 minutes ahead of current, it's a new timetable
        if (saved.clockSeconds && saved.clockSeconds - clockSeconds > 1800) {
          console.log('[AlertsFeed] New timetable detected (saved clock %d > current %d), clearing state', saved.clockSeconds, clockSeconds);
          localStorage.removeItem(key);
          this._activeRedSignals.clear();
          this._activeFailures = [];
          this._failureSeen.clear();
          this._reportedFailures.clear();
          this._waitedPairs.clear();
          this.render();
          this.renderWaited();
        }
      } catch (e) { /* ignore */ }
    }
  },

  // Extract headcode if a log line body represents train movement.
  // Handles: "2C09 something", "STEP 2C09 : 246 -> 250", "LOCATION 2C09 at S246"
  _extractMovementHeadcode(text) {
    const HC = /[0-9][A-Za-z]\d{2}/;
    // Direct: headcode at start of line (e.g. "2C09 arrived at Platform 3")
    let m = text.match(new RegExp(`^(${HC.source})\\s`));
    if (m) return m[1].toUpperCase();
    // STEP or LOCATION prefix (TD berth step messages)
    m = text.match(new RegExp(`^(?:STEP|LOCATION)\\s+(${HC.source})\\b`, 'i'));
    if (m) return m[1].toUpperCase();
    // "Signal X TRIS for HC" / "Signal X cleared for HC" / "...for HC at..."
    // SimSig logs these when a signal clears and a train moves through
    m = text.match(new RegExp(`(?:TRIS|cleared|clears)\\s+(?:for\\s+)?(${HC.source})\\b`, 'i'));
    if (m) return m[1].toUpperCase();
    // "...for HC at ..." generic — catches other SimSig movement notifications
    m = text.match(new RegExp(`\\bfor\\s+(${HC.source})\\s+at\\b`, 'i'));
    if (m) return m[1].toUpperCase();
    return null;
  },

  _esc(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  },
};
