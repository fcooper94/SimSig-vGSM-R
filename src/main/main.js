const { app, BrowserWindow } = require('electron');
const path = require('path');

let mainWindow = null;
let msgLogWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 700,
    minHeight: 400,
    title: 'SimSig GSM-R Comms',
    backgroundColor: '#505050',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createMessageLogWindow() {
  if (msgLogWindow) {
    msgLogWindow.focus();
    return;
  }

  msgLogWindow = new BrowserWindow({
    width: 700,
    height: 500,
    minWidth: 400,
    minHeight: 300,
    title: 'Message Log - SimSig GSM-R',
    backgroundColor: '#505050',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload-msglog.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  msgLogWindow.loadFile(path.join(__dirname, '../renderer/message-log.html'));

  msgLogWindow.on('closed', () => {
    msgLogWindow = null;
  });
}

function getMessageLogWindow() {
  return msgLogWindow;
}

app.whenReady().then(() => {
  const { initSettings } = require('./settings');
  const { registerIpcHandlers } = require('./ipc-handlers');

  initSettings();
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

// Restore the Telephone Calls window to a visible position on quit
app.on('will-quit', () => {
  const { execFileSync } = require('child_process');
  const restoreScript = `
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public class WinRestore {
      [DllImport("user32.dll")]
      public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    }
"@
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $cond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ClassNameProperty, "TTelephoneForm"
    )
    # Restore Telephone Calls window
    $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
    if ($win) {
      $hwnd = [IntPtr]$win.Current.NativeWindowHandle
      # SWP_NOSIZE (0x01) | SWP_NOACTIVATE (0x10) — move to (100,100)
      [WinRestore]::SetWindowPos($hwnd, [IntPtr]::Zero, 100, 100, 0, 0, 0x0001 -bor 0x0010)
    }
    # Restore Answer Call dialog
    $aCond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ClassNameProperty, "TAnswerCallForm"
    )
    $aWin = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $aCond)
    if ($aWin) {
      $aHwnd = [IntPtr]$aWin.Current.NativeWindowHandle
      [WinRestore]::SetWindowPos($aHwnd, [IntPtr]::Zero, 150, 150, 0, 0, 0x0001 -bor 0x0010)
    }
  `;
  try {
    execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', restoreScript,
    ], { timeout: 3000 });
  } catch {}
});

module.exports = { createMessageLogWindow, getMessageLogWindow };
