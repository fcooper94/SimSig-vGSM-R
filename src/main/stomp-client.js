const { Client } = require('@stomp/stompjs');
const { TCPWrapper } = require('@stomp/tcp-wrapper');
const { TOPICS } = require('../shared/constants');
const { parseMessage } = require('./message-parser');

class StompConnectionManager {
  constructor({ host, port, username, password, onMessage, onStatusChange, onError }) {
    this.host = host;
    this.port = port;
    this.username = username;
    this.password = password;
    this.onMessage = onMessage;
    this.onStatusChange = onStatusChange;
    this.onError = onError;
    this.client = null;
    this.subscriptions = [];
    this.status = 'disconnected';
    this.knownSignals = new Set();
  }

  connect() {
    this._setStatus('connecting');

    try {
      this.client = new Client({
        webSocketFactory: () => new TCPWrapper(this.host, this.port),
        connectHeaders: {
          ...(this.username ? { login: this.username } : {}),
          ...(this.password ? { passcode: this.password } : {}),
        },
        reconnectDelay: 5000,
        heartbeatIncoming: 10000,
        heartbeatOutgoing: 10000,
        debug: (msg) => {
          // Suppress credential logging
          if (msg.includes('passcode')) return;
          console.log('[STOMP]', msg);
        },
        onConnect: () => this._onConnected(),
        onDisconnect: () => this._onDisconnected(),
        onStompError: (frame) => this._onStompError(frame),
        onWebSocketClose: (evt) => {
          console.log('[STOMP] TCP closed:', evt?.reason || 'unknown');
          if (this.status !== 'disconnected') {
            this._setStatus('reconnecting');
          }
        },
        onWebSocketError: (evt) => {
          console.error('[STOMP] TCP error:', evt);
          if (this.onError) {
            this.onError(evt?.message || 'Connection failed');
          }
        },
      });

      this.client.activate();
    } catch (err) {
      console.error('[STOMP] Failed to connect:', err);
      if (this.onError) {
        this.onError(err.message || 'Failed to connect');
      }
    }
  }

  async disconnect() {
    this._setStatus('disconnected');
    if (this.client) {
      await this.client.deactivate();
      this.client = null;
    }
    this.subscriptions = [];
  }

  _onConnected() {
    this._setStatus('connected');

    const topics = [TOPICS.TD, TOPICS.TRAIN_MVT, TOPICS.SIMSIG];
    for (const topic of topics) {
      const sub = this.client.subscribe(topic, (message) => {
        this._handleMessage(topic, message);
      }, { ack: 'auto' });
      this.subscriptions.push(sub);
    }
  }

  _onDisconnected() {
    if (this.status !== 'disconnected') {
      this._setStatus('reconnecting');
    }
    this.subscriptions = [];
  }

  _onStompError(frame) {
    const errorMsg = frame.headers?.message || frame.body || 'Unknown STOMP error';
    console.error('[STOMP] Error:', errorMsg);

    // Stop reconnecting on auth failures — no point retrying bad credentials
    if (errorMsg.includes('login') || errorMsg.includes('passcode')) {
      this.client.deactivate();
      this._setStatus('disconnected');
    }

    if (this.onError) {
      this.onError(errorMsg);
    }
  }

  _handleMessage(topic, stompMessage) {
    const parsed = parseMessage(stompMessage.body);
    parsed.topic = topic;
    parsed.timestamp = Date.now();

    // Track signal IDs from SG_MSG messages
    if (parsed.type === 'SG_MSG' && parsed.data && parsed.data.obj_type === 'signal') {
      this.knownSignals.add(parsed.data.obj_id);
    }

    if (this.onMessage) {
      this.onMessage(parsed);
    }
  }

  sendCommand(json) {
    if (this.client && this.status === 'connected') {
      this.client.publish({
        destination: TOPICS.TD,
        body: JSON.stringify(json),
      });
    }
  }

  allSignalsToDanger() {
    const count = this.knownSignals.size;
    console.log(`[STOMP] Setting ${count} signals to danger...`);
    for (const signalId of this.knownSignals) {
      this.sendCommand({ bpull: { signal: signalId } });
    }
    return count;
  }

  _setStatus(status) {
    this.status = status;
    if (this.onStatusChange) {
      this.onStatusChange(status);
    }
  }

  getStatus() {
    return this.status;
  }
}

module.exports = StompConnectionManager;
