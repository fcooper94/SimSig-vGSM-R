const { execFile } = require('child_process');
const path = require('path');

const SCRIPTS_DIR = __dirname.replace('app.asar', 'app.asar.unpacked');
const SCRIPT_PATH = path.join(SCRIPTS_DIR, 'read-phone-calls.ps1');
const OPEN_TELEPHONE_SCRIPT = path.join(SCRIPTS_DIR, 'open-telephone-window.ps1');
const SUPPRESS_DIALOGS_SCRIPT = path.join(SCRIPTS_DIR, 'suppress-failure-dialogs.ps1');
const READ_MESSAGE_LOG_SCRIPT = path.join(SCRIPTS_DIR, 'read-message-log.ps1');

class PhoneReader {
  constructor(onChange, onSimName, onSimSigClosed, onPauseChange, onAnswerDialogClosed, onFailureDismissed, onMessageLogLines) {
    this.onChange = onChange;
    this.onSimName = onSimName;
    this.onSimSigClosed = onSimSigClosed;
    this.onPauseChange = onPauseChange;
    this.onAnswerDialogClosed = onAnswerDialogClosed;
    this.onFailureDismissed = onFailureDismissed;
    this.onMessageLogLines = onMessageLogLines;
    this._lastLineCount = 0;
    this.intervalId = null;
    this.lastJson = '[]';
    this.lastSimName = '';
    this.lastPaused = null;
    this.lastAnswerDialogOpen = false;
    this.simsigWasFound = false;
    this.polling = false;
    this.telephoneOpened = false;
    this._locked = false; // when true, all polling/scripts are paused (used by auto-wait)
  }

  startPolling(interval = 2000) {
    if (this.intervalId) return;
    console.log('[PhoneReader] Starting poll every', interval, 'ms');
    this._ensureTelephoneWindow();
    this.poll(); // immediate first poll
    this.intervalId = setInterval(() => this.poll(), interval);
    // Run dialog suppression on a separate timer (doesn't block phone polling)
    this._suppressId = setInterval(() => this._suppressDialogs(), interval);
    // Read SimSig message log on a separate timer
    this._msgLogId = setInterval(() => this._readMessageLog(), interval);
  }

  // Open the telephone window via a separate script, retrying until SimSig is found
  _ensureTelephoneWindow() {
    if (this.telephoneOpened) return;
    if (this._telephoneOpening) return; // prevent concurrent attempts
    this._telephoneOpening = true;
    execFile('powershell', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', OPEN_TELEPHONE_SCRIPT,
    ], { timeout: 5000 }, (err, stdout) => {
      this._telephoneOpening = false;
      const output = (stdout || '').trim();
      console.log('[PhoneReader] Telephone window:', output);
      if (err) {
        console.warn('[PhoneReader] Failed to open telephone window:', err.message);
        return; // will retry on next poll cycle
      }
      try {
        const result = JSON.parse(output);
        if (result.status === 'simsig_not_found') {
          return; // will retry on next poll cycle
        }
      } catch (e) { /* ignore parse errors */ }
      // Mark as opened so we stop retrying
      this.telephoneOpened = true;
    });
  }

  stopPolling() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[PhoneReader] Stopped polling');
    }
    if (this._suppressId) {
      clearInterval(this._suppressId);
      this._suppressId = null;
    }
    if (this._msgLogId) {
      clearInterval(this._msgLogId);
      this._msgLogId = null;
    }
    this._lastLineCount = 0;
    this.lastJson = '[]';
  }

  _suppressDialogs() {
    if (this._suppressing || this._locked) return;
    this._suppressing = true;
    execFile('powershell', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', SUPPRESS_DIALOGS_SCRIPT,
    ], { timeout: 5000 }, (err, stdout) => {
      this._suppressing = false;
      if (err) return;
      try {
        const data = JSON.parse((stdout || '').trim());
        if (data.dismissed && data.dismissed.length > 0 && this.onFailureDismissed) {
          this.onFailureDismissed(data.dismissed);
        }
      } catch { /* ignore parse errors */ }
    });
  }

  _readMessageLog() {
    if (this._readingLog || this._locked) return;
    this._readingLog = true;
    execFile('powershell', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', READ_MESSAGE_LOG_SCRIPT,
    ], { timeout: 5000 }, (err, stdout, stderr) => {
      this._readingLog = false;
      if (err) {
        console.warn('[PhoneReader] Message log error:', err.message);
        if (stderr) console.warn('[PhoneReader] Message log stderr:', stderr.trim().substring(0, 200));
        return;
      }
      try {
        const data = JSON.parse((stdout || '').trim());
        const lines = data.lines || [];
        const count = lines.length;
        if (!this._msgLogLogged) {
          console.log('[PhoneReader] Message log poll: count=' + count, 'lastCount=' + this._lastLineCount);
          this._msgLogLogged = true;
        }
        if (count > this._lastLineCount && this.onMessageLogLines) {
          let newLines = lines.slice(this._lastLineCount);
          // On first load, filter to only last 30 minutes of game time
          if (this._lastLineCount === 0 && newLines.length > 0) {
            newLines = this._filterRecent(newLines, 30);
            console.log('[PhoneReader] Initial load: filtered to', newLines.length, 'recent lines from', count);
          } else {
            console.log('[PhoneReader] Sending', newLines.length, 'new message log lines');
          }
          this._lastLineCount = count;
          if (newLines.length > 0) this.onMessageLogLines(newLines);
        } else if (count < this._lastLineCount) {
          // Log was cleared/reset (new sim loaded)
          this._lastLineCount = count;
          if (count > 0 && this.onMessageLogLines) {
            const filtered = this._filterRecent(lines, 30);
            if (filtered.length > 0) this.onMessageLogLines(filtered);
          }
        }
      } catch (e) {
        console.warn('[PhoneReader] Message log parse error:', e.message);
      }
    });
  }

  // Filter lines to only those within `mins` minutes of the latest timestamp
  _filterRecent(lines, mins) {
    // Parse "HH:MM:SS text" timestamp from the last line to get current game time
    const lastLine = lines[lines.length - 1] || '';
    const tsMatch = lastLine.match(/^(\d{1,2}):(\d{2}):(\d{2})\s/);
    if (!tsMatch) return lines; // can't parse, send all
    const nowMins = parseInt(tsMatch[1]) * 60 + parseInt(tsMatch[2]);
    const cutoff = nowMins - mins;

    const result = [];
    for (const line of lines) {
      const m = line.match(/^(\d{1,2}):(\d{2}):(\d{2})\s/);
      if (!m) { result.push(line); continue; }
      const lineMins = parseInt(m[1]) * 60 + parseInt(m[2]);
      if (lineMins >= cutoff) result.push(line);
    }
    return result;
  }

  poll() {
    if (this.polling || this._locked) return; // skip if previous poll still running or locked
    this.polling = true;

    execFile('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT_PATH,
    ], { timeout: 5000 }, (err, stdout, stderr) => {
      this.polling = false;

      if (err) {
        console.warn('[PhoneReader] Poll error:', err.message);
        if (stderr) console.warn('[PhoneReader] stderr:', stderr.trim().substring(0, 200));
        return;
      }

      const output = (stdout || '').trim();
      if (!output) return;

      try {
        const data = JSON.parse(output);
        if (data.clockColor && !this._colorLogged) {
          console.log('[PhoneReader] Raw poll data - clockColor:', data.clockColor, 'paused:', data.paused);
          this._colorLogged = true;
        }
        const calls = data.calls || [];
        const callsJson = JSON.stringify(calls);

        // Only notify renderer when calls actually change
        if (callsJson !== this.lastJson) {
          this.lastJson = callsJson;
          this.onChange(calls);
        }

        // Send sim name whenever it changes
        if (data.simName && data.simName !== this.lastSimName && this.onSimName) {
          this.lastSimName = data.simName;
          this.onSimName(data.simName);
        }

        // Detect SimSig closing
        if (data.simsigFound) {
          this.simsigWasFound = true;
        } else if (this.simsigWasFound && !data.simsigFound) {
          console.log('[PhoneReader] SimSig closed, triggering app quit');
          this.stopPolling();
          if (this.onSimSigClosed) this.onSimSigClosed();
        }

        // Detect answer dialog closing (driver hung up)
        const dialogOpen = !!data.answerDialogOpen;
        if (this.lastAnswerDialogOpen && !dialogOpen) {
          console.log('[PhoneReader] Answer dialog closed — driver hung up');
          if (this.onAnswerDialogClosed) this.onAnswerDialogClosed();
        }
        this.lastAnswerDialogOpen = dialogOpen;

        // Detect pause state from clock background color
        if (data.paused !== undefined && data.paused !== this.lastPaused) {
          this.lastPaused = data.paused;
          if (data.clockColor) console.log('[PhoneReader] Clock color:', data.clockColor, 'paused:', data.paused);
          if (this.onPauseChange) this.onPauseChange(data.paused);
        }
      } catch (parseErr) {
        console.warn('[PhoneReader] Failed to parse JSON:', parseErr.message);
      }
    });
  }
}

module.exports = PhoneReader;
