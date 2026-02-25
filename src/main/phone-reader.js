const { execFile } = require('child_process');
const path = require('path');

const SCRIPT_PATH = path.join(__dirname, 'read-phone-calls.ps1');

class PhoneReader {
  constructor(onChange) {
    this.onChange = onChange;
    this.intervalId = null;
    this.lastJson = '[]';
    this.polling = false;
  }

  startPolling(interval = 2000) {
    if (this.intervalId) return;
    console.log('[PhoneReader] Starting poll every', interval, 'ms');
    this.poll(); // immediate first poll
    this.intervalId = setInterval(() => this.poll(), interval);
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
        // Silently ignore errors (PowerShell not found, timeout, etc.)
        return;
      }

      const output = (stdout || '').trim();
      if (!output) return;

      // Only notify renderer when the data actually changes
      if (output !== this.lastJson) {
        this.lastJson = output;
        try {
          const calls = JSON.parse(output);
          this.onChange(calls);
        } catch (parseErr) {
          console.warn('[PhoneReader] Failed to parse JSON:', parseErr.message);
        }
      }
    });
  }
}

module.exports = PhoneReader;
