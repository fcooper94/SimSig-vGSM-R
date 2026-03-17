// peer-discovery.js
// UDP broadcast-based peer discovery for player-to-player calls.
// Each vGSM-R instance broadcasts its panel name, call server port,
// and gateway address on the LAN. Only peers connected to the same
// SimSig Gateway are shown in the Global phonebook.

const dgram = require('dgram');
const os = require('os');

const BROADCAST_PORT = 51520;
const BROADCAST_INTERVAL = 5000; // ms
const PEER_TIMEOUT = 15000; // consider peer gone after 15s of silence

class PeerDiscovery {
  constructor() {
    this.peers = new Map(); // id → { id, panel, host, port, gateway, lastSeen }
    this.socket = null;
    this.broadcastTimer = null;
    this.cleanupTimer = null;
    this.panelName = '';
    this.callPort = 0;
    this.gateway = ''; // "host:port" of the SimSig Gateway we're connected to
    this.instanceId = `${os.hostname()}-${process.pid}-${Date.now()}`;
    this.onPeersChanged = null; // callback(peers[])
  }

  start(panelName, callPort, gatewayHost, gatewayPort) {
    this.panelName = panelName;
    this.callPort = callPort;
    this.gateway = `${gatewayHost}:${gatewayPort}`;
    if (this.socket) this.stop();

    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.socket.on('error', (err) => {
      console.error('[PeerDiscovery] Socket error:', err.message);
    });

    this.socket.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type !== 'vgsmr-presence' || data.id === this.instanceId) return;
        // Only accept peers connected to the same gateway
        if (data.gateway !== this.gateway) return;
        const existed = this.peers.has(data.id);
        this.peers.set(data.id, {
          id: data.id,
          panel: data.panel,
          host: rinfo.address,
          port: data.port,
          gateway: data.gateway,
          lastSeen: Date.now(),
        });
        if (!existed) this._notifyChanged();
      } catch {
        // ignore malformed packets
      }
    });

    this.socket.bind(BROADCAST_PORT, () => {
      this.socket.setBroadcast(true);
      console.log(`[PeerDiscovery] Listening on UDP port ${BROADCAST_PORT}, gateway=${this.gateway}`);
      this._broadcast();
    });

    this.broadcastTimer = setInterval(() => this._broadcast(), BROADCAST_INTERVAL);
    this.cleanupTimer = setInterval(() => this._cleanup(), BROADCAST_INTERVAL);
  }

  stop() {
    if (this.broadcastTimer) { clearInterval(this.broadcastTimer); this.broadcastTimer = null; }
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

  getPeers() {
    return Array.from(this.peers.values()).map(({ id, panel, host, port }) => ({ id, panel, host, port }));
  }

  _broadcast() {
    if (!this.socket || !this.panelName) return;
    const msg = JSON.stringify({
      type: 'vgsmr-presence',
      id: this.instanceId,
      panel: this.panelName,
      port: this.callPort,
      gateway: this.gateway,
    });
    const buf = Buffer.from(msg);
    // Send to broadcast address on each network interface
    const broadcastAddrs = this._getBroadcastAddresses();
    for (const addr of broadcastAddrs) {
      this.socket.send(buf, 0, buf.length, BROADCAST_PORT, addr, () => {});
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

  _getBroadcastAddresses() {
    const addrs = new Set();
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          // Calculate broadcast address from IP and netmask
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
