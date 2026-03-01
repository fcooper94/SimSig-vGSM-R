const { execFile } = require('child_process');
const path = require('path');

const SCRIPT_PATH = path.join(__dirname, 'read-phone-calls.ps1');
const OPEN_TELEPHONE_SCRIPT = path.join(__dirname, 'open-telephone-window.ps1');

class PhoneReader {
  constructor(onChange, onSimName, onSimSigClosed, onPauseChange, onAnswerDialogClosed) {
    this.onChange = onChange;
    this.onSimName = onSimName;
    this.onSimSigClosed = onSimSigClosed;
    this.onPauseChange = onPauseChange;
    this.onAnswerDialogClosed = onAnswerDialogClosed;
    this.intervalId = null;
    this.lastJson = '[]';
    this.lastSimName = '';
    this.lastPaused = null;
    this.lastAnswerDialogOpen = false;
    this.simsigWasFound = false;
    this.polling = false;
    this.telephoneOpened = false;
  }

  startPolling(interval = 2000) {
    if (this.intervalId) return;
    console.log('[PhoneReader] Starting poll every', interval, 'ms');
    this._ensureTelephoneWindow();
    this.poll(); // immediate first poll
    this.intervalId = setInterval(() => this.poll(), interval);
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
    this.lastJson = '[]';
  }

  poll() {
    if (this.polling) return; // skip if previous poll still running
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
