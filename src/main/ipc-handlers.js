const { ipcMain, BrowserWindow, app } = require('electron');
const channels = require('../shared/ipc-channels');
const settings = require('./settings');
const { updateClock, updateClockTime, getClockState, formatTime } = require('./clock');
const { execFile } = require('child_process');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const StompConnectionManager = require('./stomp-client');
const PhoneReader = require('./phone-reader');

const ANSWER_SCRIPT = require('path').join(__dirname, 'answer-phone-call.ps1');
const REPLY_SCRIPT = require('path').join(__dirname, 'reply-phone-call.ps1');
const RECOGNIZE_SCRIPT = require('path').join(__dirname, 'speech-recognize.ps1');
const TOGGLE_PAUSE_SCRIPT = require('path').join(__dirname, 'toggle-pause.ps1');
const READ_PHONE_BOOK_SCRIPT = require('path').join(__dirname, 'read-phone-book.ps1');
const DIAL_PHONE_BOOK_SCRIPT = require('path').join(__dirname, 'dial-phone-book.ps1');
const READ_PLACE_CALL_SCRIPT = require('path').join(__dirname, 'read-place-call.ps1');
const REPLY_PLACE_CALL_SCRIPT = require('path').join(__dirname, 'reply-place-call.ps1');
const HANGUP_PLACE_CALL_SCRIPT = require('path').join(__dirname, 'hangup-place-call.ps1');
const HIDE_ANSWER_SCRIPT = require('path').join(__dirname, 'hide-answer-dialog.ps1');

const globalPtt = require('./global-ptt');


let stompManager = null;
let phoneReader = null;
let ttsVoicesCache = null;
let elevenLabsVoicesCache = null;

// Convert Float32 PCM samples to a 16-bit WAV buffer
function float32ToWav(samples, sampleRate) {
  const numSamples = samples.length;
  const byteRate = sampleRate * 2; // 16-bit mono
  const blockAlign = 2;
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);           // chunk size
  buffer.writeUInt16LE(1, 20);            // PCM format
  buffer.writeUInt16LE(1, 22);            // mono
  buffer.writeUInt32LE(sampleRate, 24);   // sample rate
  buffer.writeUInt32LE(byteRate, 28);     // byte rate
  buffer.writeUInt16LE(blockAlign, 32);   // block align
  buffer.writeUInt16LE(16, 34);           // bits per sample

  // data chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Convert Float32 [-1, 1] to Int16
  for (let i = 0; i < numSamples; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7FFF;
    buffer.writeInt16LE(Math.round(s), 44 + i * 2);
  }

  return buffer;
}

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
    // Invalidate TTS caches when provider or API key changes
    if (key === 'tts.provider') {
      ttsVoicesCache = null;
      elevenLabsVoicesCache = null;
    }
    if (key === 'tts.elevenLabsApiKey') {
      elevenLabsVoicesCache = null;
    }
  });
  ipcMain.handle(channels.SETTINGS_GET_ALL, () => settings.getAll());

  // Global PTT keyboard hook
  const allSettings = settings.getAll();
  globalPtt.start({
    ptt: allSettings.ptt?.keybind || 'ControlLeft',
    answerCall: allSettings.answerCall?.keybind || 'Space',
    hangUp: allSettings.hangUp?.keybind || 'Space',
  });

  ipcMain.handle(channels.PTT_SET_KEYBIND, (_event, code) => {
    globalPtt.setKeybind(code);
  });
  ipcMain.handle(channels.ANSWER_CALL_SET_KEYBIND, (_event, code) => {
    globalPtt.setAnswerCallKeybind(code);
  });
  ipcMain.handle(channels.HANGUP_SET_KEYBIND, (_event, code) => {
    globalPtt.setHangUpKeybind(code);
  });
  ipcMain.handle(channels.PHONE_IN_CALL, (_event, state) => {
    globalPtt.setInCall(state);
  });

  // Connection
  ipcMain.handle(channels.CONNECTION_CONNECT, async () => {
    try {
      if (stompManager) {
        await stompManager.disconnect();
      }

      const config = settings.getAll();
      console.log('[Gateway] Connecting to', config.gateway.host + ':' + config.gateway.port);
      let gatewayConnected = false;

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
          if (status === 'connected') gatewayConnected = true;
          // Stop retrying and show amber warning if gateway was never reached
          if (status === 'reconnecting' && !gatewayConnected) {
            sendToMainWindow(channels.CONNECTION_STATUS, { status: 'no-gateway' });
            // Deactivate STOMP to stop the endless reconnect loop
            if (stompManager && stompManager.client) {
              stompManager.client.deactivate();
              console.log('[Gateway] Stopped reconnection — no gateway available');
            }
            return;
          }
          sendToMainWindow(channels.CONNECTION_STATUS, status);
        },
        onError: (error) => {
          console.error('[Gateway] Error:', error);
          sendToMainWindow(channels.CONNECTION_STATUS, { status: 'no-gateway', error });
        },
      });

      stompManager.connect();

      // Start polling for phone calls from the SimSig window (independent of gateway)
      if (phoneReader) phoneReader.stopPolling();
      phoneReader = new PhoneReader(
        (calls) => sendToMainWindow(channels.PHONE_CALLS_UPDATE, calls),
        (simName) => {
          sendToMainWindow(channels.SIM_NAME, simName);
          settings.set('signaller.panelName', simName);
        },
        () => {
          console.log('[IPC] SimSig closed — quitting app');
          app.quit();
        },
        (paused) => {
          sendToMainWindow(channels.CLOCK_UPDATE, { paused, clockSeconds: 0, interval: 500 });
        },
        () => {
          sendToMainWindow(channels.PHONE_DRIVER_HUNG_UP);
        },
      );
      phoneReader.startPolling(2000);

      // Ensure Telephone Calls dialog is open so PhoneReader can poll
      setTimeout(() => {
        execFile('powershell', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', TOGGLE_PAUSE_SCRIPT,
        ], { timeout: 5000 }, (err, stdout, stderr) => {
          if (err) console.error('[TogglePause] Error:', err.message);
          if (stdout) console.log('[TogglePause]', stdout.trim());
          if (stderr) console.error('[TogglePause] stderr:', stderr.trim());
          sendToMainWindow(channels.INIT_READY, true);
        });
      }, 2000);

      // Pre-warm Edge TTS instances in background so first TTS is instant
      const ttsProvider = settings.get('tts.provider') || 'edge';
      if (ttsProvider === 'edge') {
        prefetchVoices().catch(() => {});
      }
    } catch (err) {
      console.error('[Gateway] Connection failed:', err);
      sendToMainWindow(channels.CONNECTION_STATUS, { status: 'no-gateway', error: err.message });
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

  // Place Call — read connection status and replies
  ipcMain.handle(channels.PHONE_PLACE_CALL_STATUS, () => {
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', READ_PLACE_CALL_SCRIPT,
    ];
    return new Promise((resolve) => {
      execFile('powershell', args, { timeout: 5000 }, (err, stdout, stderr) => {
        if (stderr) console.error('[PlaceCallStatus] stderr:', stderr.trim());
        console.log('[PlaceCallStatus] stdout:', (stdout || '').trim());
        if (err) {
          console.error('[PlaceCallStatus] Error:', err.message);
          resolve({ connected: false, error: err.message });
          return;
        }
        try {
          const lines = (stdout || '').trim().split(/\r?\n/).filter(Boolean);
          const jsonLine = lines[lines.length - 1] || '{}';
          const result = JSON.parse(jsonLine);
          console.log('[PlaceCallStatus] connected:', result.connected, 'debug:', result.debug || '');
          resolve(result);
        } catch (parseErr) {
          console.error('[PlaceCallStatus] Parse error, raw:', stdout);
          resolve({ connected: false, error: 'Failed to parse response' });
        }
      });
    });
  });

  // Place Call — send a reply
  ipcMain.handle(channels.PHONE_PLACE_CALL_REPLY, (_event, replyIndex, headCode) => {
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', REPLY_PLACE_CALL_SCRIPT, '-ReplyIndex', String(replyIndex || 0),
    ];
    if (headCode) args.push('-HeadCode', String(headCode));
    return new Promise((resolve) => {
      execFile('powershell', args, { timeout: 30000 }, (err, stdout, stderr) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          win.setAlwaysOnTop(true, 'floating');
          win.moveTop();
          win.focus();
        }
        if (stderr) console.error('[PlaceCallReply] stderr:', stderr.trim());
        if (err) {
          resolve({ error: err.message });
          return;
        }
        try {
          const lines = (stdout || '').trim().split(/\r?\n/).filter(Boolean);
          const jsonLine = lines[lines.length - 1] || '{}';
          const parsed = JSON.parse(jsonLine);
          console.log('[PlaceCallReply] stdout:', jsonLine);
          console.log('[PlaceCallReply] parsed:', JSON.stringify(parsed));
          resolve(parsed);
        } catch (parseErr) {
          console.error('[PlaceCallReply] Parse error, raw stdout:', stdout);
          resolve({ error: 'Failed to parse response' });
        }
      });
    });
  });

  // Place Call — hang up and close dialog
  ipcMain.handle(channels.PHONE_PLACE_CALL_HANGUP, () => {
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', HANGUP_PLACE_CALL_SCRIPT,
    ];
    return new Promise((resolve) => {
      execFile('powershell', args, { timeout: 5000 }, (err, stdout, stderr) => {
        if (stderr) console.error('[PlaceCallHangup] stderr:', stderr.trim());
        if (err) {
          resolve({ error: err.message });
          return;
        }
        try {
          const lines = (stdout || '').trim().split(/\r?\n/).filter(Boolean);
          const jsonLine = lines[lines.length - 1] || '{}';
          resolve(JSON.parse(jsonLine));
        } catch (parseErr) {
          resolve({ error: 'Failed to parse response' });
        }
      });
    });
  });

  // Hide any lingering TAnswerCallForm dialog
  ipcMain.handle(channels.PHONE_HIDE_ANSWER, () => {
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', HIDE_ANSWER_SCRIPT,
    ];
    return new Promise((resolve) => {
      execFile('powershell', args, { timeout: 5000 }, (err, stdout, stderr) => {
        if (stderr) console.error('[HideAnswer] stderr:', stderr.trim());
        if (err) {
          resolve({ error: err.message });
          return;
        }
        resolve({ success: true });
      });
    });
  });

  ipcMain.handle(channels.CMD_OPEN_MESSAGE_LOG, () => {
    const { createMessageLogWindow } = require('./main');
    createMessageLogWindow();
  });

  ipcMain.handle(channels.WINDOW_TOGGLE_FULLSCREEN, () => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (win) win.setFullScreen(!win.isFullScreen());
  });

  // TTS — ElevenLabs (premium paid voices, requires API key)
  const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io';

  // Reject voices whose name/description sounds posh, formal, or RP
  const POSH_NAME_WORDS = [
    'smooth', 'calm', 'velvety', 'velvet', 'elegant', 'refined', 'regal',
    'posh', 'formal', 'sophisticated', 'polished', 'narrator', 'narration',
    'newsreader', 'announcer', 'documentary', 'storyteller', 'captivating',
    'broadcaster', 'dramatic', 'authoritative', 'educator', 'steady',
    'engaging', 'inviting', 'surrey', 'suspense', 'clear,',
  ];

  // Search the ElevenLabs shared voice library for working-class voices
  async function searchSharedVoices(apiKey) {
    // Search for conversational/character voices with various British-adjacent accents
    const searchAccents = ['british', 'irish', 'scottish'];
    const searchUseCases = ['conversational', 'characters'];
    const allVoices = [];
    const seenIds = new Set();

    for (const accent of searchAccents) {
      for (const useCase of searchUseCases) {
        try {
          const url = `${ELEVENLABS_API_BASE}/v1/shared-voices?page_size=30&language=en&accent=${accent}&use_cases=${useCase}&sort=usage_character_count_7d&min_notice_period_days=0`;
          const resp = await fetch(url, { headers: { 'xi-api-key': apiKey } });
          if (!resp.ok) continue;
          const data = await resp.json();
          for (const v of (data.voices || [])) {
            if (!seenIds.has(v.voice_id)) {
              seenIds.add(v.voice_id);
              allVoices.push(v);
            }
          }
        } catch (err) {
          console.warn(`[TTS] Shared voice search failed for ${accent}/${useCase}:`, err.message);
        }
      }
    }
    return allVoices;
  }

  async function fetchElevenLabsVoices(apiKey) {
    if (elevenLabsVoicesCache) return elevenLabsVoicesCache;

    // 1) Fetch shared/community voices (much bigger pool, more regional variety)
    let sharedRaw = [];
    try {
      sharedRaw = await searchSharedVoices(apiKey);
      console.log(`[TTS] Found ${sharedRaw.length} shared community voices`);
    } catch (err) {
      console.warn('[TTS] Shared voice search failed, falling back to library only:', err.message);
    }

    // 2) Also fetch user's own library voices
    let libraryRaw = [];
    try {
      const resp = await fetch(`${ELEVENLABS_API_BASE}/v2/voices?page_size=100`, {
        headers: { 'xi-api-key': apiKey },
      });
      if (resp.ok) {
        const data = await resp.json();
        libraryRaw = data.voices || [];
        console.log(`[TTS] Found ${libraryRaw.length} library voices`);
      }
    } catch (err) {
      console.warn('[TTS] Library voice fetch failed:', err.message);
    }

    // 3) Merge and deduplicate (shared format differs slightly from library)
    const seenIds = new Set();
    const merged = [];

    // Shared voices: {voice_id, name, accent, gender, description, use_case, ...}
    for (const v of sharedRaw) {
      const id = v.voice_id || v.public_owner_id;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      merged.push({
        voiceId: v.voice_id,
        name: v.name || '',
        accent: (v.accent || '').toLowerCase(),
        gender: (v.gender || '').toLowerCase(),
        desc: `${v.name || ''} ${v.description || ''} ${v.use_case || ''}`.toLowerCase(),
      });
    }

    // Library voices: {voice_id, name, labels: {accent, gender, description, use_case, ...}}
    for (const v of libraryRaw) {
      if (seenIds.has(v.voice_id)) continue;
      seenIds.add(v.voice_id);
      const lang = (v.labels?.language || '').toLowerCase();
      if (lang && lang !== 'english' && !lang.startsWith('en')) continue;
      merged.push({
        voiceId: v.voice_id,
        name: v.name || '',
        accent: (v.labels?.accent || '').toLowerCase(),
        gender: (v.labels?.gender || '').toLowerCase(),
        desc: `${v.name || ''} ${v.labels?.description || ''} ${v.labels?.use_case || ''}`.toLowerCase(),
      });
    }

    // 4) Filter: reject posh, keep only relevant accents
    const voices = merged
      .filter((v) => {
        // Reject posh-sounding voices
        if (POSH_NAME_WORDS.some((kw) => v.desc.includes(kw))) return false;
        return true;
      })
      .map((v) => ({
        id: `el-${v.voiceId}`,
        name: v.name,
        accent: v.accent,
        gender: v.gender || 'male',
      }));

    // Log what we got
    const accentCounts = {};
    voices.forEach((v) => { accentCounts[v.accent] = (accentCounts[v.accent] || 0) + 1; });
    console.log('[TTS] ElevenLabs voice accent breakdown:', JSON.stringify(accentCounts));
    voices.forEach((v) => {
      console.log(`[TTS]   ${v.name} (${v.accent}, ${v.gender})`);
    });
    console.log(`[TTS] ${voices.length} ElevenLabs voices loaded (from ${merged.length} merged)`);
    elevenLabsVoicesCache = voices;
    return voices;
  }

  async function speakElevenLabs(text, voiceId, apiKey) {
    const realVoiceId = voiceId.startsWith('el-') ? voiceId.slice(3) : voiceId;

    const response = await fetch(
      `${ELEVENLABS_API_BASE}/v1/text-to-speech/${realVoiceId}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': apiKey,
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_flash_v2_5',
          voice_settings: {
            stability: 0.35,
            similarity_boost: 0.5,
            style: 0.6,
            speed: 1.2,
          },
        }),
      },
    );

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`ElevenLabs TTS error: ${response.status} ${errBody}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Array.from(new Uint8Array(arrayBuffer));
  }

  // TTS — Edge TTS (free Microsoft neural voices, no API key needed)
  // Subtle pitch/rate tweaks per voice to sound like distinct real people
  const EDGE_VOICES = [
    // British male
    { id: 'edge-0',  name: 'Ryan',      voice: 'en-GB-RyanNeural',                accent: 'british',      gender: 'male',   pitch: '-18Hz',  rate: 1.29 },
    { id: 'edge-1',  name: 'Thomas',    voice: 'en-GB-ThomasNeural',              accent: 'british',      gender: 'male',   pitch: '-5Hz',   rate: 1.23 },
    // British female
    { id: 'edge-2',  name: 'Sonia',     voice: 'en-GB-SoniaNeural',               accent: 'british',      gender: 'female', pitch: '-15Hz',  rate: 1.27 },
    { id: 'edge-3',  name: 'Libby',     voice: 'en-GB-LibbyNeural',               accent: 'british',      gender: 'female', pitch: '-7Hz',   rate: 1.21 },
    { id: 'edge-4',  name: 'Maisie',    voice: 'en-GB-MaisieNeural',              accent: 'british',      gender: 'female', pitch: '-10Hz',  rate: 1.25 },
    // Irish
    { id: 'edge-5',  name: 'Connor',    voice: 'en-IE-ConnorNeural',              accent: 'irish',        gender: 'male',   pitch: '-14Hz',  rate: 1.25 },
    { id: 'edge-6',  name: 'Emily',     voice: 'en-IE-EmilyNeural',               accent: 'irish',        gender: 'female', pitch: '-10Hz',  rate: 1.23 },
    // Australian
    { id: 'edge-7',  name: 'William',   voice: 'en-AU-WilliamMultilingualNeural', accent: 'australian',   gender: 'male',   pitch: '-16Hz',  rate: 1.27 },
    { id: 'edge-8',  name: 'Natasha',   voice: 'en-AU-NatashaNeural',             accent: 'australian',   gender: 'female', pitch: '-10Hz',  rate: 1.21 },
    // New Zealand
    { id: 'edge-9',  name: 'Mitchell',  voice: 'en-NZ-MitchellNeural',            accent: 'new zealand',  gender: 'male',   pitch: '-13Hz',  rate: 1.25 },
    { id: 'edge-10', name: 'Molly',     voice: 'en-NZ-MollyNeural',               accent: 'new zealand',  gender: 'female', pitch: '-6Hz',   rate: 1.23 },
    // Canadian
    { id: 'edge-11', name: 'Liam',      voice: 'en-CA-LiamNeural',                accent: 'canadian',     gender: 'male',   pitch: '-15Hz',  rate: 1.27 },
    { id: 'edge-12', name: 'Clara',     voice: 'en-CA-ClaraNeural',               accent: 'canadian',     gender: 'female', pitch: '-10Hz',  rate: 1.25 },
    // Hong Kong English
    { id: 'edge-13', name: 'Sam',       voice: 'en-HK-SamNeural',                 accent: 'hong kong',    gender: 'male',   pitch: '-14Hz',  rate: 1.23 },
    { id: 'edge-14', name: 'Yan',       voice: 'en-HK-YanNeural',                 accent: 'hong kong',    gender: 'female', pitch: '-10Hz',  rate: 1.21 },
    // Philippine English
    { id: 'edge-15', name: 'James',     voice: 'en-PH-JamesNeural',               accent: 'philippine',   gender: 'male',   pitch: '-13Hz',  rate: 1.25 },
    { id: 'edge-16', name: 'Rosa',      voice: 'en-PH-RosaNeural',                accent: 'philippine',   gender: 'female', pitch: '-10Hz',  rate: 1.23 },
    // Singaporean English
    { id: 'edge-17', name: 'Wayne',     voice: 'en-SG-WayneNeural',               accent: 'singaporean',  gender: 'male',   pitch: '-15Hz',  rate: 1.27 },
    { id: 'edge-18', name: 'Luna',      voice: 'en-SG-LunaNeural',                accent: 'singaporean',  gender: 'female', pitch: '-10Hz',  rate: 1.23 },
    // Tanzanian English
    { id: 'edge-19', name: 'Elimu',     voice: 'en-TZ-ElimuNeural',               accent: 'tanzanian',    gender: 'male',   pitch: '-14Hz',  rate: 1.25 },
    { id: 'edge-20', name: 'Imani',     voice: 'en-TZ-ImaniNeural',               accent: 'tanzanian',    gender: 'female', pitch: '-10Hz',  rate: 1.21 },
  ];

  // Cache MsEdgeTTS instances per base voice for reuse
  const ttsInstances = {};

  async function getOrCreateTTS(voiceName) {
    if (ttsInstances[voiceName]) return ttsInstances[voiceName];
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    ttsInstances[voiceName] = tts;
    return tts;
  }

  async function prefetchVoices() {
    if (ttsVoicesCache) return ttsVoicesCache;
    // Pre-warm TTS instances so first speak is fast
    const uniqueBaseVoices = [...new Set(EDGE_VOICES.map((v) => v.voice))];
    await Promise.allSettled(uniqueBaseVoices.map((v) => getOrCreateTTS(v)));
    console.log(`[TTS] ${EDGE_VOICES.length} Edge TTS voices ready (${uniqueBaseVoices.length} base voices)`);
    ttsVoicesCache = EDGE_VOICES.map(({ id, name, accent, gender }) => ({ id, name, accent, gender }));
    return ttsVoicesCache;
  }

  ipcMain.handle(channels.TTS_GET_VOICES, async () => {
    const provider = settings.get('tts.provider') || 'edge';

    if (provider === 'windows') {
      return { provider: 'windows' };
    }

    if (provider === 'elevenlabs') {
      const apiKey = (settings.get('tts.elevenLabsApiKey') || '').trim();
      if (!apiKey) {
        console.warn('[TTS] No ElevenLabs API key configured');
        return [];
      }
      try {
        return await fetchElevenLabsVoices(apiKey);
      } catch (err) {
        console.error('[TTS] ElevenLabs voices fetch failed:', err.message);
        return [];
      }
    }

    // Default: Edge TTS
    if (ttsVoicesCache) return ttsVoicesCache;
    return prefetchVoices();
  });

  function collectStream(tts, inputText, prosody) {
    return new Promise((resolve, reject) => {
      const { audioStream } = tts.toStream(inputText, prosody);
      const chunks = [];
      audioStream.on('data', (chunk) => chunks.push(chunk));
      audioStream.on('end', () => resolve(Buffer.concat(chunks)));
      audioStream.on('error', (err) => reject(err));
    });
  }

  async function speakEdgeTTS(text, voiceId) {
    const voiceDef = EDGE_VOICES.find((v) => v.id === voiceId);
    if (!voiceDef) {
      console.error(`[TTS] Unknown Edge voice ID: ${voiceId}`);
      return null;
    }

    const buildProsody = () => {
      const p = {};
      if (voiceDef.rate !== 1.0) p.rate = voiceDef.rate;
      if (voiceDef.pitch !== '+0Hz') p.pitch = voiceDef.pitch;
      return Object.keys(p).length > 0 ? p : undefined;
    };

    try {
      const tts = await getOrCreateTTS(voiceDef.voice);
      const buffer = await collectStream(tts, text, buildProsody());
      if (buffer.length === 0) {
        console.warn('[TTS] Empty audio returned, retrying with fresh instance...');
        delete ttsInstances[voiceDef.voice];
        const freshTts = await getOrCreateTTS(voiceDef.voice);
        const retryBuffer = await collectStream(freshTts, text, buildProsody());
        if (retryBuffer.length === 0) {
          console.error('[TTS] Retry also returned empty audio');
          return null;
        }
        return Array.from(retryBuffer);
      }
      return Array.from(buffer);
    } catch (err) {
      console.warn(`[TTS] Edge error (will retry): ${err.message}`);
      delete ttsInstances[voiceDef.voice];
      try {
        const freshTts = await getOrCreateTTS(voiceDef.voice);
        const buffer = await collectStream(freshTts, text, buildProsody());
        if (buffer.length === 0) return null;
        return Array.from(buffer);
      } catch (retryErr) {
        console.error('[TTS] Edge retry failed:', retryErr.message);
        return null;
      }
    }
  }

  ipcMain.handle(channels.TTS_SPEAK, async (_event, text, voiceId) => {
    if (!voiceId) return null;
    const provider = settings.get('tts.provider') || 'edge';

    if (provider === 'windows') {
      return null; // Renderer handles Windows TTS directly
    }

    if (provider === 'elevenlabs') {
      const apiKey = (settings.get('tts.elevenLabsApiKey') || '').trim();
      if (!apiKey) return null;
      try {
        return await speakElevenLabs(text, voiceId, apiKey);
      } catch (err) {
        console.error('[TTS] ElevenLabs speak error:', err.message);
        return null;
      }
    }

    // Default: Edge TTS
    return speakEdgeTTS(text, voiceId);
  });

  // ElevenLabs credit check — returns { remaining, total } or { error }
  ipcMain.handle(channels.TTS_CHECK_CREDITS, async (_event, apiKey) => {
    const trimmedKey = (apiKey || '').trim();
    if (!trimmedKey) return { error: 'No API key provided' };
    try {
      console.log(`[TTS] Checking ElevenLabs credits (key length: ${trimmedKey.length}, starts: ${trimmedKey.slice(0, 4)}...)`);
      const response = await fetch(`${ELEVENLABS_API_BASE}/v1/user/subscription`, {
        headers: { 'xi-api-key': trimmedKey },
      });
      if (response.status === 401) {
        const body = await response.text();
        console.error('[TTS] Credit check 401:', body);
        return { error: 'Invalid API key' };
      }
      if (!response.ok) {
        const body = await response.text();
        console.error(`[TTS] Credit check ${response.status}:`, body);
        return { error: `API error: ${response.status}` };
      }
      const data = await response.json();
      const used = data.character_count || 0;
      const limit = data.character_limit || 0;
      const remaining = limit - used;
      console.log(`[TTS] ElevenLabs credits: ${remaining}/${limit} remaining (tier: ${data.tier})`);
      return { remaining, total: limit, tier: data.tier || 'unknown' };
    } catch (err) {
      console.error('[TTS] Credit check error:', err.message);
      return { error: err.message };
    }
  });

  // STT — ElevenLabs Scribe (cloud, premium) or Vosk (handled in renderer)
  // When ElevenLabs is the TTS provider, audio is sent here for Scribe transcription.
  // When Edge/Windows TTS is selected, Vosk runs entirely in the renderer (no IPC).
  ipcMain.handle(channels.STT_TRANSCRIBE, async (_event, audioData) => {
    const provider = settings.get('tts.provider') || 'edge';

    if (provider === 'elevenlabs' && audioData) {
      const apiKey = (settings.get('tts.elevenLabsApiKey') || '').trim();
      if (!apiKey) {
        console.error('[STT] No ElevenLabs API key for Scribe');
        return { error: 'No API key' };
      }

      try {
        console.log(`[STT] Using ElevenLabs Scribe (${audioData.length} samples)...`);

        // Convert Float32 PCM samples to 16-bit WAV
        const wavBuffer = float32ToWav(audioData, 16000);

        // Build multipart form data manually (Node.js built-in)
        const boundary = '----ElevenLabsScribe' + Date.now();
        const formParts = [];

        // model_id field
        formParts.push(
          `--${boundary}\r\n` +
          'Content-Disposition: form-data; name="model_id"\r\n\r\n' +
          'scribe_v1\r\n'
        );

        // language_code field
        formParts.push(
          `--${boundary}\r\n` +
          'Content-Disposition: form-data; name="language_code"\r\n\r\n' +
          'en\r\n'
        );

        // file field
        formParts.push(
          `--${boundary}\r\n` +
          'Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n' +
          'Content-Type: audio/wav\r\n\r\n'
        );

        // Assemble body
        const preParts = formParts.slice(0, 2).join('');
        const fileHeader = formParts[2];
        const closing = `\r\n--${boundary}--\r\n`;

        const preBuffer = Buffer.from(preParts, 'utf-8');
        const fileHeaderBuffer = Buffer.from(fileHeader, 'utf-8');
        const closingBuffer = Buffer.from(closing, 'utf-8');
        const body = Buffer.concat([preBuffer, fileHeaderBuffer, wavBuffer, closingBuffer]);

        const response = await fetch(`${ELEVENLABS_API_BASE}/v1/speech-to-text`, {
          method: 'POST',
          headers: {
            'xi-api-key': apiKey,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
          },
          body,
        });

        if (!response.ok) {
          const errText = await response.text();
          console.error(`[STT] Scribe error ${response.status}:`, errText);
          return { error: `Scribe API error: ${response.status}` };
        }

        const result = await response.json();
        const text = (result.text || '').trim();
        console.log(`[STT] Scribe result: "${text}"`);
        return text;
      } catch (err) {
        console.error('[STT] Scribe error:', err.message);
        return { error: err.message };
      }
    }

    // Fallback: PowerShell Windows Speech Recognition (if called without audio data)
    return new Promise((resolve) => {
      console.log('[STT] Using Windows Speech Recognition fallback...');
      execFile('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', RECOGNIZE_SCRIPT, '-TimeoutSeconds', '15',
      ], { timeout: 20000 }, (err, stdout) => {
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
