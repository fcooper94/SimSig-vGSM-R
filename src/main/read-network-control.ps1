# read-network-control.ps1
# Opens SimSig's Network Control Panel via menu navigation,
# reads the client list via clipboard (virtual TListBox workaround),
# then closes the dialog.

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class NetCtrl {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr SetFocus(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    public static extern int GetDlgCtrlID(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern int SendDlgItemMessage(IntPtr hDlg, int nIDDlgItem, int Msg, IntPtr wParam, IntPtr lParam);

    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const byte VK_MENU = 0x12;
    public const byte VK_CONTROL = 0x11;
    public const byte VK_RIGHT = 0x27;
    public const byte VK_DOWN = 0x28;
    public const byte VK_RETURN = 0x0D;
    public const byte VK_ESCAPE = 0x1B;
    public const byte VK_A = 0x41;
    public const byte VK_C = 0x43;
    public const byte VK_TAB = 0x09;
    public const int WM_CLOSE = 0x0010;
    public const int LB_GETCOUNT = 0x018B;
    public const int LB_GETTEXT = 0x0189;
    public const int LB_GETTEXTLEN = 0x018A;
    public const int LB_SETSEL = 0x0185;
    public const int LB_GETSELCOUNT = 0x0190;
    public const int LB_SELECTSTRING = 0x018C;
    public const int WM_SETFOCUS = 0x0007;

    public static IntPtr simsigHwnd = IntPtr.Zero;
    private static EnumWindowsProc _mainCb;

    public static void FindSimSig() {
        simsigHwnd = IntPtr.Zero;
        _mainCb = (hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            StringBuilder sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            if (sb.ToString().StartsWith("SimSig -")) {
                simsigHwnd = hWnd;
                return false;
            }
            return true;
        };
        EnumWindows(_mainCb, IntPtr.Zero);
    }

    public static void PressKey(byte vk) {
        keybd_event(vk, 0, 0, IntPtr.Zero);
        keybd_event(vk, 0, KEYEVENTF_KEYUP, IntPtr.Zero);
    }

    public static void KeyDown(byte vk) { keybd_event(vk, 0, 0, IntPtr.Zero); }
    public static void KeyUp(byte vk) { keybd_event(vk, 0, KEYEVENTF_KEYUP, IntPtr.Zero); }

    private static IntPtr _foundTitle;
    private static string _searchTitle;
    private static EnumWindowsProc _titleCb;
    public static IntPtr FindTopWindowByTitle(string title) {
        _foundTitle = IntPtr.Zero;
        _searchTitle = title;
        _titleCb = (hWnd, lParam) => {
            StringBuilder sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            if (sb.ToString() == _searchTitle) {
                _foundTitle = hWnd;
                return false;
            }
            return true;
        };
        EnumWindows(_titleCb, IntPtr.Zero);
        return _foundTitle;
    }

    private static IntPtr _foundChild;
    private static string _childClass;
    private static EnumWindowsProc _childCb;
    public static IntPtr FindChildByClass(IntPtr parent, string className) {
        _foundChild = IntPtr.Zero;
        _childClass = className;
        _childCb = (hWnd, lParam) => {
            StringBuilder sb = new StringBuilder(256);
            GetClassName(hWnd, sb, 256);
            if (sb.ToString() == _childClass) {
                _foundChild = hWnd;
                return false;
            }
            return true;
        };
        EnumChildWindows(parent, _childCb, IntPtr.Zero);
        return _foundChild;
    }

    public static void HideOffScreen(IntPtr hWnd) {
        SetWindowPos(hWnd, IntPtr.Zero, -32000, -32000, 0, 0, 0x0001 | 0x0004 | 0x0010);
    }

    public static void CloseWindow(IntPtr hWnd) {
        PostMessage(hWnd, (uint)WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
    }
}
"@

try {
    [NetCtrl]::FindSimSig()
    if ([NetCtrl]::simsigHwnd -eq [IntPtr]::Zero) {
        Write-Output '{"error":"SimSig not found"}'
        exit 0
    }

    # Bring SimSig to foreground for keyboard input
    [NetCtrl]::SetForegroundWindow([NetCtrl]::simsigHwnd) | Out-Null
    Start-Sleep -Milliseconds 300

    # Navigate menu: Alt → Right×4 to Multiplayer → Down×3 to Client Connections → Enter
    [NetCtrl]::PressKey([NetCtrl]::VK_MENU)
    Start-Sleep -Milliseconds 200
    for ($i = 0; $i -lt 4; $i++) {
        [NetCtrl]::PressKey([NetCtrl]::VK_RIGHT)
        Start-Sleep -Milliseconds 100
    }
    [NetCtrl]::PressKey([NetCtrl]::VK_DOWN)    # open submenu
    Start-Sleep -Milliseconds 100
    [NetCtrl]::PressKey([NetCtrl]::VK_DOWN)    # Send Message → Server Config
    Start-Sleep -Milliseconds 100
    [NetCtrl]::PressKey([NetCtrl]::VK_DOWN)    # Server Config → Client Connections
    Start-Sleep -Milliseconds 100
    [NetCtrl]::PressKey([NetCtrl]::VK_RETURN)  # activate
    Start-Sleep -Milliseconds 800

    # Find the dialog
    $dialogHwnd = [NetCtrl]::FindTopWindowByTitle("Network Control Panel")
    if ($dialogHwnd -eq [IntPtr]::Zero) {
        [NetCtrl]::PressKey([NetCtrl]::VK_ESCAPE)
        Write-Output '{"error":"Network Control Panel did not open. Check menu order."}'
        exit 0
    }

    # Try LB_GETCOUNT first (in case it works now that dialog is fresh)
    $listBoxHwnd = [NetCtrl]::FindChildByClass($dialogHwnd, "TListBox")
    $count = 0
    $raw = @()
    $clients = @()

    if ($listBoxHwnd -ne [IntPtr]::Zero) {
        $count = [int][NetCtrl]::SendMessage($listBoxHwnd, [NetCtrl]::LB_GETCOUNT, [IntPtr]::Zero, [IntPtr]::Zero)

        if ($count -gt 0) {
            for ($i = 0; $i -lt $count; $i++) {
                $len = [int][NetCtrl]::SendMessage($listBoxHwnd, [NetCtrl]::LB_GETTEXTLEN, [IntPtr]$i, [IntPtr]::Zero)
                if ($len -gt 0) {
                    $sb = New-Object System.Text.StringBuilder ($len + 1)
                    [NetCtrl]::SendMessage($listBoxHwnd, [NetCtrl]::LB_GETTEXT, [IntPtr]$i, $sb) | Out-Null
                    $raw += $sb.ToString()
                }
            }
        }
    }

    # If LB didn't work, try clipboard: bring dialog to front, Tab to listbox, Ctrl+A, Ctrl+C
    if ($raw.Count -eq 0 -and $listBoxHwnd -ne [IntPtr]::Zero) {
        [NetCtrl]::SetForegroundWindow($dialogHwnd) | Out-Null
        Start-Sleep -Milliseconds 200

        # Tab to focus the listbox
        [NetCtrl]::PressKey([NetCtrl]::VK_TAB)
        Start-Sleep -Milliseconds 100

        # Select all: Ctrl+A
        [NetCtrl]::KeyDown([NetCtrl]::VK_CONTROL)
        [NetCtrl]::PressKey([NetCtrl]::VK_A)
        [NetCtrl]::KeyUp([NetCtrl]::VK_CONTROL)
        Start-Sleep -Milliseconds 100

        # Copy: Ctrl+C
        [NetCtrl]::KeyDown([NetCtrl]::VK_CONTROL)
        [NetCtrl]::PressKey([NetCtrl]::VK_C)
        [NetCtrl]::KeyUp([NetCtrl]::VK_CONTROL)
        Start-Sleep -Milliseconds 200

        # Read clipboard
        Add-Type -AssemblyName System.Windows.Forms
        $clipText = [System.Windows.Forms.Clipboard]::GetText()
        if ($clipText) {
            $raw = $clipText -split "`r?`n" | Where-Object { $_.Trim() -ne "" }
        }
    }

    # Hide and close dialog
    [NetCtrl]::HideOffScreen($dialogHwnd)
    [NetCtrl]::CloseWindow($dialogHwnd)

    # Parse client entries
    foreach ($line in $raw) {
        if ($line -match "Client connection\s*\((\S+)\s*/(\S+)\)\s*from\s*(\S+):(\d+)") {
            $clients += @{
                initials = $Matches[1]
                name = $Matches[2]
                ip = $Matches[3]
                port = [int]$Matches[4]
            }
        }
    }

    $result = @{ clients = $clients; count = $count; raw = $raw; method = if ($count -gt 0) { "LB_GETTEXT" } else { "clipboard" } }
    $json = $result | ConvertTo-Json -Compress -Depth 3
    Write-Output $json
} catch {
    try { [NetCtrl]::PressKey([NetCtrl]::VK_ESCAPE) } catch {}
    $msg = $_.Exception.Message -replace '"', '\"'
    Write-Output "{`"error`":`"$msg`"}"
}
