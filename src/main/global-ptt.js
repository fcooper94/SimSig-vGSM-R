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

function sendPttState(active) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channels.PTT_STATE, active);
  }
}

function onKeyDown(e) {
  if (currentKeyCode !== null && e.keycode === currentKeyCode && !isDown) {
    isDown = true;
    sendPttState(true);
  }
}

function onKeyUp(e) {
  if (currentKeyCode !== null && e.keycode === currentKeyCode && isDown) {
    isDown = false;
    sendPttState(false);
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

function start(initialKeybind) {
  setKeybind(initialKeybind || 'Space');
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

module.exports = { start, stop, setKeybind };
