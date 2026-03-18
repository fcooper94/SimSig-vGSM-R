// vGSM-R central relay server
// Groups players by SimSig session (gateway IP:port) so everyone in the same
// session automatically discovers each other. No state, no database.

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 50507;

// rooms: Map<roomId, Map<playerId, { ws, panel }>>
const rooms = new Map();

// HTTP server handles Railway health checks
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('vGSM-R relay OK');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let playerId = null;
  let roomId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'player-register') {
      const newRoomId = msg.room || 'default';

      // If changing rooms, leave the old one and notify its remaining members
      if (playerId && roomId && roomId !== newRoomId) {
        rooms.get(roomId)?.delete(playerId);
        if (rooms.get(roomId)?.size === 0) rooms.delete(roomId);
        else broadcastRoom(roomId);
      }

      playerId = msg.id;
      roomId = newRoomId;

      if (!rooms.has(roomId)) rooms.set(roomId, new Map());
      rooms.get(roomId).set(playerId, { ws, panel: msg.panel });

      console.log(`[${roomId}] "${msg.panel}" registered — ${rooms.get(roomId).size} in room`);
      broadcastRoom(roomId);
      return;
    }

    if (msg.type === 'player-signal') {
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;
      const target = room.get(msg.targetId);
      if (target?.ws.readyState === 1) {
        const sender = room.get(playerId);
        target.ws.send(JSON.stringify({
          type: 'event',
          channel: 'player:signal',
          data: { from: playerId, fromPanel: sender?.panel, payload: msg.payload },
        }));
      }
    }
  });

  ws.on('close', () => {
    if (!playerId || !roomId) return;
    rooms.get(roomId)?.delete(playerId);
    console.log(`[${roomId}] "${playerId}" left — ${rooms.get(roomId)?.size ?? 0} in room`);
    broadcastRoom(roomId);
    if (rooms.get(roomId)?.size === 0) rooms.delete(roomId);
  });

  ws.on('error', () => {});
});

function broadcastRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const players = Array.from(room.entries()).map(([id, { panel }]) => ({ id, panel, relay: true }));
  const msg = JSON.stringify({ type: 'event', channel: 'player:peers-update', data: players });
  for (const { ws } of room.values()) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

server.listen(PORT, () => {
  console.log(`vGSM-R relay listening on port ${PORT}`);
});
