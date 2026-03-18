const { ipcMain, BrowserWindow, app } = require('electron');
const channels = require('../shared/ipc-channels');
const settings = require('./settings');
const { updateClock, updateClockTime, getClockState, formatTime } = require('./clock');
const { execFile, exec } = require('child_process');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const StompConnectionManager = require('./stomp-client');
const PhoneReader = require('./phone-reader');
const PeerDiscovery = require('./peer-discovery');

const SCRIPTS_DIR = __dirname.replace('app.asar', 'app.asar.unpacked');
const ANSWER_SCRIPT = require('path').join(SCRIPTS_DIR, 'answer-phone-call.ps1');
const REPLY_SCRIPT = require('path').join(SCRIPTS_DIR, 'reply-phone-call.ps1');
const RECOGNIZE_SCRIPT = require('path').join(SCRIPTS_DIR, 'speech-recognize.ps1');
const TOGGLE_PAUSE_SCRIPT = require('path').join(SCRIPTS_DIR, 'toggle-pause.ps1');
const READ_PHONE_BOOK_SCRIPT = require('path').join(SCRIPTS_DIR, 'read-phone-book.ps1');
const DIAL_PHONE_BOOK_SCRIPT = require('path').join(SCRIPTS_DIR, 'dial-phone-book.ps1');
const READ_PLACE_CALL_SCRIPT = require('path').join(SCRIPTS_DIR, 'read-place-call.ps1');
const REPLY_PLACE_CALL_SCRIPT = require('path').join(SCRIPTS_DIR, 'reply-place-call.ps1');
const HANGUP_PLACE_CALL_SCRIPT = require('path').join(SCRIPTS_DIR, 'hangup-place-call.ps1');
const HIDE_ANSWER_SCRIPT = require('path').join(SCRIPTS_DIR, 'hide-answer-dialog.ps1');
const FORCE_CLOSE_CALL_SCRIPT = require('path').join(SCRIPTS_DIR, 'force-close-call.ps1');
const DETECT_GATEWAY_SCRIPT = require('path').join(SCRIPTS_DIR, 'detect-gateway-host.ps1');

const globalPtt = require('./global-ptt');
const webServer = require('./web-server');
const os = require('os');

// Stable ID for this host instance — used for relay player registration
const ourRelayId = `${os.hostname()}-${process.pid}-${Date.now()}`;

// Relay call state
let activeRelayCallPartnerId = null;
let pendingRelayDialResolve = null;

// Relay client — Electron-to-Electron internet play.
// When connecting to a remote gateway, we also open a WS connection to the
// host's vGSM-R web relay so our Electron app registers as a relay player.
let relayClientWs = null;

let stompManager = null;
let phoneReader = null;
let ttsVoicesCache = null;
let elevenLabsVoicesCache = null;
let peerDiscovery = null;
let workstationPanels = null; // { "Panel 1": "JO", "Panel 2": "FC", ... }
let ourPanelName = ''; // our panel label (set at connect + workstation detection)
const PLAYER_CALL_PORT = 51521;

// Tracked state for syncing new WebSocket clients
let lastConnectionStatus = null;
let lastPhoneCalls = null;
let lastSimName = null;
let lastInitReady = false;
let lastChatState = null;

// Rolling buffer of recent message log lines for WAIT cross-check
const recentLogBuffer = []; // { text: string, ts: number (Date.now()) }
const RECENT_LOG_BUFFER_MAX = 300;

// Auto-wait state — managed in main process so interception happens at the source
const pendingAutoWaits = new Map(); // headcode (uppercase) → signal string
const suppressedAutoWaits = new Set(); // headcodes currently being auto-answered
const autoWaitQueue = []; // queue of { rawTrain, headcode } to process one at a time
let autoWaitRunning = false;

function extractHeadcode(text) {
  const m = (text || '').match(/([0-9][A-Za-z]\d{2})/);
  return m ? m[1].toUpperCase() : (text || '').trim();
}

// Queue an auto-wait and process sequentially
function queueAutoWait(rawTrain, headcode) {
  autoWaitQueue.push({ rawTrain, headcode });
  if (!autoWaitRunning) processAutoWaitQueue();
}

async function processAutoWaitQueue() {
  if (autoWaitRunning || autoWaitQueue.length === 0) return;
  autoWaitRunning = true;
  while (autoWaitQueue.length > 0) {
    const { rawTrain, headcode } = autoWaitQueue.shift();
    await doAutoWait(rawTrain, headcode);
  }
  autoWaitRunning = false;
}

// Runs answer-phone-call.ps1 then reply-phone-call.ps1 — same scripts as normal phone replies
async function doAutoWait(rawTrain, headcode) {
  if (!phoneReader) return;
  phoneReader._locked = true;

  // Wait for any in-flight PS1 scripts to finish
  await new Promise((resolve) => {
    const check = () => {
      if (!phoneReader.polling && !phoneReader._suppressing && !phoneReader._readingLog) {
        resolve();
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });

  try {
    // Step 1: Answer the call (same script as normal phone answer)
    const answerResult = await new Promise((resolve) => {
      const args = [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', ANSWER_SCRIPT, '-Index', '0', '-Train', rawTrain,
      ];
      console.log(`[AutoWait] Answering ${rawTrain}...`);
      execFile('powershell', args, { timeout: 10000 }, (err, stdout, stderr) => {
        if (stderr) console.error('[AutoWait] answer stderr:', stderr.trim());
        if (err) { resolve({ error: err.message }); return; }
        try { resolve(JSON.parse((stdout || '').trim())); }
        catch { resolve({ error: 'Failed to parse answer response' }); }
      });
    });

    if (answerResult.error) {
      console.warn(`[AutoWait] Answer failed for ${rawTrain}:`, answerResult.error);
      return;
    }

    // Step 2: Reply "Wait 15 minutes" (same script as normal phone reply, index 2)
    await new Promise((resolve) => {
      const args = [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', REPLY_SCRIPT, '-ReplyIndex', '2', '-HeadCode', headcode,
      ];
      console.log(`[AutoWait] Replying "Wait 15 mins" to ${rawTrain}...`);
      execFile('powershell', args, { timeout: 30000 }, (err, stdout, stderr) => {
        if (stderr) console.error('[AutoWait] reply stderr:', stderr.trim());
        if (err) { resolve({ error: err.message }); return; }
        try {
          const lines = (stdout || '').trim().split(/\r?\n/).filter(Boolean);
          resolve(JSON.parse(lines[lines.length - 1] || '{}'));
        } catch { resolve({ error: 'Failed to parse reply response' }); }
      });
    });

    // Re-raise our window
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.moveTop();
      win.focus();
    }

    console.log(`[AutoWait] Completed for ${rawTrain}`);
  } finally {
    phoneReader._locked = false;
  }
}

// Handler map for WebSocket bridge — stores all invoke handlers
const handlerMap = {};

function registerHandler(channel, fn) {
  ipcMain.handle(channel, fn);
  handlerMap[channel] = fn;
}

// WebSocket broadcast function — set by web server when active
let wsBroadcast = null;

function setWsBroadcast(fn) {
  wsBroadcast = fn;
}

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

function trackState(channel, data) {
  if (channel === channels.CONNECTION_STATUS) lastConnectionStatus = data;
  else if (channel === channels.PHONE_CALLS_UPDATE) lastPhoneCalls = data;
  else if (channel === channels.SIM_NAME) lastSimName = data;
  else if (channel === channels.INIT_READY) lastInitReady = !!data;
}

function sendToAllWindows(channel, data) {
  trackState(channel, data);
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, data);
  }
  if (wsBroadcast) wsBroadcast(channel, data);
}

function sendToMainWindow(channel, data) {
  trackState(channel, data);
  const wins = BrowserWindow.getAllWindows();
  if (wins.length > 0) {
    wins[0].webContents.send(channel, data);
  }
  if (wsBroadcast) wsBroadcast(channel, data);
}

function getInitialState() {
  const clockState = getClockState();
  return {
    connectionStatus: lastConnectionStatus,
    phoneCalls: lastPhoneCalls,
    simName: lastSimName,
    initReady: lastInitReady,
    clock: clockState.clockSeconds > 0 ? {
      ...clockState,
      formatted: formatTime(clockState.clockSeconds),
    } : null,
    chatState: lastChatState,
  };
}


function parseWorkstationLines(lines) {
  const ourInitials = (settings.get('signaller.initials') || '').toUpperCase();
  let foundOurPanel = false;
  for (const line of lines) {
    const m = line.match(/Workstation\s+(.+?)\s+transferred\s+to\s+(\S+)/i);
    if (m) {
      const panelName = m[1].trim();
      const initials = m[2].trim().toUpperCase();
      console.log(`[Workstation] "${panelName}" → ${initials}`);
      if (!workstationPanels) workstationPanels = {};
      workstationPanels[panelName] = initials;
      if (ourInitials && initials === ourInitials) {
        foundOurPanel = true;
        const fullPanel = `${panelName} (${lastSimName || ''})`.trim();
        console.log(`[Workstation] Our panel (client): "${fullPanel}"`);
        ourPanelName = fullPanel;
        if (peerDiscovery) peerDiscovery.updatePanel(fullPanel);
        webServer.registerHostPlayer(ourRelayId, fullPanel);
        if (relayClientWs?.readyState === 1) {
          relayClientWs.send(JSON.stringify({ type: 'player-register', id: ourRelayId, panel: fullPanel }));
        }
        sendToMainWindow('workstation:our-panel', panelName);
      }
    }
  }

  // If we didn't match any transfer, we're the host — we own unclaimed panels
  if (!foundOurPanel && workstationPanels && ourInitials) {
    const allPanels = Object.keys(workstationPanels);
    const claimedByOthers = new Set(Object.values(workstationPanels));
    // All known panels were claimed by clients, so host owns the rest
    // We can't know panel names that were never transferred, but we can
    // identify ourselves as the host
    const unclaimedPanels = allPanels.filter(p => workstationPanels[p] === ourInitials);
    if (unclaimedPanels.length === 0) {
      // No panels match our initials at all — we're the host
      const sim = lastSimName || 'Unknown';
      console.log(`[Workstation] No transfer for "${ourInitials}" — host of ${sim}`);
      const hostLabel = `${sim} (Host)`;
      ourPanelName = hostLabel;
      if (peerDiscovery) peerDiscovery.updatePanel(hostLabel);
      webServer.registerHostPlayer(ourRelayId, hostLabel);
      if (relayClientWs?.readyState === 1) {
        relayClientWs.send(JSON.stringify({ type: 'player-register', id: ourRelayId, panel: hostLabel }));
      }
      sendToMainWindow('workstation:our-panel', `Host — ${sim}`);
    }
  }
}

// ── Relay client (Electron-to-Electron internet play) ──────────────────────
// Unified signal send: uses relay client WS if we're a client,
// otherwise uses the host web server (if we're the host).
function _sendPlayerSignal(targetId, payload) {
  if (relayClientWs?.readyState === 1) {
    relayClientWs.send(JSON.stringify({ type: 'player-signal', targetId, payload }));
    return;
  }
  webServer.hostSendSignal(targetId, payload);
}

function _handleRelayClientMessage(data) {
  const { from, fromPanel, payload } = data || {};
  if (!payload) return;

  if (payload.type === 'offer' || payload.type === 'answer' || payload.type === 'ice') {
    console.log(`[WebRTC] Received ${payload.type} from ${from} → renderer`);
    sendToMainWindow(channels.PLAYER_WEBRTC_SIGNAL, { from, signal: payload });
    return;
  }
  if (payload.type === 'call-request') {
    activeRelayCallPartnerId = from;
    sendToMainWindow(channels.PLAYER_INCOMING_CALL, { panel: fromPanel, id: from });
  } else if (payload.type === 'call-accepted') {
    activeRelayCallPartnerId = from;
    if (pendingRelayDialResolve) {
      const r = pendingRelayDialResolve; pendingRelayDialResolve = null;
      r({ connected: true, peerPanel: fromPanel, peerId: from });
    } else {
      sendToMainWindow(channels.PLAYER_CALL_ANSWERED, { panel: fromPanel, id: from });
    }
  } else if (payload.type === 'call-rejected') {
    if (pendingRelayDialResolve) {
      const r = pendingRelayDialResolve; pendingRelayDialResolve = null;
      activeRelayCallPartnerId = null;
      r({ error: payload.reason || 'Rejected' });
    } else {
      activeRelayCallPartnerId = null;
      sendToMainWindow(channels.PLAYER_CALL_REJECTED, payload.reason || 'Rejected');
    }
  } else if (payload.type === 'call-end') {
    if (pendingRelayDialResolve) {
      const r = pendingRelayDialResolve; pendingRelayDialResolve = null;
      r({ error: 'Peer hung up' });
    } else {
      sendToMainWindow(channels.PLAYER_CALL_ENDED);
    }
    activeRelayCallPartnerId = null;
  }
}

const RELAY_PORT = 50507;

function _startRelayClient(host) {
  if (relayClientWs) {
    try { relayClientWs.close(); } catch (_) {}
    relayClientWs = null;
  }

  const url = `ws://${host}:${RELAY_PORT}`;
  const { WebSocket } = require('ws');
  const ws = new WebSocket(url);
  relayClientWs = ws;

  console.log('[RelayClient] Connecting to host relay:', url);

  ws.on('open', () => {
    console.log('[RelayClient] Connected — registering as', ourRelayId, '/', ourPanelName);
    ws.send(JSON.stringify({ type: 'player-register', id: ourRelayId, panel: ourPanelName }));
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'event') {
      if (msg.channel === 'player:peers-update') {
        const allPeers = msg.data || [];
        const relayPeers = allPeers.filter(p => p.id !== ourRelayId);
        console.log(`[RelayClient] Peers update — ${allPeers.length} total, showing ${relayPeers.length}: ${relayPeers.map(p => p.panel).join(', ') || '(none)'}`);
        const udpPeers = peerDiscovery ? peerDiscovery.getPeers() : [];
        const seenIds = new Set(udpPeers.map(p => p.id));
        const merged = [...udpPeers, ...relayPeers.filter(p => !seenIds.has(p.id))];
        sendToMainWindow(channels.PLAYER_PEERS_UPDATE, merged);
      } else if (msg.channel === 'player:signal') {
        _handleRelayClientMessage(msg.data);
      }
    }
  });

  ws.on('close', () => {
    if (relayClientWs === ws) relayClientWs = null;
    console.log('[RelayClient] Disconnected from host relay');
  });

  ws.on('error', (err) => {
    console.warn('[RelayClient] Connection failed:', err.message);
  });
}

function _stopRelayClient() {
  if (relayClientWs) {
    try { relayClientWs.close(); } catch (_) {}
    relayClientWs = null;
  }
}

function registerIpcHandlers() {
  // Wire up relay player list → Electron renderer (runs at startup, not just on connect)
  webServer.setOnRelayPlayersChanged((relayPeers) => {
    const udpPeers = peerDiscovery ? peerDiscovery.getPeers() : [];
    const seenIds = new Set(udpPeers.map(p => p.id));
    const merged = [...udpPeers, ...relayPeers.filter(p => !seenIds.has(p.id) && p.id !== ourRelayId)];
    console.log(`[WebServer] Relay players changed — ${relayPeers.length} relay, sending ${merged.length} to renderer: ${merged.map(p => p.panel).join(', ') || '(none)'}`);
    sendToMainWindow(channels.PLAYER_PEERS_UPDATE, merged);
  });

  // App info
  registerHandler('app:get-version', () => app.getVersion());

  // Settings
  registerHandler(channels.SETTINGS_GET, (_event, key) => settings.get(key));
  registerHandler(channels.SETTINGS_SET, (_event, key, value) => {
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
  registerHandler(channels.SETTINGS_GET_ALL, () => settings.getAll());

  // Global PTT keyboard hook
  const allSettings = settings.getAll();
  globalPtt.start({
    ptt: allSettings.ptt?.keybind || 'ControlLeft',
    answerCall: allSettings.answerCall?.keybind || 'Space',
    hangUp: allSettings.hangUp?.keybind || 'Space',
  });

  registerHandler(channels.PTT_SET_KEYBIND, (_event, code) => {
    globalPtt.setKeybind(code);
  });
  registerHandler(channels.ANSWER_CALL_SET_KEYBIND, (_event, code) => {
    globalPtt.setAnswerCallKeybind(code);
  });
  registerHandler(channels.HANGUP_SET_KEYBIND, (_event, code) => {
    globalPtt.setHangUpKeybind(code);
  });
  let mainInCall = false;
  registerHandler(channels.PHONE_IN_CALL, (_event, state) => {
    mainInCall = state;
    globalPtt.setInCall(state);
  });

  // Connection
  registerHandler(channels.CONNECTION_CONNECT, async () => {
    try {
      if (stompManager) {
        await stompManager.disconnect();
      }

      const config = settings.getAll();
      // Register host immediately so it appears in the player list right away
      const hostInitials = (config.signaller?.initials || 'Host').toUpperCase();
      ourPanelName = hostInitials;
      webServer.registerHostPlayer(ourRelayId, hostInitials);

      // If connecting to a non-local gateway, also connect to the host's vGSM-R relay
      // so this Electron app is discoverable by other Electron players (VATSIM-style).
      const gatewayHost = config.gateway.host;
      const isNonLocal = gatewayHost &&
        gatewayHost !== 'localhost' && gatewayHost !== '127.0.0.1';
      if (!isNonLocal) {
        // Local gateway — we are the SimSig host; start relay WS on fixed port
        if (!webServer.isRelayRunning()) {
          webServer.startRelay(RELAY_PORT);
          console.log(`[RelayClient] Local gateway — started relay WS on port ${RELAY_PORT}`);
        } else {
          console.log('[RelayClient] Local gateway — relay already running');
        }
      } else {
        // Remote gateway — we are a client; connect to the host's relay WS
        if (!webServer.isRelayRunning()) {
          console.log(`[RelayClient] Remote gateway detected (${gatewayHost}) — connecting to relay on port ${RELAY_PORT}`);
          _startRelayClient(gatewayHost);
        } else {
          console.log('[RelayClient] Remote gateway — relay already running (host mode), no client needed');
        }
      }

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
        (calls) => {
          // Intercept calls that match a pending auto-wait before they reach the renderer
          const afterAutoWait = [];
          for (const call of calls) {
            const hc = extractHeadcode(call.train);
            if (pendingAutoWaits.has(hc)) {
              console.log(`[AutoWait] Intercepted call from ${call.train} (${hc})`);
              suppressedAutoWaits.add(hc);
              phoneReader._locked = true;
              queueAutoWait(call.train, hc);
            } else if (suppressedAutoWaits.has(hc)) {
              // Still being auto-answered — keep suppressing
            } else {
              afterAutoWait.push(call);
            }
          }
          for (const hc of suppressedAutoWaits) {
            if (!calls.some((c) => extractHeadcode(c.train) === hc)) {
              suppressedAutoWaits.delete(hc);
            }
          }

          const filtered = afterAutoWait;

          lastPhoneCalls = filtered;
          sendToMainWindow(channels.PHONE_CALLS_UPDATE, filtered);
        },
        (simName) => {
          sendToMainWindow(channels.SIM_NAME, simName);
          settings.set('signaller.panelName', simName);
          // Don't broadcast sim name — wait for workstation detection to set the real panel
        },
        () => {
          console.log('[IPC] SimSig closed — forcing disconnect');
          if (phoneReader) {
            phoneReader.stopPolling();
            phoneReader = null;
          }
          if (stompManager) {
            stompManager.disconnect().catch(() => {});
            stompManager = null;
          }
          sendToAllWindows(channels.CONNECTION_STATUS, 'disconnected');
        },
        (paused) => {
          sendToMainWindow(channels.CLOCK_UPDATE, { paused, clockSeconds: 0, interval: 500 });
        },
        () => {
          sendToMainWindow(channels.PHONE_DRIVER_HUNG_UP);
        },
        (dismissed) => {
          sendToMainWindow(channels.FAILURE_DISMISSED, dismissed);
        },
        (lines) => {
          parseWorkstationLines(lines);
          sendToMainWindow(channels.MESSAGE_LOG_LINES, lines);
          // Buffer for WAIT cross-check
          const ts = Date.now();
          for (const line of lines) {
            if (line.trim()) recentLogBuffer.push({ text: line.trim(), ts });
          }
          if (recentLogBuffer.length > RECENT_LOG_BUFFER_MAX) {
            recentLogBuffer.splice(0, recentLogBuffer.length - RECENT_LOG_BUFFER_MAX);
          }
        },
      );
      // Keep our window above SimSig without being always-on-top globally
      // Scan full message log for workstation assignments (before 30-min filter)
      phoneReader.onWorkstationLines = (wksLines) => {
        parseWorkstationLines(wksLines);
      };
      phoneReader.onKeepAbove = () => {
        if (mainInCall || autoWaitRunning) return; // don't fight with PS1 scripts during calls
        const win = BrowserWindow.getAllWindows()[0];
        if (win && !win.isFocused() && !win.isMinimized()) {
          win.moveTop();
        }
      };
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

      // Start UDP peer discovery for LAN player detection
      if (peerDiscovery) peerDiscovery.stop();
      peerDiscovery = new PeerDiscovery();
      peerDiscovery.onPeersChanged = (udpPeers) => {
        const relayPeers = webServer.getRelayPlayers().filter(p => p.id !== ourRelayId);
        const seenIds = new Set(udpPeers.map(p => p.id));
        const merged = [...udpPeers, ...relayPeers.filter(p => !seenIds.has(p.id))];
        sendToMainWindow(channels.PLAYER_PEERS_UPDATE, merged);
      };
      peerDiscovery.start(ourPanelName, PLAYER_CALL_PORT);

      // Relay: handle signals and audio addressed to the host
      webServer.setOnHostRelayEvent((event) => {
        if (event.type !== 'signal') return;
        const { from, fromPanel, payload } = event;

        // WebRTC signals (offer/answer/ice) — forward straight to renderer
        if (payload.type === 'offer' || payload.type === 'answer' || payload.type === 'ice') {
          console.log(`[WebRTC] Host received ${payload.type} from ${from} → renderer`);
          sendToMainWindow(channels.PLAYER_WEBRTC_SIGNAL, { from, signal: payload });
          return;
        }

        if (payload.type === 'call-request') {
          activeRelayCallPartnerId = from;
          sendToMainWindow(channels.PLAYER_INCOMING_CALL, { panel: fromPanel, id: from });
        } else if (payload.type === 'call-accepted') {
          activeRelayCallPartnerId = from;
          webServer.setRelayActivePair(ourRelayId, from);
          if (pendingRelayDialResolve) {
            const r = pendingRelayDialResolve; pendingRelayDialResolve = null;
            r({ connected: true, peerPanel: fromPanel, peerId: from });
          } else {
            sendToMainWindow(channels.PLAYER_CALL_ANSWERED, { panel: fromPanel, id: from });
          }
        } else if (payload.type === 'call-rejected') {
          if (pendingRelayDialResolve) {
            const r = pendingRelayDialResolve; pendingRelayDialResolve = null;
            activeRelayCallPartnerId = null;
            r({ error: payload.reason || 'Rejected' });
          } else {
            activeRelayCallPartnerId = null;
            sendToMainWindow(channels.PLAYER_CALL_REJECTED, payload.reason || 'Rejected');
          }
        } else if (payload.type === 'call-end') {
          webServer.clearHostRelayPair();
          activeRelayCallPartnerId = null;
          if (pendingRelayDialResolve) {
            const r = pendingRelayDialResolve; pendingRelayDialResolve = null;
            r({ error: 'Peer hung up' });
          } else {
            sendToMainWindow(channels.PLAYER_CALL_ENDED);
          }
        }
      });

    } catch (err) {
      console.error('[Gateway] Connection failed:', err);
      sendToMainWindow(channels.CONNECTION_STATUS, { status: 'no-gateway', error: err.message });
    }
  });

  registerHandler(channels.CONNECTION_DISCONNECT, async () => {
    workstationPanels = null;
    activeRelayCallPartnerId = null;
    if (pendingRelayDialResolve) { pendingRelayDialResolve({ error: 'Disconnected' }); pendingRelayDialResolve = null; }
    webServer.clearHostRelayPair();
    _stopRelayClient();
    // Stop auto-started relay-only WS (but not the full web server managed by the user)
    if (webServer.isRelayRunning() && !webServer.isRunning()) {
      webServer.stop();
    }
    if (peerDiscovery) { peerDiscovery.stop(); peerDiscovery = null; }
    if (phoneReader) {
      phoneReader.stopPolling();
      phoneReader = null;
    }
    if (stompManager) {
      await stompManager.disconnect();
      stompManager = null;
    }
    // Ensure all clients get disconnected status and clear their calls
    sendToAllWindows(channels.CONNECTION_STATUS, 'disconnected');
  });

  // Detect gateway host via SimSig menu
  registerHandler(channels.DETECT_GATEWAY_HOST, () => {
    return new Promise((resolve) => {
      console.log('[DetectGateway] Running detect-gateway-host.ps1...');
      execFile('powershell', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', DETECT_GATEWAY_SCRIPT,
      ], { timeout: 10000 }, (err, stdout, stderr) => {
        if (stderr) console.error('[DetectGateway] stderr:', stderr.trim());
        if (stdout) console.log('[DetectGateway] stdout:', (stdout || '').trim());
        if (err) {
          console.error('[DetectGateway] Error:', err.message);
          resolve({ error: err.message });
          return;
        }
        try {
          const result = JSON.parse((stdout || '').trim());
          console.log('[DetectGateway] Result:', JSON.stringify(result));
          resolve(result);
        } catch (e) {
          console.error('[DetectGateway] Parse error, raw output:', stdout);
          resolve({ error: 'Failed to parse detection result' });
        }
      });
    });
  });

  // Check if SimSig is running (all sims use SimSigLoader.exe)
  registerHandler(channels.SIM_IS_RUNNING, () => {
    return new Promise((resolve) => {
      execFile('tasklist', ['/FI', 'IMAGENAME eq SimSigLoader.exe', '/NH', '/FO', 'CSV'],
        { timeout: 3000 }, (_err, stdout) => {
          resolve(!!stdout && stdout.includes('SimSigLoader.exe'));
        });
    });
  });

  // Commands
  registerHandler(channels.CMD_ALL_SIGNALS_DANGER, () => {
    if (stompManager && stompManager.status === 'connected') {
      return stompManager.allSignalsToDanger();
    }
    return 0;
  });

  registerHandler(channels.PHONE_ANSWER_CALL, (_event, index, train) => {
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

  // Reply to an incoming call — runs reply-phone-call.ps1 which:
  //   1. Selects the reply option in SimSig's TAnswerCallForm TListBox
  //   2. Clicks Reply (PostMessage — async to avoid blocking on modal dialogs)
  //   3. Handles headcode confirmation dialogs (enters headcode into TEdit, clicks OK)
  //   4. Dismisses any follow-up message/OK dialogs
  //   5. Hides SimSig's telephone window off-screen
  // The headCode param is needed for replies like "pass signal at danger" which
  // require the user to type the train's headcode to confirm the action.
  // stderr output contains debug logging from [Console]::Error.WriteLine().
  registerHandler(channels.PHONE_REPLY_CALL, (_event, replyIndex, headCode) => {
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

  // Queue an auto-wait — when the driver's call arrives in the next phone poll,
  // the onChange callback intercepts it and runs answer + reply silently.
  registerHandler(channels.PHONE_AUTO_WAIT, (_event, headcode, signal) => {
    const hc = (headcode || '').toUpperCase();
    const sig = (signal || '').toUpperCase();
    pendingAutoWaits.set(hc, sig);
    console.log(`[AutoWait] Queued for ${hc} at ${sig} — will intercept when driver calls`);
    return { ok: true };
  });

  // Clear an auto-wait (train moved to a different signal)
  registerHandler(channels.PHONE_CLEAR_AUTO_WAIT, (_event, headcode) => {
    const hc = (headcode || '').toUpperCase();
    pendingAutoWaits.delete(hc);
    suppressedAutoWaits.delete(hc);
    console.log(`[AutoWait] Cleared for ${hc} — train moved to new signal`);
    return { ok: true };
  });

  // Return recent log lines for a headcode received after a given wall-clock timestamp.
  // Used by the renderer to cross-check if a train has moved since the red signal alert.
  registerHandler(channels.PHONE_GET_RECENT_LOG, (_event, headcode, sinceTs) => {
    const hc = (headcode || '').toUpperCase();
    const since = sinceTs || 0;
    // Match any line containing the headcode as a word (catches STEP, LOCATION, direct entries)
    const hcPattern = new RegExp(`\\b${hc}\\b`, 'i');
    const lines = recentLogBuffer
      .filter((e) => e.ts > since && hcPattern.test(e.text))
      .map((e) => e.text);
    return { lines };
  });

  // Phone Book — read contacts
  registerHandler(channels.PHONE_BOOK_READ, () => {
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
  registerHandler(channels.PHONE_BOOK_DIAL, (_event, index) => {
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
  registerHandler(channels.PHONE_PLACE_CALL_STATUS, (_event, contactName) => {
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', READ_PLACE_CALL_SCRIPT,
    ];
    if (contactName) args.push('-ContactName', String(contactName));
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

  // Reply to an outgoing Place Call — runs reply-place-call.ps1 which:
  //   1. Finds the Place Call dialog and its reply control (TListBox or TComboBox)
  //   2. Selects the reply and clicks "Send request/message" (PostMessage — async)
  //   3. Handles Yes/No confirmation dialogs and headcode entry dialogs
  //   4. Reads the TMemo response text (SimSig's answer to our request)
  //   5. Returns { response: "..." } with the text, or { error: "..." } on failure
  registerHandler(channels.PHONE_PLACE_CALL_REPLY, (_event, replyIndex, headCode, param2, contactName) => {
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', REPLY_PLACE_CALL_SCRIPT, '-ReplyIndex', String(replyIndex || 0),
    ];
    if (headCode) args.push('-HeadCode', String(headCode));
    if (param2) args.push('-Param2', String(param2));
    if (contactName) args.push('-ContactName', String(contactName));
    return new Promise((resolve) => {
      execFile('powershell', args, { timeout: 30000 }, (err, stdout, stderr) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
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
  registerHandler(channels.PHONE_PLACE_CALL_HANGUP, () => {
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

  // Silence ring — broadcast to all clients so host + browser stay in sync
  registerHandler(channels.PHONE_SILENCE_RING, () => {
    sendToAllWindows(channels.PHONE_SILENCE_RING);
  });

  // Call answered — broadcast to all clients so they stop ringing
  registerHandler(channels.PHONE_CALL_ANSWERED, (_event, train) => {
    sendToAllWindows(channels.PHONE_CALL_ANSWERED, train);
  });

  // Chat sync — host renderer broadcasts its chat/notification state to browser clients only
  registerHandler(channels.PHONE_CHAT_SYNC, (_event, state) => {
    lastChatState = state;
    if (wsBroadcast) wsBroadcast(channels.PHONE_CHAT_SYNC, state);
  });

  // Remote action — browser sends an action (answer/reply/hangup) to be performed on the host
  registerHandler(channels.PHONE_REMOTE_ACTION, (_event, action) => {
    // Forward to the host's Electron renderer window (not WS clients)
    const wins = BrowserWindow.getAllWindows();
    if (wins.length > 0) {
      wins[0].webContents.send(channels.PHONE_REMOTE_ACTION, action);
    }
  });

  // Hide any lingering TAnswerCallForm dialog
  registerHandler(channels.PHONE_HIDE_ANSWER, () => {
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

  // Force-close the active call without clicking "Answer call" (preserves queued calls)
  registerHandler(channels.PHONE_FORCE_CLOSE_CALL, () => {
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', FORCE_CLOSE_CALL_SCRIPT,
    ];
    return new Promise((resolve) => {
      execFile('powershell', args, { timeout: 5000 }, (err, stdout, stderr) => {
        if (stderr) console.error('[ForceCloseCall] stderr:', stderr.trim());
        if (err) {
          resolve({ error: err.message });
          return;
        }
        resolve({ success: true });
      });
    });
  });

  registerHandler(channels.CMD_OPEN_MESSAGE_LOG, () => {
    const { createMessageLogWindow } = require('./main');
    createMessageLogWindow();
  });

  registerHandler(channels.WINDOW_TOGGLE_FULLSCREEN, () => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (win) win.setFullScreen(!win.isFullScreen());
  });

  registerHandler(channels.WINDOW_MINIMIZE, () => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (win) win.minimize();
  });

  registerHandler(channels.WINDOW_MAXIMIZE, () => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    }
  });

  registerHandler(channels.WINDOW_CLOSE, () => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (win) win.close();
  });

  registerHandler(channels.WINDOW_TOGGLE_COMPACT, () => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (!win) return;

    const { screen } = require('electron');

    if (!win._isCompact) {
      // Save current bounds before shrinking
      win._savedBounds = win.getBounds();

      // Exit fullscreen if active
      if (win.isFullScreen()) win.setFullScreen(false);

      // Get the display the window is currently on
      const display = screen.getDisplayMatching(win.getBounds());
      const workArea = display.workArea;

      const compactWidth = 450;
      const compactHeight = 70;

      // Allow the window to shrink below normal min size
      win.setMinimumSize(compactWidth, compactHeight);

      // Position in bottom-right corner of current display
      const x = workArea.x + workArea.width - compactWidth - 10;
      const y = workArea.y + workArea.height - compactHeight - 10;
      win.setBounds({ x, y, width: compactWidth, height: compactHeight });

      win.setResizable(false);
      win.webContents.send('window:compact-changed', true);
      win._isCompact = true;
    } else {
      // Restore to normal mode
      win.setResizable(true);
      win.setMinimumSize(700, 400);
      if (win._savedBounds) {
        win.setBounds(win._savedBounds);
      }

      win.webContents.send('window:compact-changed', false);
      win._isCompact = false;
    }
  });

  registerHandler(channels.WINDOW_COMPACT_RESIZE, (_e, height) => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (!win || !win._isCompact) return;
    const bounds = win.getBounds();
    const dy = height - bounds.height;
    win.setMinimumSize(bounds.width, height);
    win.setBounds({ x: bounds.x, y: bounds.y - dy, width: bounds.width, height });
  });

  // TTS — ElevenLabs (premium paid voices, requires API key)
  const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io';

  // Reject voices that clearly don't fit a train driver profile
  const REJECT_WORDS = [
    // Posh / RP / formal
    'velvety', 'velvet', 'elegant', 'refined', 'regal',
    'posh', 'formal', 'sophisticated', 'polished', 'narrator', 'narration',
    'newsreader', 'announcer', 'documentary', 'storyteller', 'captivating',
    'broadcaster', 'authoritative', 'educator',
    'meditation', 'asmr', 'soothing',
    'princess', 'queen', 'king', 'royal', 'butler', 'professor',
    'received pronunciation', 'upper class',
    'lecture', 'audiobook',
    // Wrong character type
    'sexy', 'seductive', 'romantic', 'flirty', 'sensual',
    'child', 'kid', 'toddler', 'baby', 'anime', 'cartoon',
    'robot', 'alien', 'monster', 'villain', 'wizard', 'elf',
    'customer support', 'customer care', 'corporate',
    'perky', 'bubbly',
    'whisper', 'whispery',
  ];

  // Prefer voices whose accent/description matches working-class regions
  const WORKING_CLASS_KEYWORDS = [
    'northern', 'yorkshire', 'manchester', 'lancashire', 'liverpool',
    'scouse', 'geordie', 'newcastle', 'cockney', 'east london', 'essex',
    'estuary', 'london', 'midlands', 'birmingham', 'brummie',
    'working class', 'casual', 'bloke', 'lad', 'geezer', 'mate',
    'rough', 'gruff', 'gritty', 'rugged', 'deep', 'husky',
    'south london', 'south east', 'bristol', 'west country',
    'welsh', 'nottingham', 'sheffield', 'leeds', 'hull', 'derby',
    'irish', 'scottish', 'glasgow',
  ];

  // Search the ElevenLabs shared voice library for working-class voices
  async function searchSharedVoices(apiKey) {
    // Use manual URL construction — URLSearchParams causes 400 errors
    const allVoices = [];
    const seenIds = new Set();

    async function doSearch(extraParams, label) {
      try {
        const url = `${ELEVENLABS_API_BASE}/v1/shared-voices?page_size=100&language=en${extraParams}&sort=trending&min_notice_period_days=0`;
        const resp = await fetch(url, { headers: { 'xi-api-key': apiKey } });
        if (!resp.ok) {
          const errBody = await resp.text().catch(() => '');
          console.warn(`[TTS] Shared search ${resp.status} for ${label}: ${errBody}`);
          return;
        }
        const data = await resp.json();
        let added = 0;
        for (const v of (data.voices || [])) {
          if (!seenIds.has(v.voice_id)) {
            seenIds.add(v.voice_id);
            allVoices.push(v);
            added++;
          }
        }
        console.log(`[TTS] Search "${label}" → ${(data.voices || []).length} results, ${added} new`);
      } catch (err) {
        console.warn(`[TTS] Shared search failed for ${label}:`, err.message);
      }
    }

    // British/Irish/Scottish accents with conversational + character use cases
    for (const accent of ['british', 'irish', 'scottish']) {
      await doSearch(`&accent=${accent}&use_cases=conversational`, `${accent}/conversational`);
      await doSearch(`&accent=${accent}&use_cases=characters`, `${accent}/characters`);
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

    // Only allow British Isles accents
    const ALLOWED_ACCENTS = [
      'british', 'english', 'irish', 'scottish', 'welsh',
      'cockney', 'northern', 'yorkshire', 'manchester', 'london',
      'estuary', 'midlands', 'geordie', 'scouse', 'brummie',
      'essex', 'west country', 'south east',
    ];

    // 4) Filter: reject posh, reject non-British accents
    const filtered = merged
      .filter((v) => {
        // Reject posh-sounding voices
        if (REJECT_WORDS.some((kw) => v.desc.includes(kw))) return false;
        // Reject non-British accents (american, indian, etc.)
        if (v.accent && !ALLOWED_ACCENTS.some((a) => v.accent.includes(a))) return false;
        return true;
      })
      .map((v) => {
        // Score working-class affinity
        const wcScore = WORKING_CLASS_KEYWORDS.reduce((s, kw) =>
          s + (v.desc.includes(kw) || v.accent.includes(kw) ? 1 : 0), 0);
        return {
          id: `el-${v.voiceId}`,
          name: v.name,
          accent: v.accent,
          gender: v.gender || 'male',
          wcScore,
        };
      });

    // Sort: working-class voices first, then by name for stability
    filtered.sort((a, b) => b.wcScore - a.wcScore || a.name.localeCompare(b.name));

    // Ensure ~90% male: keep all males, limit females to ~10% of total
    const males = filtered.filter((v) => v.gender === 'male');
    const females = filtered.filter((v) => v.gender !== 'male');
    const maxFemales = Math.max(1, Math.ceil(males.length * 0.1));
    const voices = [...males, ...females.slice(0, maxFemales)];

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
          model_id: 'eleven_turbo_v2_5',
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
  // Pitch/rate tweaks create distinct-sounding voices from the limited GB base voices
  // Mostly British/Irish males to sound like real train drivers (~90% male)
  const EDGE_VOICES = [
    // British males — varied pitch/rate to create distinct drivers
    { id: 'edge-0',  name: 'Dave',      voice: 'en-GB-RyanNeural',    accent: 'british', gender: 'male', pitch: '-20Hz', rate: 1.30 },
    { id: 'edge-1',  name: 'Steve',     voice: 'en-GB-RyanNeural',    accent: 'british', gender: 'male', pitch: '-12Hz', rate: 1.25 },
    { id: 'edge-2',  name: 'Kev',       voice: 'en-GB-RyanNeural',    accent: 'british', gender: 'male', pitch: '-6Hz',  rate: 1.20 },
    { id: 'edge-3',  name: 'Gaz',       voice: 'en-GB-ThomasNeural',  accent: 'british', gender: 'male', pitch: '-18Hz', rate: 1.28 },
    { id: 'edge-4',  name: 'Mark',      voice: 'en-GB-ThomasNeural',  accent: 'british', gender: 'male', pitch: '-8Hz',  rate: 1.22 },
    { id: 'edge-5',  name: 'Paul',      voice: 'en-GB-ThomasNeural',  accent: 'british', gender: 'male', pitch: '-2Hz',  rate: 1.18 },
    { id: 'edge-6',  name: 'Mike',      voice: 'en-GB-RyanNeural',    accent: 'british', gender: 'male', pitch: '-15Hz', rate: 1.35 },
    { id: 'edge-7',  name: 'Chris',     voice: 'en-GB-ThomasNeural',  accent: 'british', gender: 'male', pitch: '-14Hz', rate: 1.32 },
    { id: 'edge-8',  name: 'Rob',       voice: 'en-GB-RyanNeural',    accent: 'british', gender: 'male', pitch: '-24Hz', rate: 1.22 },
    // Irish male
    { id: 'edge-9',  name: 'Paddy',     voice: 'en-IE-ConnorNeural',  accent: 'irish',   gender: 'male', pitch: '-14Hz', rate: 1.25 },
    { id: 'edge-10', name: 'Sean',      voice: 'en-IE-ConnorNeural',  accent: 'irish',   gender: 'male', pitch: '-8Hz',  rate: 1.20 },
    // British female (1 out of 12 = ~8%)
    { id: 'edge-11', name: 'Lisa',      voice: 'en-GB-SoniaNeural',   accent: 'british', gender: 'female', pitch: '-15Hz', rate: 1.27 },
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

  registerHandler(channels.TTS_GET_VOICES, async () => {
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

  registerHandler(channels.TTS_SPEAK, async (_event, text, voiceId) => {
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
  registerHandler(channels.TTS_CHECK_CREDITS, async (_event, apiKey) => {
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
  registerHandler(channels.STT_TRANSCRIBE, async (_event, audioData) => {
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

  // ── Player-to-player calls (WebRTC relay) ─────────────────────────────────
  registerHandler(channels.PLAYER_DIAL, async (_event, peerId) => {
    // All calls go through the relay — audio is P2P via WebRTC after signaling
    _sendPlayerSignal(peerId, { type: 'call-request', panel: ourPanelName });
    activeRelayCallPartnerId = peerId;
    return new Promise((resolve) => {
      pendingRelayDialResolve = resolve;
      setTimeout(() => {
        if (pendingRelayDialResolve === resolve) {
          pendingRelayDialResolve = null;
          activeRelayCallPartnerId = null;
          webServer.clearHostRelayPair();
          resolve({ error: 'No answer (timeout)' });
        }
      }, 30000);
    });
  });

  registerHandler(channels.PLAYER_ANSWER, () => {
    if (!activeRelayCallPartnerId) return;
    _sendPlayerSignal(activeRelayCallPartnerId, { type: 'call-accepted', panel: ourPanelName });
    webServer.setRelayActivePair(ourRelayId, activeRelayCallPartnerId);
    sendToMainWindow(channels.PLAYER_CALL_ANSWERED, { panel: ourPanelName, id: activeRelayCallPartnerId });
  });

  registerHandler(channels.PLAYER_REJECT, (_event, reason) => {
    if (!activeRelayCallPartnerId) return;
    _sendPlayerSignal(activeRelayCallPartnerId, { type: 'call-rejected', reason: reason || 'Busy' });
    webServer.clearHostRelayPair();
    activeRelayCallPartnerId = null;
  });

  registerHandler(channels.PLAYER_HANGUP, () => {
    if (!activeRelayCallPartnerId) return;
    _sendPlayerSignal(activeRelayCallPartnerId, { type: 'call-end' });
    webServer.clearHostRelayPair();
    activeRelayCallPartnerId = null;
    sendToMainWindow(channels.PLAYER_CALL_ENDED);
  });

  registerHandler(channels.PLAYER_CANCEL_DIAL, () => {
    if (activeRelayCallPartnerId && pendingRelayDialResolve) {
      _sendPlayerSignal(activeRelayCallPartnerId, { type: 'call-end' });
      webServer.clearHostRelayPair();
      const r = pendingRelayDialResolve; pendingRelayDialResolve = null;
      activeRelayCallPartnerId = null;
      r({ error: 'Cancelled' });
    }
  });

  // WebRTC signaling — forward offer/answer/ICE candidates to relay target
  registerHandler(channels.PLAYER_WEBRTC_SIGNAL_SEND, (_event, targetId, signal) => {
    console.log(`[WebRTC] Sending ${signal?.type} → ${targetId}`);
    _sendPlayerSignal(targetId, signal);
  });
}

module.exports = { registerIpcHandlers, handlerMap, setWsBroadcast, getInitialState };
