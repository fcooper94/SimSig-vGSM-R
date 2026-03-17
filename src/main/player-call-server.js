// player-call-server.js
// WebSocket server + client for player-to-player voice calls.
// Handles call signaling (ring, answer, hangup) and relays
// raw PCM audio between peers in real-time.

const { WebSocketServer, WebSocket } = require('ws');

const CALL_RING_TIMEOUT = 30000; // 30s to answer before auto-hangup

class PlayerCallServer {
  constructor() {
    this.wss = null;
    this.port = 0;
    this.panelName = '';
    this.activeCall = null; // { ws, peerId, peerPanel, direction: 'incoming'|'outgoing' }
    this.outgoingWs = null; // WebSocket client for outgoing calls

    // Callbacks set by ipc-handlers
    this.onIncomingCall = null;   // (peerPanel, peerId) => void
    this.onCallAnswered = null;   // () => void
    this.onCallEnded = null;      // () => void
    this.onAudioReceived = null;  // (pcmFloat32Array) => void
    this.onCallRejected = null;   // (reason) => void
  }

  start(port, panelName) {
    this.port = port;
    this.panelName = panelName;
    if (this.wss) this.stop();

    this.wss = new WebSocketServer({ port, host: '0.0.0.0' });
    this.wss.on('listening', () => {
      console.log(`[PlayerCalls] Server listening on port ${port}`);
    });
    this.wss.on('error', (err) => {
      console.error('[PlayerCalls] Server error:', err.message);
    });

    this.wss.on('connection', (ws) => {
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          // Binary = PCM audio frame
          this._handleAudio(ws, data);
        } else {
          this._handleSignaling(ws, JSON.parse(data.toString()));
        }
      });
      const endIfActive = (reason) => {
        if (this.activeCall && this.activeCall.ws === ws) {
          console.log(`[PlayerCalls] ${reason} — ending call/ringing`);
          this._endCall();
        }
      };
      ws.on('close', () => endIfActive('WebSocket closed'));
      ws.on('error', (err) => {
        console.log('[PlayerCalls] WebSocket error:', err.message);
        endIfActive('WebSocket error');
      });
    });
  }

  stop() {
    this.hangUp();
    if (this.wss) {
      for (const client of this.wss.clients) {
        client.close(1000, 'server-shutdown');
      }
      this.wss.close();
      this.wss = null;
    }
  }

  updatePanel(panelName) {
    this.panelName = panelName;
  }

  // Initiate an outgoing call to a peer
  dialPeer(host, port, peerId) {
    if (this.activeCall) return { error: 'Already in a call' };
    if (this.outgoingWs) return { error: 'Already dialing' };

    return new Promise((resolve) => {
      const url = `ws://${host}:${port}`;
      console.log(`[PlayerCalls] Dialing ${url}...`);

      const ws = new WebSocket(url);
      this.outgoingWs = ws;
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.outgoingWs = null;
          ws.close();
          resolve({ error: 'No answer (timeout)' });
        }
      }, CALL_RING_TIMEOUT);

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'call-request',
          panel: this.panelName,
        }));
      });

      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          this._handleAudio(ws, data);
          return;
        }
        const msg = JSON.parse(data.toString());
        if (msg.type === 'call-accepted') {
          clearTimeout(timeout);
          settled = true;
          this.outgoingWs = null;
          this.activeCall = { ws, peerId, peerPanel: msg.panel, direction: 'outgoing' };
          console.log(`[PlayerCalls] Call accepted by ${msg.panel}`);
          resolve({ connected: true, peerPanel: msg.panel });
        } else if (msg.type === 'call-rejected') {
          clearTimeout(timeout);
          settled = true;
          this.outgoingWs = null;
          ws.close();
          resolve({ error: msg.reason || 'Call rejected' });
        } else if (msg.type === 'call-end') {
          clearTimeout(timeout);
          if (!settled) {
            settled = true;
            this.outgoingWs = null;
            ws.close();
            resolve({ error: 'Peer hung up' });
          } else {
            this._endCall();
          }
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          this.outgoingWs = null;
          resolve({ error: `Connection failed: ${err.message}` });
        }
      });

      ws.on('close', () => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          this.outgoingWs = null;
          resolve({ error: 'Connection closed' });
        } else if (this.activeCall && this.activeCall.ws === ws) {
          this._endCall();
        }
      });
    });
  }

  // Cancel an outgoing dial attempt
  cancelDial() {
    if (this.outgoingWs) {
      console.log('[PlayerCalls] Cancelling dial, ws state:', this.outgoingWs.readyState);
      if (this.outgoingWs.readyState === WebSocket.OPEN) {
        try { this.outgoingWs.send(JSON.stringify({ type: 'call-end' })); } catch {}
      }
      // terminate() for immediate disconnect — close() can delay
      try { this.outgoingWs.terminate(); } catch {}
      this.outgoingWs = null;
    }
  }

  // Answer an incoming call
  answerCall() {
    if (!this.activeCall || this.activeCall.direction !== 'incoming') return;
    if (this._ringTimeout) { clearTimeout(this._ringTimeout); this._ringTimeout = null; }
    if (this._ringPing) { clearInterval(this._ringPing); this._ringPing = null; }
    try {
      this.activeCall.ws.send(JSON.stringify({
        type: 'call-accepted',
        panel: this.panelName,
      }));
    } catch {}
    if (this.onCallAnswered) this.onCallAnswered();
  }

  // Reject an incoming call
  rejectCall(reason) {
    if (!this.activeCall) return;
    try {
      this.activeCall.ws.send(JSON.stringify({
        type: 'call-rejected',
        reason: reason || 'Busy',
      }));
    } catch {}
    const ws = this.activeCall.ws;
    this.activeCall = null;
    if (this._ringTimeout) { clearTimeout(this._ringTimeout); this._ringTimeout = null; }
    if (this._ringPing) { clearInterval(this._ringPing); this._ringPing = null; }
    try { ws.close(); } catch {}
  }

  // Hang up the active call
  hangUp() {
    if (this._ringTimeout) { clearTimeout(this._ringTimeout); this._ringTimeout = null; }
    if (this._ringPing) { clearInterval(this._ringPing); this._ringPing = null; }
    if (this.outgoingWs) {
      if (this.outgoingWs.readyState === WebSocket.OPEN) {
        try { this.outgoingWs.send(JSON.stringify({ type: 'call-end' })); } catch {}
      }
      try { this.outgoingWs.terminate(); } catch {}
      this.outgoingWs = null;
    }
    if (this.activeCall) {
      try {
        this.activeCall.ws.send(JSON.stringify({ type: 'call-end' }));
      } catch {}
      try { this.activeCall.ws.close(); } catch {}
      this.activeCall = null;
      if (this.onCallEnded) this.onCallEnded();
    }
  }

  // Send PCM audio to the peer (Float32Array → binary WebSocket frame)
  sendAudio(pcmFloat32Array) {
    const ws = this.activeCall?.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Send as raw Float32 bytes
    const buf = Buffer.from(pcmFloat32Array.buffer, pcmFloat32Array.byteOffset, pcmFloat32Array.byteLength);
    ws.send(buf);
  }

  isInCall() {
    return this.activeCall !== null;
  }

  isDialing() {
    return this.outgoingWs !== null;
  }

  _handleSignaling(ws, msg) {
    if (msg.type === 'call-request') {
      // Someone is calling us
      if (this.activeCall || this.outgoingWs) {
        // Already busy
        ws.send(JSON.stringify({ type: 'call-rejected', reason: 'Busy' }));
        return;
      }
      console.log(`[PlayerCalls] Incoming call from ${msg.panel}`);
      this.activeCall = { ws, peerId: msg.id, peerPanel: msg.panel, direction: 'incoming' };
      // Auto-reject after timeout if not answered
      this._ringTimeout = setTimeout(() => {
        if (this.activeCall && this.activeCall.direction === 'incoming' && this.activeCall.ws === ws) {
          this.rejectCall('No answer');
          if (this.onCallEnded) this.onCallEnded();
        }
      }, CALL_RING_TIMEOUT);
      // Ping/pong to detect caller hangup during ringing
      let pongReceived = true;
      ws.on('pong', () => { pongReceived = true; });
      this._ringPing = setInterval(() => {
        if (!this.activeCall || this.activeCall.ws !== ws) {
          clearInterval(this._ringPing);
          this._ringPing = null;
          return;
        }
        if (!pongReceived || ws.readyState !== WebSocket.OPEN) {
          console.log('[PlayerCalls] Caller disconnected during ringing (no pong)');
          clearInterval(this._ringPing);
          this._ringPing = null;
          this._endCall();
          return;
        }
        pongReceived = false;
        try { ws.ping(); } catch {}
      }, 2000);
      if (this.onIncomingCall) this.onIncomingCall(msg.panel, msg.id);
    } else if (msg.type === 'call-end') {
      if (this.activeCall && this.activeCall.ws === ws) {
        this._endCall();
      }
    }
  }

  _handleAudio(ws, data) {
    if (!this.activeCall || this.activeCall.ws !== ws) return;
    if (this.onAudioReceived) {
      // Convert binary Buffer to Float32Array
      const float32 = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
      this.onAudioReceived(float32);
    }
  }

  _endCall() {
    if (this._ringTimeout) { clearTimeout(this._ringTimeout); this._ringTimeout = null; }
    if (this._ringPing) { clearInterval(this._ringPing); this._ringPing = null; }
    if (this.activeCall) {
      try { this.activeCall.ws.close(); } catch {}
      this.activeCall = null;
    }
    if (this.onCallEnded) this.onCallEnded();
  }
}

module.exports = PlayerCallServer;
