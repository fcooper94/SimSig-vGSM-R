// web-server.js
// HTTP static file server + WebSocket IPC bridge for browser access.
// Serves the renderer files and bridges WebSocket messages to the
// same handler functions used by Electron IPC.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const RENDERER_DIR = path.join(__dirname, '../renderer');

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wasm': 'application/wasm',
};

let server = null;
let wss = null;
let handlerMap = null;
let primaryClient = null; // first connection gets full control
let getInitialStateFn = null;

// ── Relay player registry (for internet player-to-player calls) ────────────
const relayPlayers = new Map();  // ws → { id, panel }
const relayById = new Map();     // id → ws
const activePairs = new Map();   // playerId → callPartnerId (both directions stored)
let hostRelayInfo = null;        // { id, panel }
let onRelayPlayersChanged = null;
let onHostRelayEvent = null;

function start(port, handlers, getInitialState) {
  if (server) return;
  handlerMap = handlers;
  getInitialStateFn = getInitialState || null;

  server = http.createServer((req, res) => {
    // Serve static files from renderer directory
    let urlPath = req.url.split('?')[0];
    if (urlPath === '/') urlPath = '/index.html';

    // Resolve and sanitise path
    const filePath = path.join(RENDERER_DIR, urlPath);
    if (!filePath.startsWith(RENDERER_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    });
  });

  wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    // First connection becomes the primary (full control); others are read-only
    if (!primaryClient) {
      primaryClient = ws;
      ws.send(JSON.stringify({ type: 'role', role: 'primary' }));
      console.log('[WebServer] Primary browser client connected');
    } else {
      ws.send(JSON.stringify({ type: 'role', role: 'readonly' }));
      console.log('[WebServer] Read-only browser client connected');
    }

    // Sync current state so browser UI matches the host app
    if (getInitialStateFn) {
      const state = getInitialStateFn();
      if (state.connectionStatus != null) {
        ws.send(JSON.stringify({ type: 'event', channel: 'connection:status-changed', data: state.connectionStatus }));
      }
      if (state.phoneCalls != null) {
        ws.send(JSON.stringify({ type: 'event', channel: 'phone:calls-update', data: state.phoneCalls }));
      }
      if (state.simName != null) {
        ws.send(JSON.stringify({ type: 'event', channel: 'sim:name', data: state.simName }));
      }
      if (state.clock != null) {
        ws.send(JSON.stringify({ type: 'event', channel: 'clock:update', data: state.clock }));
      }
      if (state.initReady) {
        ws.send(JSON.stringify({ type: 'event', channel: 'init:ready', data: true }));
      }
      if (state.chatState) {
        ws.send(JSON.stringify({ type: 'event', channel: 'phone:chat-sync', data: state.chatState }));
      }
    }

    ws.on('message', async (raw, isBinary) => {
      // Binary frames not used (WebRTC handles audio P2P)
      if (isBinary) return;

      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Player presence registration
      if (msg.type === 'player-register') {
        const prev = relayPlayers.get(ws);
        if (prev?.id) relayById.delete(prev.id);
        const info = { id: msg.id, panel: msg.panel };
        relayPlayers.set(ws, info);
        relayById.set(msg.id, ws);
        console.log(`[WebServer] Player registered: "${msg.panel}" (${msg.id})`);
        _broadcastRelayPlayers();
        return;
      }

      // Player-to-player call signal
      if (msg.type === 'player-signal') {
        const sender = relayPlayers.get(ws);
        if (!sender?.id) return;
        _routeSignal(sender.id, sender.panel, msg.targetId, msg.payload);
        return;
      }

      if (msg.type === 'invoke' && msg.channel && handlerMap[msg.channel]) {
        // Only the primary client can invoke commands
        if (ws !== primaryClient) {
          ws.send(JSON.stringify({ id: msg.id, error: 'Read-only: proxy connection already active' }));
          return;
        }
        try {
          const args = msg.args || [];
          // Handler expects (_event, ...args) — pass null for event
          const result = await handlerMap[msg.channel](null, ...args);
          ws.send(JSON.stringify({ id: msg.id, result }));
        } catch (err) {
          ws.send(JSON.stringify({ id: msg.id, error: err.message }));
        }
      }
    });

    ws.on('close', () => {
      // Clean up relay state
      const player = relayPlayers.get(ws);
      if (player?.id) {
        if (activePairs.has(player.id)) {
          _routeSignal(player.id, player.panel, activePairs.get(player.id), { type: 'call-end' });
          _clearRelayPair(player.id);
        }
        relayById.delete(player.id);
        relayPlayers.delete(ws);
        _broadcastRelayPlayers();
      }

      if (ws === primaryClient) {
        primaryClient = null;
        console.log('[WebServer] Primary browser client disconnected');
      } else {
        console.log('[WebServer] Read-only browser client disconnected');
      }
    });
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[WebServer] Listening on port ${port}`);
  });
}

// ── Relay helpers ──────────────────────────────────────────────────────────

function _routeSignal(fromId, fromPanel, targetId, payload) {
  if (!targetId) return;
  console.log(`[Relay] Route ${payload.type} from ${fromId} → ${targetId} (host=${hostRelayInfo?.id})`);
  if (targetId === hostRelayInfo?.id) {
    if (onHostRelayEvent) {
      onHostRelayEvent({ type: 'signal', from: fromId, fromPanel, payload });
    } else {
      console.log('[Relay] onHostRelayEvent not set — signal dropped');
    }
  } else {
    const targetWs = relayById.get(targetId);
    if (targetWs?.readyState === 1) {
      targetWs.send(JSON.stringify({ type: 'event', channel: 'player:signal',
        data: { from: fromId, fromPanel, payload } }));
    } else {
      console.log(`[Relay] Target ${targetId} not found or disconnected`);
    }
  }
  // Manage active call pair state
  if (payload.type === 'call-accepted') {
    activePairs.set(fromId, targetId);
    activePairs.set(targetId, fromId);
  } else if (payload.type === 'call-end' || payload.type === 'call-rejected') {
    _clearRelayPair(fromId);
  }
}

function _clearRelayPair(id) {
  const partner = activePairs.get(id);
  if (partner !== undefined) activePairs.delete(partner);
  activePairs.delete(id);
}

function _broadcastRelayPlayers() {
  const players = getRelayPlayers();
  const msg = JSON.stringify({ type: 'event', channel: 'player:peers-update', data: players });
  if (wss) {
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(msg);
    }
  }
  if (onRelayPlayersChanged) onRelayPlayersChanged(players);
}

// ── Public relay API ───────────────────────────────────────────────────────

function registerHostPlayer(id, panel) {
  hostRelayInfo = { id, panel };
  _broadcastRelayPlayers();
}

function getRelayPlayers() {
  const players = [];
  if (hostRelayInfo) players.push({ id: hostRelayInfo.id, panel: hostRelayInfo.panel, relay: true });
  for (const [, p] of relayPlayers) {
    if (p.id && p.panel) players.push({ id: p.id, panel: p.panel, relay: true });
  }
  return players;
}

function hostSendSignal(targetId, payload) {
  const targetWs = relayById.get(targetId);
  if (targetWs?.readyState === 1) {
    targetWs.send(JSON.stringify({ type: 'event', channel: 'player:signal',
      data: { from: hostRelayInfo?.id, fromPanel: hostRelayInfo?.panel, payload } }));
    return true;
  }
  return false;
}

function setRelayActivePair(id1, id2) {
  activePairs.set(id1, id2);
  activePairs.set(id2, id1);
}

function clearHostRelayPair() {
  if (hostRelayInfo?.id) _clearRelayPair(hostRelayInfo.id);
}

function setOnRelayPlayersChanged(fn) { onRelayPlayersChanged = fn; }
function setOnHostRelayEvent(fn) { onHostRelayEvent = fn; }

// ── Stop / Broadcast ───────────────────────────────────────────────────────

function stop() {
  relayPlayers.clear();
  relayById.clear();
  activePairs.clear();
  hostRelayInfo = null;
  if (wss) {
    // Close all clients with code 4000 = host shutting down
    // The close code is delivered reliably with the close event
    for (const client of wss.clients) {
      client.close(4000, 'host-closed');
    }
    wss.close();
    wss = null;
  }
  if (server) {
    server.close();
    server = null;
  }
  primaryClient = null;
  handlerMap = null;
  console.log('[WebServer] Stopped');
}

function broadcast(channel, data) {
  if (!wss) return;
  const msg = JSON.stringify({ type: 'event', channel, data });
  for (const client of wss.clients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(msg);
    }
  }
}

// ── Relay-only WebSocket (no HTTP, no IPC bridge) ─────────────────────────
// Started automatically when hosting a SimSig session so other Electron
// players can connect and register even without Browser Access enabled.

function startRelay(port) {
  if (wss) return; // already running (either relay-only or full web server)

  wss = new WebSocketServer({ port });

  wss.on('connection', (ws) => {
    // Relay-only: just handle player-register and player-signal
    ws.send(JSON.stringify({ type: 'role', role: 'relay' }));

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'player-register') {
        const prev = relayPlayers.get(ws);
        if (prev?.id) relayById.delete(prev.id);
        const info = { id: msg.id, panel: msg.panel };
        relayPlayers.set(ws, info);
        relayById.set(msg.id, ws);
        console.log(`[WebServer] Relay player registered: "${msg.panel}" (${msg.id})`);
        _broadcastRelayPlayers();
        return;
      }

      if (msg.type === 'player-signal') {
        const sender = relayPlayers.get(ws);
        if (!sender?.id) return;
        _routeSignal(sender.id, sender.panel, msg.targetId, msg.payload);
      }
    });

    ws.on('close', () => {
      const player = relayPlayers.get(ws);
      if (player?.id) {
        if (activePairs.has(player.id)) {
          _routeSignal(player.id, player.panel, activePairs.get(player.id), { type: 'call-end' });
          _clearRelayPair(player.id);
        }
        relayById.delete(player.id);
        relayPlayers.delete(ws);
        _broadcastRelayPlayers();
      }
    });
  });

  wss.on('error', (err) => {
    console.error('[WebServer] Relay WS error:', err.message);
  });

  console.log(`[WebServer] Relay-only WS listening on port ${port}`);
}

function isRunning() {
  return server !== null;
}

function isRelayRunning() {
  return wss !== null;
}

module.exports = {
  start, startRelay, stop, broadcast, isRunning, isRelayRunning,
  registerHostPlayer, getRelayPlayers,
  hostSendSignal, setRelayActivePair, clearHostRelayPair,
  setOnRelayPlayersChanged, setOnHostRelayEvent,
};
