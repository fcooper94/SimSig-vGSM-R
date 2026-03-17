// peer-discovery.js
// UDP broadcast-based peer discovery for player-to-player calls.
// Each vGSM-R instance broadcasts its panel name and call server port
// on the LAN so other instances can discover and call each other.
// Only works for LAN play (SimSig gateway does not relay custom messages).

const dgram = require('dgram');
const os = require('os');

const BROADCAST_PORT = 51520;
const ANNOUNCE_INTERVAL = 5000; // ms
const PEER_TIMEOUT = 15000; // consider peer gone after 15s of silence

class PeerDiscovery {
  constructor() {
    this.peers = new Map(); // id → { id, panel, host, port, calls, lastSeen }
    this.socket = null;
    this.announceTimer = null;
    this.cleanupTimer = null;
    this.panelName = '';
    this.callPort = 0;
    this.currentCalls = []; // headcodes of our current incoming calls
    this.instanceId = `${os.hostname()}-${process.pid}-${Date.now()}`;
    this.onPeersChanged = null; // callback(peers[])
  }

  start(panelName, callPort) {
    this.panelName = panelName;
    this.callPort = callPort;
    if (this.socket) this.stop();

    console.log(`[PeerDiscovery] Starting — panel="${panelName}", callPort=${callPort}, id=${this.instanceId}`);

    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.socket.on('error', (err) => {
      console.error('[PeerDiscovery] Socket error:', err.message);
    });

    this.socket.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type !== 'vgsmr-presence' || data.id === this.instanceId) return;
        console.log(`[PeerDiscovery] Received presence from "${data.panel}" at ${rinfo.address}`);
        const existed = this.peers.has(data.id);
        this.peers.set(data.id, {
          id: data.id,
          panel: data.panel,
          host: rinfo.address,
          port: data.port,
          calls: data.calls || [],
          lastSeen: Date.now(),
        });
        if (!existed) {
          console.log(`[PeerDiscovery] New peer: "${data.panel}" at ${rinfo.address}:${data.port}`);
          this._notifyChanged();
        }
      } catch {
        // ignore malformed packets
      }
    });

    this.socket.bind(BROADCAST_PORT, () => {
      this.socket.setBroadcast(true);
      const addrs = this._getBroadcastAddresses();
      console.log(`[PeerDiscovery] Listening on UDP port ${BROADCAST_PORT}, broadcasting to: ${addrs.join(', ')}`);
      this._announce();
    });

    this.announceTimer = setInterval(() => this._announce(), ANNOUNCE_INTERVAL);
    this.cleanupTimer = setInterval(() => this._cleanup(), ANNOUNCE_INTERVAL);
  }

  stop() {
    if (this.announceTimer) { clearInterval(this.announceTimer); this.announceTimer = null; }
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }
    if (this.socket) {
      try { this.socket.close(); } catch {}
      this.socket = null;
    }
    this.peers.clear();
    this._notifyChanged();
  }

  updatePanel(panelName) {
    this.panelName = panelName;
  }

  updateCalls(headcodes) {
    this.currentCalls = headcodes || [];
  }

  // Get headcodes claimed by other players
  getPeerCalls() {
    const calls = new Set();
    for (const peer of this.peers.values()) {
      if (peer.calls) {
        for (const hc of peer.calls) calls.add(hc);
      }
    }
    return calls;
  }

  getPeers() {
    return Array.from(this.peers.values()).map(({ id, panel, host, port }) => ({ id, panel, host, port }));
  }

  _announce() {
    if (!this.socket) return;
    if (!this.panelName) {
      console.log('[PeerDiscovery] Skipping announce — no panel name yet');
      return;
    }
    const msg = JSON.stringify({
      type: 'vgsmr-presence',
      id: this.instanceId,
      panel: this.panelName,
      port: this.callPort,
      calls: this.currentCalls,
    });
    const buf = Buffer.from(msg);
    const broadcastAddrs = this._getBroadcastAddresses();
    for (const addr of broadcastAddrs) {
      this.socket.send(buf, 0, buf.length, BROADCAST_PORT, addr, (err) => {
        if (err) console.error(`[PeerDiscovery] Send to ${addr} failed:`, err.message);
      });
    }
  }

  _cleanup() {
    const now = Date.now();
    let changed = false;
    for (const [id, peer] of this.peers) {
      if (now - peer.lastSeen > PEER_TIMEOUT) {
        console.log(`[PeerDiscovery] Peer expired: "${peer.panel}"`);
        this.peers.delete(id);
        changed = true;
      }
    }
    if (changed) this._notifyChanged();
  }

  _notifyChanged() {
    console.log(`[PeerDiscovery] Peers changed: ${this.peers.size} peer(s)`);
    if (this.onPeersChanged) {
      this.onPeersChanged(this.getPeers());
    }
  }

  _getBroadcastAddresses() {
    const addrs = new Set();
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          const ipParts = iface.address.split('.').map(Number);
          const maskParts = iface.netmask.split('.').map(Number);
          const broadcast = ipParts.map((ip, i) => (ip | (~maskParts[i] & 255))).join('.');
          addrs.add(broadcast);
        }
      }
    }
    if (addrs.size === 0) addrs.add('255.255.255.255');
    return Array.from(addrs);
  }
}

module.exports = PeerDiscovery;
