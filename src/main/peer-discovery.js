// peer-discovery.js
// Peer discovery for player-to-player calls via the SimSig Gateway.
// The gateway only relays messages on its built-in topics, so we
// publish presence as a JSON object with a "vgsmr_presence" key to
// /topic/TD_ALL_SIG_AREA. SimSig ignores unknown keys, but other
// vGSM-R instances will recognise and extract them.

const os = require('os');
const { TOPICS } = require('../shared/constants');

const ANNOUNCE_INTERVAL = 5000; // ms
const PEER_TIMEOUT = 15000; // consider peer gone after 15s of silence

class PeerDiscovery {
  constructor() {
    this.peers = new Map(); // id → { id, panel, host, port, lastSeen }
    this.announceTimer = null;
    this.cleanupTimer = null;
    this.panelName = '';
    this.callPort = 0;
    this.stompClient = null; // reference to the @stomp/stompjs Client instance
    this.instanceId = `${os.hostname()}-${process.pid}-${Date.now()}`;
    this.onPeersChanged = null; // callback(peers[])
  }

  /**
   * Start announcing presence.
   * Incoming messages are fed in externally via handleMessage() from the
   * existing STOMP onMessage handler — no separate subscription needed.
   */
  start(panelName, callPort, stompClient) {
    this.panelName = panelName;
    this.callPort = callPort;
    this.stompClient = stompClient;

    this._localIp = this._getLocalIp();
    console.log(`[PeerDiscovery] Starting — panel="${panelName}", ip=${this._localIp}, callPort=${callPort}`);

    // Start announcing and cleaning up
    this._announce();
    this.announceTimer = setInterval(() => this._announce(), ANNOUNCE_INTERVAL);
    this.cleanupTimer = setInterval(() => this._cleanup(), ANNOUNCE_INTERVAL);
  }

  stop() {
    if (this.announceTimer) { clearInterval(this.announceTimer); this.announceTimer = null; }
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }
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

  /**
   * Call this from the existing STOMP onMessage handler for every TD message.
   * If the message contains a vgsmr_presence key, it's a peer announcement.
   * Returns true if the message was a presence message (so the caller can
   * skip normal processing if desired).
   */
  handleMessage(parsed) {
    const presence = parsed?.data?.vgsmr_presence || parsed?.vgsmr_presence;
    if (!presence) return false;

    console.log(`[PeerDiscovery] Received presence: panel="${presence.panel}", id=${presence.id}`);

    if (presence.id === this.instanceId) return true; // own message

    const existed = this.peers.has(presence.id);
    this.peers.set(presence.id, {
      id: presence.id,
      panel: presence.panel,
      host: presence.host,
      port: presence.port,
      lastSeen: Date.now(),
    });
    if (!existed) {
      console.log(`[PeerDiscovery] New peer: "${presence.panel}" at ${presence.host}:${presence.port}`);
      this._notifyChanged();
    }
    return true;
  }

  _announce() {
    if (!this.stompClient) return;
    if (!this.panelName) {
      console.log('[PeerDiscovery] Skipping announce — no panel name yet');
      return;
    }
    try {
      this.stompClient.publish({
        destination: TOPICS.TD,
        body: JSON.stringify({
          vgsmr_presence: {
            id: this.instanceId,
            panel: this.panelName,
            host: this._localIp,
            port: this.callPort,
          },
        }),
      });
    } catch (err) {
      console.error('[PeerDiscovery] Announce failed:', err.message);
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
