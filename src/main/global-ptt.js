// global-ptt.js
// Listens for the PTT key globally (even when app is not focused)
// using uiohook-napi and sends state changes to the renderer via IPC.

const { uIOhook, UiohookKey } = require('uiohook-napi');
const { BrowserWindow } = require('electron');
const channels = require('../shared/ipc-channels');

// Map DOM e.code strings → uiohook key codes
// The renderer stores keybinds as e.code values (e.g. 'Space', 'KeyA', 'F5')
const CODE_TO_UIOHOOK = {};

// Direct matches (Space, Tab, Enter, Escape, F1-F24, etc.)
for (const [name, code] of Object.entries(UiohookKey)) {
  CODE_TO_UIOHOOK[name] = code;
}

// DOM uses 'KeyA'..'KeyZ', uiohook uses 'A'..'Z'
for (let c = 65; c <= 90; c++) {
  const letter = String.fromCharCode(c);
  CODE_TO_UIOHOOK[`Key${letter}`] = UiohookKey[letter];
}

// DOM uses 'Digit0'..'Digit9', uiohook uses '0'..'9'
for (let d = 0; d <= 9; d++) {
  CODE_TO_UIOHOOK[`Digit${d}`] = UiohookKey[String(d)];
}

// Additional DOM code mappings
CODE_TO_UIOHOOK['ShiftLeft'] = UiohookKey.Shift;
CODE_TO_UIOHOOK['ShiftRight'] = UiohookKey.ShiftRight;
CODE_TO_UIOHOOK['ControlLeft'] = UiohookKey.Ctrl;
CODE_TO_UIOHOOK['ControlRight'] = UiohookKey.CtrlRight;
CODE_TO_UIOHOOK['AltLeft'] = UiohookKey.Alt;
CODE_TO_UIOHOOK['AltRight'] = UiohookKey.AltRight;
CODE_TO_UIOHOOK['MetaLeft'] = UiohookKey.Meta;
CODE_TO_UIOHOOK['MetaRight'] = UiohookKey.MetaRight;
CODE_TO_UIOHOOK['NumpadEnter'] = UiohookKey.NumpadEnter;

let currentKeyCode = null; // uiohook key code we're watching
let isDown = false;

// Answer Call / Hang Up keybinds (single-press, not hold)
let answerCallKeyCode = null;
let hangUpKeyCode = null;
let answerKeyHeld = false; // prevent repeat-firing while key is held
let hangUpKeyHeld = false;
let inCall = false; // tracks renderer call state so we only send the relevant event

// WebSocket broadcast function — set by web server when active
let wsBroadcast = null;

function setWsBroadcast(fn) {
  wsBroadcast = fn;
}

function sendPttState(active) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channels.PTT_STATE, active);
  }
  if (wsBroadcast) wsBroadcast(channels.PTT_STATE, active);
}

function sendToAllWindows(channel) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel);
  }
  if (wsBroadcast) wsBroadcast(channel);
}

function onKeyDown(e) {
  // PTT (hold-to-talk)
  if (currentKeyCode !== null && e.keycode === currentKeyCode && !isDown) {
    isDown = true;
    sendPttState(true);
  }

  // Answer Call (single press, only when not in a call, no repeats)
  if (answerCallKeyCode !== null && e.keycode === answerCallKeyCode) {
    if (!answerKeyHeld && !inCall) {
      sendToAllWindows(channels.ANSWER_CALL_KEY);
    }
    answerKeyHeld = true;
  }

  // Hang Up (single press, only when in a call, no repeats)
  if (hangUpKeyCode !== null && e.keycode === hangUpKeyCode) {
    if (!hangUpKeyHeld && inCall) {
      sendToAllWindows(channels.HANGUP_KEY);
    }
    hangUpKeyHeld = true;
  }
}

function onKeyUp(e) {
  if (currentKeyCode !== null && e.keycode === currentKeyCode && isDown) {
    isDown = false;
    sendPttState(false);
  }
  if (answerCallKeyCode !== null && e.keycode === answerCallKeyCode) {
    answerKeyHeld = false;
  }
  if (hangUpKeyCode !== null && e.keycode === hangUpKeyCode) {
    hangUpKeyHeld = false;
  }
}

function setKeybind(domCode) {
  // If key was held when changing, release it
  if (isDown) {
    isDown = false;
    sendPttState(false);
  }
  currentKeyCode = CODE_TO_UIOHOOK[domCode] ?? null;
  if (currentKeyCode === null) {
    console.warn(`[GlobalPTT] Unknown keybind code: "${domCode}"`);
  } else {
    console.log(`[GlobalPTT] Keybind set to "${domCode}" (uiohook code ${currentKeyCode})`);
  }
}

function setAnswerCallKeybind(domCode) {
  answerCallKeyCode = CODE_TO_UIOHOOK[domCode] ?? null;
  if (answerCallKeyCode === null) {
    console.warn(`[GlobalKeys] Unknown answer-call keybind code: "${domCode}"`);
  } else {
    console.log(`[GlobalKeys] Answer Call keybind set to "${domCode}" (uiohook code ${answerCallKeyCode})`);
  }
}

function setHangUpKeybind(domCode) {
  hangUpKeyCode = CODE_TO_UIOHOOK[domCode] ?? null;
  if (hangUpKeyCode === null) {
    console.warn(`[GlobalKeys] Unknown hang-up keybind code: "${domCode}"`);
  } else {
    console.log(`[GlobalKeys] Hang Up keybind set to "${domCode}" (uiohook code ${hangUpKeyCode})`);
  }
}

function start(initialKeybinds) {
  setKeybind(initialKeybinds.ptt || 'ControlLeft');
  setAnswerCallKeybind(initialKeybinds.answerCall || 'Space');
  setHangUpKeybind(initialKeybinds.hangUp || 'Space');
  uIOhook.on('keydown', onKeyDown);
  uIOhook.on('keyup', onKeyUp);
  uIOhook.start();
  console.log('[GlobalPTT] Global keyboard hook started');
}

function stop() {
  uIOhook.stop();
  if (isDown) {
    isDown = false;
    sendPttState(false);
  }
  console.log('[GlobalPTT] Global keyboard hook stopped');
}

function setInCall(state) {
  inCall = state;
}

module.exports = { start, stop, setKeybind, setAnswerCallKeybind, setHangUpKeybind, setInCall, setWsBroadcast };
