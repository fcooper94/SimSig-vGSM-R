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

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
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

function stop() {
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

function isRunning() {
  return server !== null;
}

module.exports = { start, stop, broadcast, isRunning };
