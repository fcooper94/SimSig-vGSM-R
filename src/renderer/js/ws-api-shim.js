// ws-api-shim.js
// Browser-side shim that replicates window.simsigAPI over WebSocket.
// Only activates when NOT running inside Electron (no preload).
// Loaded before app.js — if window.simsigAPI already exists (Electron), this is a no-op.

(function () {
  'use strict';

  if (window.simsigAPI) return; // Running in Electron — preload already set up the API

  // Hide the fullscreen button — not useful on browser/iPad
  document.addEventListener('DOMContentLoaded', () => {
    const fsBtn = document.getElementById('fullscreen-btn');
    if (fsBtn) fsBtn.style.display = 'none';
  });

  // Confirm before closing/navigating away on browser
  window.addEventListener('beforeunload', (e) => {
    e.preventDefault();
  });

  const listeners = {}; // channel → [callback, ...]
  const buffered = {};  // channel → [data, ...] — events received before any listener registered
  const pending = {};   // id → { resolve, reject }
  let nextId = 1;
  let ws = null;
  let connected = false;
  let reconnectTimer = null;
  let hostClosed = false;
  let readOnly = false;

  function showStatusOverlay(title, subtitle) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:99999;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;pointer-events:all;';
    const text = document.createElement('div');
    text.style.cssText = 'font-size:28px;color:#fff;letter-spacing:2px;text-align:center;user-select:none;';
    text.textContent = title;
    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:14px;color:#aaa;text-align:center;user-select:none;';
    sub.textContent = subtitle;
    overlay.appendChild(text);
    overlay.appendChild(sub);
    document.body.appendChild(overlay);
  }

  function showHostClosed() {
    hostClosed = true;
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:99999;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;pointer-events:all;';
    const text = document.createElement('div');
    text.style.cssText = 'font-size:28px;color:#fff;letter-spacing:2px;text-align:center;user-select:none;';
    text.textContent = 'Host App Closed';
    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:14px;color:#aaa;text-align:center;user-select:none;';
    sub.textContent = 'The SimSig VGSM-R application on the PC has been closed.';
    const btn = document.createElement('button');
    btn.textContent = 'Reconnect';
    btn.style.cssText = 'margin-top:8px;padding:10px 32px;font-size:16px;border:none;border-radius:6px;background:#4a9eff;color:#fff;cursor:pointer;';
    btn.addEventListener('click', () => {
      location.reload();
    });
    overlay.appendChild(text);
    overlay.appendChild(sub);
    overlay.appendChild(btn);
    document.body.appendChild(overlay);
  }

  function showReadOnly() {
    readOnly = true;
    // Full-page diagonal watermark
    const watermark = document.createElement('div');
    watermark.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;pointer-events:none;overflow:hidden;';
    const label = document.createElement('div');
    label.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-35deg);font-size:min(22vw,160px);font-weight:900;color:rgba(255,255,255,0.4);letter-spacing:16px;text-transform:uppercase;white-space:nowrap;user-select:none;text-shadow:0 0 30px rgba(255,255,255,0.15);';
    label.textContent = 'READ ONLY';
    watermark.appendChild(label);
    document.body.appendChild(watermark);
    // Intercept settings button — show message instead of opening settings
    var settingsBtn = document.getElementById('settings-toolbar-btn');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', function (e) {
        e.stopImmediatePropagation();
        var modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:100000;display:flex;align-items:center;justify-content:center;';
        var box = document.createElement('div');
        box.style.cssText = 'background:#2a2a2a;color:#fff;padding:24px 32px;border-radius:8px;text-align:center;max-width:320px;';
        box.innerHTML = '<div style="font-size:18px;margin-bottom:8px;">Settings Unavailable</div><div style="font-size:14px;color:#aaa;">Settings can only be changed on the host PC.</div>';
        var okBtn = document.createElement('button');
        okBtn.textContent = 'OK';
        okBtn.style.cssText = 'margin-top:16px;padding:8px 24px;border:none;border-radius:4px;background:#4a9eff;color:#fff;cursor:pointer;font-size:14px;';
        okBtn.addEventListener('click', function () { modal.remove(); });
        box.appendChild(okBtn);
        modal.appendChild(box);
        modal.addEventListener('click', function (e) { if (e.target === modal) modal.remove(); });
        document.body.appendChild(modal);
      }, true);
    }
  }

  function connect() {
    if (hostClosed) return; // Don't reconnect after host closed

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}`);

    ws.onopen = () => {
      connected = true;
      console.log('[WS-Shim] Connected to server');
    };

    ws.onclose = (event) => {
      connected = false;
      // Code 4000 = host app shut down — stop reconnecting
      if (event.code === 4000) {
        showHostClosed();
        return;
      }
      if (hostClosed || readOnly) return; // Don't reconnect
      console.log('[WS-Shim] Disconnected, reconnecting...');
      reconnectTimer = setTimeout(connect, 2000);
    };

    ws.onerror = () => {}; // onclose will handle reconnect

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      // Host app is closing
      if (msg.type === 'host-closed') {
        showHostClosed();
        return;
      }

      // Role assignment — read-only if another client already connected
      if (msg.type === 'role') {
        if (msg.role === 'readonly') {
          showReadOnly();
        }
        return;
      }

      // Response to an invoke call
      if (msg.id != null && pending[msg.id]) {
        const { resolve } = pending[msg.id];
        delete pending[msg.id];
        resolve(msg.result);
        return;
      }

      // Push event from server
      if (msg.type === 'event' && msg.channel) {
        const cbs = listeners[msg.channel];
        if (cbs && cbs.length > 0) {
          for (const cb of cbs) {
            try { cb(msg.data); } catch (e) { console.error('[WS-Shim] Listener error:', e); }
          }
        } else {
          // No listeners yet — buffer so we can replay when on() is called
          if (!buffered[msg.channel]) buffered[msg.channel] = [];
          buffered[msg.channel].push(msg.data);
        }
      }
    };
  }

  function invoke(channel, ...args) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }
      const id = nextId++;
      pending[id] = { resolve, reject };
      ws.send(JSON.stringify({ type: 'invoke', id, channel, args }));
      // Timeout after 60s
      setTimeout(() => {
        if (pending[id]) {
          delete pending[id];
          reject(new Error('Invoke timeout: ' + channel));
        }
      }, 60000);
    });
  }

  function on(channel, callback) {
    if (!listeners[channel]) listeners[channel] = [];
    listeners[channel].push(callback);
    // Replay any events that arrived before this listener was registered
    if (buffered[channel]) {
      const queued = buffered[channel];
      delete buffered[channel];
      for (const data of queued) {
        try { callback(data); } catch (e) { console.error('[WS-Shim] Buffered listener error:', e); }
      }
    }
    return () => {
      const arr = listeners[channel];
      if (arr) {
        const idx = arr.indexOf(callback);
        if (idx >= 0) arr.splice(idx, 1);
      }
    };
  }

  // Build the same window.simsigAPI interface as the Electron preload
  window.simsigAPI = {
    _isBrowser: true, // Flag so renderer code can detect browser mirror mode
    settings: {
      get: (key) => invoke('settings:get', key),
      set: (key, value) => invoke('settings:set', key, value),
      getAll: () => invoke('settings:get-all'),
    },

    connection: {
      connect: () => invoke('connection:connect'),
      disconnect: () => invoke('connection:disconnect'),
      onStatusChange: (cb) => on('connection:status-changed', cb),
    },

    messages: {
      onMessage: (cb) => on('message:received', cb),
    },

    commands: {
      allSignalsToDanger: () => invoke('cmd:all-signals-danger'),
      openMessageLog: () => {}, // No-op in browser (Electron-only feature)
    },

    clock: {
      onUpdate: (cb) => on('clock:update', cb),
    },

    sim: {
      onName: (cb) => on('sim:name', cb),
      onReady: (cb) => on('init:ready', cb),
    },

    phone: {
      onCallsUpdate: (cb) => on('phone:calls-update', cb),
      answerCall: (index, train) => invoke('phone:answer-call', index, train),
      replyCall: (replyIndex, headCode) => invoke('phone:reply-call', replyIndex, headCode),
      readPhoneBook: () => invoke('phone:book-read'),
      dialPhoneBook: (index) => invoke('phone:book-dial', index),
      placeCallStatus: (contactName) => invoke('phone:place-call-status', contactName),
      placeCallReply: (replyIndex, headCode, param2, contactName) => invoke('phone:place-call-reply', replyIndex, headCode, param2, contactName),
      placeCallHangup: () => invoke('phone:place-call-hangup'),
      hideAnswerDialog: () => invoke('phone:hide-answer'),
      silenceRing: () => invoke('phone:silence-ring'),
      onSilenceRing: (cb) => on('phone:silence-ring', cb),
      notifyCallAnswered: (train) => invoke('phone:call-answered', train),
      onCallAnswered: (cb) => on('phone:call-answered', cb),
      onDriverHungUp: (cb) => on('phone:driver-hung-up', cb),
      chatSync: (state) => invoke('phone:chat-sync', state),
      onChatSync: (cb) => on('phone:chat-sync', cb),
      remoteAction: (action) => invoke('phone:remote-action', action),
      onRemoteAction: (cb) => on('phone:remote-action', cb),
    },

    tts: {
      getVoices: () => invoke('tts:get-voices'),
      speak: (text, voiceId) => invoke('tts:speak', text, voiceId),
      checkCredits: (apiKey) => invoke('tts:check-credits', apiKey),
    },

    ptt: {
      onStateChange: (cb) => on('ptt:state-changed', cb),
      setKeybind: (code) => invoke('ptt:set-keybind', code),
    },

    keys: {
      onAnswerCall: (cb) => on('keys:answer-call', cb),
      onHangUp: (cb) => on('keys:hangup', cb),
      setAnswerCallKeybind: (code) => invoke('keys:answer-call-set-keybind', code),
      setHangUpKeybind: (code) => invoke('keys:hangup-set-keybind', code),
      setInCall: (state) => invoke('keys:phone-in-call', state),
    },

    stt: {
      transcribe: (audioData) => invoke('stt:transcribe', audioData),
    },

    window: {
      toggleFullscreen: () => {
        // Use browser Fullscreen API instead of Electron
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else {
          document.documentElement.requestFullscreen();
        }
      },
    },

    // No web server control from browser clients
  };

  // Connect immediately — events arriving before listeners are buffered and replayed
  connect();
})();
