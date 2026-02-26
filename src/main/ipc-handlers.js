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
const TOGGLE_PAUSE_SCRIPT = require('path').join(__dirname, 'toggle-pause.ps1');
const READ_PHONE_BOOK_SCRIPT = require('path').join(__dirname, 'read-phone-book.ps1');
const DIAL_PHONE_BOOK_SCRIPT = require('path').join(__dirname, 'dial-phone-book.ps1');

const ELEVENLABS_API_KEY = '3998465c5e3d9716316d59035e326752511cb408fb6bb94e37bf7d1df273dc54';

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

          // Handle clock messages (pause/speed changes) — always forward to renderer
          if (msg.type === 'clock_msg') {
            updateClock(msg.data);
            const clockState = getClockState();
            sendToMainWindow(channels.CLOCK_UPDATE, {
              ...clockState,
              formatted: formatTime(clockState.clockSeconds),
            });
          }

          // Extract game time from any message that has a time field
          if (msg.data && msg.data.time != null) {
            updateClockTime(msg.data.time);
            const clockState = getClockState();
            if (clockState.clockSeconds > 0 && clockState.clockSeconds !== prevClock) {
              sendToMainWindow(channels.CLOCK_UPDATE, {
                ...clockState,
                formatted: formatTime(clockState.clockSeconds),
              });
            }
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

      // Briefly pause/unpause SimSig to trigger a clock_msg so the clock starts
      setTimeout(() => {
        execFile('powershell', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', TOGGLE_PAUSE_SCRIPT,
        ], { timeout: 5000 }, (err, stdout, stderr) => {
          if (err) console.error('[TogglePause] Error:', err.message);
          if (stdout) console.log('[TogglePause]', stdout.trim());
          if (stderr) console.error('[TogglePause] stderr:', stderr.trim());
        });
      }, 2000);

      // Start polling for phone calls from the SimSig window
      if (phoneReader) phoneReader.stopPolling();
      phoneReader = new PhoneReader(
        (calls) => sendToMainWindow(channels.PHONE_CALLS_UPDATE, calls),
        (simName) => {
          sendToMainWindow(channels.SIM_NAME, simName);
          settings.set('signaller.panelName', simName);
        },
      );
      phoneReader.startPolling(2000);

      // Pre-fetch ElevenLabs voices in background so first TTS is instant
      prefetchVoices().catch(() => {});
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
    console.log('[PhoneAnswer] args:', JSON.stringify(args));

    if (getClockState().paused) {
      return { error: 'Cannot answer while sim is paused. Unpause SimSig first.' };
    }

    return new Promise((resolve) => {
      execFile('powershell', args, { timeout: 10000 }, (err, stdout, stderr) => {
        // Re-raise our window and grab keyboard focus after PowerShell touched SimSig
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          win.setAlwaysOnTop(true, 'floating');
          win.moveTop();
          win.focus();
        }

        if (stderr) console.error('[PhoneAnswer] stderr:', stderr.trim());
        console.log('[PhoneAnswer] stdout:', (stdout || '').trim());

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
        // Re-raise our window and grab keyboard focus after PowerShell touched SimSig
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          win.setAlwaysOnTop(true, 'floating');
          win.moveTop();
          win.focus();
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

  // Phone Book — read contacts
  ipcMain.handle(channels.PHONE_BOOK_READ, () => {
    if (getClockState().paused) {
      return { error: 'Cannot open phone book while sim is paused', contacts: [] };
    }
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', READ_PHONE_BOOK_SCRIPT,
    ];
    return new Promise((resolve) => {
      execFile('powershell', args, { timeout: 15000 }, (err, stdout, stderr) => {
        if (stderr) console.error('[PhoneBook] stderr:', stderr.trim());
        console.log('[PhoneBook] stdout:', (stdout || '').trim());
        if (err) {
          console.error('[PhoneBook] Error:', err.message);
          resolve({ error: err.message, contacts: [] });
          return;
        }
        try {
          const lines = (stdout || '').trim().split(/\r?\n/).filter(Boolean);
          const jsonLine = lines[lines.length - 1] || '{}';
          resolve(JSON.parse(jsonLine));
        } catch (parseErr) {
          console.error('[PhoneBook] Parse error, raw output:', stdout);
          resolve({ error: 'Failed to parse response', contacts: [] });
        }
      });
    });
  });

  // Phone Book — dial a contact by index
  ipcMain.handle(channels.PHONE_BOOK_DIAL, (_event, index) => {
    if (getClockState().paused) {
      return { error: 'Cannot dial while sim is paused' };
    }
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', DIAL_PHONE_BOOK_SCRIPT, '-Index', String(index || 0),
    ];
    return new Promise((resolve) => {
      execFile('powershell', args, { timeout: 15000 }, (err, stdout, stderr) => {
        if (stderr) console.error('[PhoneBookDial] stderr:', stderr.trim());
        console.log('[PhoneBookDial] stdout:', (stdout || '').trim());
        if (err) {
          console.error('[PhoneBookDial] Error:', err.message);
          resolve({ error: err.message });
          return;
        }
        try {
          const lines = (stdout || '').trim().split(/\r?\n/).filter(Boolean);
          const jsonLine = lines[lines.length - 1] || '{}';
          resolve(JSON.parse(jsonLine));
        } catch (parseErr) {
          console.error('[PhoneBookDial] Parse error, raw output:', stdout);
          resolve({ error: 'Failed to parse response' });
        }
      });
    });
  });

  ipcMain.handle(channels.CMD_OPEN_MESSAGE_LOG, () => {
    const { createMessageLogWindow } = require('./main');
    createMessageLogWindow();
  });

  // TTS — ElevenLabs (account voices + shared library for more British voices)
  function fetchJSON(url, apiKey) {
    return new Promise((resolve) => {
      const req = https.request(url, {
        method: 'GET',
        headers: { 'xi-api-key': apiKey },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            console.error(`[TTS] API error ${res.statusCode} for ${url}: ${Buffer.concat(chunks).toString().slice(0, 200)}`);
            resolve(null);
            return;
          }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
          catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.end();
    });
  }

  // Only use these specific voices for driver TTS
  const ALLOWED_VOICE_NAMES = new Set([
    'Archer',
    'Benedict - Smooth British Narrator',
    'Bradford - British Narrator, Storyteller',
    'Russell - Dramatic British TV',
    'Eastend Steve',
    'Yowz - South London',
    'Tom',
    'John Smith',
    'George',
    'Jobi',
  ]);

  async function prefetchVoices() {
    if (ttsVoicesCache) return ttsVoicesCache;

    const mapVoice = (v) => ({
      id: v.voice_id,
      name: v.name,
      accent: v.labels?.accent || v.accent || '',
      gender: v.labels?.gender || v.gender || '',
    });

    const accountData = await fetchJSON('https://api.elevenlabs.io/v1/voices', ELEVENLABS_API_KEY);
    const allVoices = (accountData?.voices || []).map(mapVoice);
    const allowed = allVoices.filter((v) => ALLOWED_VOICE_NAMES.has(v.name));

    if (allowed.length === 0) {
      console.warn(`[TTS] No allowed voices found in account (${allVoices.length} total)`);
      ttsVoicesCache = allVoices;
      return allVoices;
    }

    ttsVoicesCache = allowed;
    console.log(`[TTS] ${allowed.length} allowed voices ready`);
    return allowed;
  }

  ipcMain.handle(channels.TTS_GET_VOICES, () => prefetchVoices());

  ipcMain.handle(channels.TTS_SPEAK, (_event, text, voiceId) => {
    if (!voiceId) return null;

    const body = JSON.stringify({
      text,
      model_id: 'eleven_flash_v2_5',
      voice_settings: { stability: 0.75, similarity_boost: 0.75, speed: 1.0 },
    });

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=4&output_format=mp3_22050_32`;

    return new Promise((resolve) => {
      const req = https.request(url, {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            const errBody = Buffer.concat(chunks).toString().slice(0, 200);
            console.error(`[TTS] API error ${res.statusCode}: ${errBody}`);
            resolve(null);
            return;
          }
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

  // STT — ElevenLabs Scribe (preferred) or Windows Speech Recognition (fallback)
  ipcMain.handle(channels.STT_TRANSCRIBE, (_event, audioData) => {
    // Use ElevenLabs STT if audio data provided
    if (audioData && audioData.length > 0) {
      return new Promise((resolve) => {
        console.log(`[STT] Using ElevenLabs Scribe (${audioData.length} bytes)...`);

        const boundary = '----ElevenLabsBoundary' + Date.now();
        const audioBuffer = Buffer.from(audioData);

        // Build multipart form data — each part as a separate Buffer
        const CRLF = '\r\n';
        const bodyParts = [];
        // model_id field
        bodyParts.push(Buffer.from(
          `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="model_id"${CRLF}${CRLF}` +
          `scribe_v1${CRLF}`
        ));
        // language_code field
        bodyParts.push(Buffer.from(
          `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="language_code"${CRLF}${CRLF}` +
          `en${CRLF}`
        ));
        // file field header
        bodyParts.push(Buffer.from(
          `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="file"; filename="audio.webm"${CRLF}` +
          `Content-Type: audio/webm${CRLF}${CRLF}`
        ));
        // file binary data
        bodyParts.push(audioBuffer);
        // closing boundary
        bodyParts.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`));
        const body = Buffer.concat(bodyParts);

        const req = https.request('https://api.elevenlabs.io/v1/speech-to-text', {
          method: 'POST',
          headers: {
            'xi-api-key': ELEVENLABS_API_KEY,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
        }, (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const responseText = Buffer.concat(chunks).toString();
            if (res.statusCode !== 200) {
              console.error(`[STT] ElevenLabs API error ${res.statusCode}: ${responseText.slice(0, 200)}`);
              resolve({ error: `API error ${res.statusCode}` });
              return;
            }
            try {
              const data = JSON.parse(responseText);
              const text = (data.text || '').trim();
              console.log(`[STT] ElevenLabs result: "${text}"`);
              resolve(text);
            } catch (parseErr) {
              console.error('[STT] Parse error:', parseErr.message);
              resolve({ error: 'Failed to parse STT response' });
            }
          });
        });
        req.on('error', (err) => {
          console.error('[STT] ElevenLabs request error:', err.message);
          resolve({ error: err.message });
        });
        req.write(body);
        req.end();
      });
    }

    // Fallback: Windows Speech Recognition
    return new Promise((resolve) => {
      console.log('[STT] Using Windows Speech Recognition fallback...');
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
