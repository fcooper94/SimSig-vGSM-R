// peer-discovery.js
// Peer discovery for player-to-player calls via the SimSig Gateway's
// STOMP broker. Each vGSM-R instance publishes presence messages to a
// custom topic so all players in the same game session can see each other.

const os = require('os');

const PRESENCE_TOPIC = '/topic/vGSMR';
const ANNOUNCE_INTERVAL = 5000; // ms
const PEER_TIMEOUT = 15000; // consider peer gone after 15s of silence

class PeerDiscovery {
  constructor() {
    this.peers = new Map(); // id → { id, panel, host, port, lastSeen }
    this.announceTimer = null;
    this.cleanupTimer = null;
    this.panelName = '';
    this.callPort = 0;
    this.stompClient = null; // reference to the STOMP Client instance
    this.subscription = null;
    this.instanceId = `${os.hostname()}-${process.pid}-${Date.now()}`;
    this.onPeersChanged = null; // callback(peers[])
  }

  /**
   * Start announcing presence and listening for peers.
   * @param {string} panelName - this instance's panel name
   * @param {number} callPort - WebSocket port for incoming player calls
   * @param {object} stompClient - the @stomp/stompjs Client instance (already connected)
   */
  start(panelName, callPort, stompClient) {
    this.panelName = panelName;
    this.callPort = callPort;
    this.stompClient = stompClient;
    if (this.subscription) this.stop();

    // Resolve our LAN IP so peers know where to connect for calls
    this._localIp = this._getLocalIp();

    // Subscribe to the vGSMR presence topic
    try {
      this.subscription = this.stompClient.subscribe(PRESENCE_TOPIC, (message) => {
        this._handleMessage(message);
      }, { ack: 'auto' });
      console.log(`[PeerDiscovery] Subscribed to ${PRESENCE_TOPIC}`);
    } catch (err) {
      console.error('[PeerDiscovery] Failed to subscribe:', err.message);
      return;
    }

    // Start announcing and cleaning up
    this._announce();
    this.announceTimer = setInterval(() => this._announce(), ANNOUNCE_INTERVAL);
    this.cleanupTimer = setInterval(() => this._cleanup(), ANNOUNCE_INTERVAL);
  }

  stop() {
    if (this.announceTimer) { clearInterval(this.announceTimer); this.announceTimer = null; }
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }
    if (this.subscription) {
      try { this.subscription.unsubscribe(); } catch {}
      this.subscription = null;
    }
    this.stompClient = null;
    this.peers.clear();
    this._notifyChanged();
  }

  updatePanel(panelName) {
    this.panelName = panelName;
  }

  getPeers() {
    return Array.from(this.peers.values()).map(({ id, panel, host, port }) => ({ id, panel, host, port }));
  }

  _announce() {
    if (!this.stompClient || !this.panelName) return;
    try {
      this.stompClient.publish({
        destination: PRESENCE_TOPIC,
        body: JSON.stringify({
          type: 'vgsmr-presence',
          id: this.instanceId,
          panel: this.panelName,
          host: this._localIp,
          port: this.callPort,
        }),
      });
    } catch (err) {
      console.error('[PeerDiscovery] Announce failed:', err.message);
    }
  }

  _handleMessage(stompMessage) {
    try {
      const data = JSON.parse(stompMessage.body);
      if (data.type !== 'vgsmr-presence' || data.id === this.instanceId) return;
      const existed = this.peers.has(data.id);
      this.peers.set(data.id, {
        id: data.id,
        panel: data.panel,
        host: data.host,
        port: data.port,
        lastSeen: Date.now(),
      });
      if (!existed) this._notifyChanged();
    } catch {
      // ignore non-presence messages on this topic
    }
  }

  _cleanup() {
    const now = Date.now();
    let changed = false;
    for (const [id, peer] of this.peers) {
      if (now - peer.lastSeen > PEER_TIMEOUT) {
        this.peers.delete(id);
        changed = true;
      }
    }
    if (changed) this._notifyChanged();
  }

  _notifyChanged() {
    if (this.onPeersChanged) {
      this.onPeersChanged(this.getPeers());
    }
  }

  _getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    return '127.0.0.1';
  }
}

module.exports = PeerDiscovery;
