const { ipcMain, BrowserWindow } = require('electron');
const channels = require('../shared/ipc-channels');
const settings = require('./settings');
const { updateClock, updateClockTime, getClockState, formatTime } = require('./clock');
const { execFile } = require('child_process');
const https = require('https');
const StompConnectionManager = require('./stomp-client');
const PhoneReader = require('./phone-reader');

const ANSWER_SCRIPT = require('path').join(__dirname, 'answer-phone-call.ps1');
const REPLY_SCRIPT = require('path').join(__dirname, 'reply-phone-call.ps1');
const RECOGNIZE_SCRIPT = require('path').join(__dirname, 'speech-recognize.ps1');

let stompManager = null;
let phoneReader = null;
let ttsVoicesCache = null;

function sendToAllWindows(channel, data) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, data);
  }
}

function sendToMainWindow(channel, data) {
  const wins = BrowserWindow.getAllWindows();
  if (wins.length > 0) {
    wins[0].webContents.send(channel, data);
  }
}

function registerIpcHandlers() {
  // Settings
  ipcMain.handle(channels.SETTINGS_GET, (_event, key) => settings.get(key));
  ipcMain.handle(channels.SETTINGS_SET, (_event, key, value) => {
    settings.set(key, value);
  });
  ipcMain.handle(channels.SETTINGS_GET_ALL, () => settings.getAll());

  // Connection
  ipcMain.handle(channels.CONNECTION_CONNECT, async () => {
    try {
      if (stompManager) {
        await stompManager.disconnect();
      }

      const config = settings.getAll();
      console.log('[Gateway] Connecting to', config.gateway.host + ':' + config.gateway.port);

      stompManager = new StompConnectionManager({
        host: config.gateway.host,
        port: config.gateway.port,
        username: config.credentials.username,
        password: config.credentials.password,
        onMessage: (msg) => {
          const prevClock = getClockState().clockSeconds;

          // Handle clock messages (pause/speed changes)
          if (msg.type === 'clock_msg') {
            updateClock(msg.data);
          }

          // Extract game time from any message that has a time field
          if (msg.data && msg.data.time != null) {
            updateClockTime(msg.data.time);
          }

          // Only push clock update to renderer when the time changes
          const clockState = getClockState();
          if (clockState.clockSeconds > 0 && clockState.clockSeconds !== prevClock) {
            sendToMainWindow(channels.CLOCK_UPDATE, {
              ...clockState,
              formatted: formatTime(clockState.clockSeconds),
            });
          }

          // Send messages to all windows (main + message log)
          sendToAllWindows(channels.MESSAGE_RECEIVED, msg);
        },
        onStatusChange: (status) => {
          sendToMainWindow(channels.CONNECTION_STATUS, status);
        },
        onError: (error) => {
          console.error('[Gateway] Error:', error);
          sendToMainWindow(channels.CONNECTION_STATUS, { status: 'error', error });
        },
      });

      stompManager.connect();

      // Start polling for phone calls from the SimSig window
      if (phoneReader) phoneReader.stopPolling();
      phoneReader = new PhoneReader((calls) => {
        sendToMainWindow(channels.PHONE_CALLS_UPDATE, calls);
      });
      phoneReader.startPolling(2000);
    } catch (err) {
      console.error('[Gateway] Connection failed:', err);
      sendToMainWindow(channels.CONNECTION_STATUS, { status: 'error', error: err.message });
    }
  });

  ipcMain.handle(channels.CONNECTION_DISCONNECT, async () => {
    if (phoneReader) {
      phoneReader.stopPolling();
      phoneReader = null;
    }
    if (stompManager) {
      await stompManager.disconnect();
      stompManager = null;
    }
  });

  // Commands
  ipcMain.handle(channels.CMD_ALL_SIGNALS_DANGER, () => {
    if (stompManager && stompManager.status === 'connected') {
      return stompManager.allSignalsToDanger();
    }
    return 0;
  });

  ipcMain.handle(channels.PHONE_ANSWER_CALL, (_event, index, train) => {
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', ANSWER_SCRIPT, '-Index', String(index || 0),
    ];
    if (train) {
      args.push('-Train', train);
    }
    return new Promise((resolve) => {
      execFile('powershell', args, { timeout: 10000 }, (err, stdout) => {
        // Re-raise our window after PowerShell touched SimSig
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          win.setAlwaysOnTop(true, 'screen-saver');
          win.moveTop();
        }

        if (err) {
          console.error('[PhoneAnswer] Error:', err.message);
          resolve({ error: err.message });
          return;
        }
        try {
          resolve(JSON.parse((stdout || '').trim()));
        } catch (parseErr) {
          resolve({ error: 'Failed to parse response' });
        }
      });
    });
  });

  ipcMain.handle(channels.PHONE_REPLY_CALL, (_event, replyIndex, headCode) => {
    console.log(`[PhoneReply] replyIndex=${replyIndex}, headCode="${headCode || ''}"`);
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', REPLY_SCRIPT, '-ReplyIndex', String(replyIndex || 0),
    ];
    if (headCode) {
      args.push('-HeadCode', headCode);
    }
    return new Promise((resolve) => {
      execFile('powershell', args, { timeout: 30000 }, (err, stdout, stderr) => {
        // Re-raise our window after PowerShell touched SimSig
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          win.setAlwaysOnTop(true, 'screen-saver');
          win.moveTop();
        }

        if (stderr) console.error('[PhoneReply] stderr:', stderr.trim());
        console.log('[PhoneReply] stdout:', (stdout || '').trim());

        if (err) {
          console.error('[PhoneReply] Error:', err.message);
        }
        try {
          // Grab last non-empty line (PowerShell may emit extra output before JSON)
          const lines = (stdout || '').trim().split(/\r?\n/).filter(Boolean);
          const jsonLine = lines[lines.length - 1] || '{}';
          resolve(JSON.parse(jsonLine));
        } catch (parseErr) {
          resolve({ error: 'Failed to parse response' });
        }
      });
    });
  });

  ipcMain.handle(channels.CMD_OPEN_MESSAGE_LOG, () => {
    const { createMessageLogWindow } = require('./main');
    createMessageLogWindow();
  });

  // TTS — ElevenLabs
  ipcMain.handle(channels.TTS_GET_VOICES, () => {
    const apiKey = settings.get('tts.apiKey');
    if (!apiKey) return [];
    if (ttsVoicesCache) return ttsVoicesCache;

    return new Promise((resolve) => {
      const req = https.request('https://api.elevenlabs.io/v1/voices', {
        method: 'GET',
        headers: { 'xi-api-key': apiKey },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            const voices = (data.voices || [])
              .filter((v) => {
                const accent = (v.labels?.accent || '').toLowerCase();
                return accent.includes('british') || accent.includes('english');
              })
              .map((v) => ({
                id: v.voice_id,
                name: v.name,
                accent: v.labels?.accent || '',
                gender: v.labels?.gender || '',
              }));
            ttsVoicesCache = voices;
            console.log(`[TTS] Found ${voices.length} British voices`);
            resolve(voices);
          } catch {
            resolve([]);
          }
        });
      });
      req.on('error', () => resolve([]));
      req.end();
    });
  });

  ipcMain.handle(channels.TTS_SPEAK, (_event, text, voiceId) => {
    const apiKey = settings.get('tts.apiKey');
    if (!apiKey || !voiceId) return null;

    const body = JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.7, similarity_boost: 0.75 },
      speed: 2.2,
    });

    return new Promise((resolve) => {
      const req = https.request(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            console.error(`[TTS] API error ${res.statusCode}`);
            resolve(null);
            return;
          }
          // Return raw buffer as array of bytes for renderer
          resolve(Array.from(Buffer.concat(chunks)));
        });
      });
      req.on('error', (err) => {
        console.error('[TTS] Request error:', err.message);
        resolve(null);
      });
      req.write(body);
      req.end();
    });
  });

  // STT — Windows Speech Recognition (free, no API key needed)
  ipcMain.handle(channels.STT_TRANSCRIBE, () => {
    return new Promise((resolve) => {
      console.log('[STT] Starting Windows Speech Recognition...');
      execFile('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', RECOGNIZE_SCRIPT, '-TimeoutSeconds', '5',
      ], { timeout: 10000 }, (err, stdout) => {
        if (err) {
          console.error('[STT] PowerShell error:', err.message);
          resolve({ error: err.message });
          return;
        }
        try {
          const result = JSON.parse((stdout || '').trim());
          if (result.error) {
            console.error('[STT] Recognition error:', result.error);
            resolve({ error: result.error });
          } else if (result.text) {
            console.log(`[STT] Recognized: "${result.text}" (confidence: ${result.confidence})`);
            resolve(result.text);
          } else {
            console.log('[STT] No speech detected');
            resolve('');
          }
        } catch (parseErr) {
          console.error('[STT] Parse error:', parseErr.message, stdout);
          resolve({ error: 'Failed to parse recognition result' });
        }
      });
    });
  });
}

module.exports = { registerIpcHandlers };
