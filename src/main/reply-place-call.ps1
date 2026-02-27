# reply-place-call.ps1
# NEW APPROACH: Physical mouse/keyboard simulation (not Win32 messages).
# Brings dialog to foreground, uses SetFocus + keybd_event to select the
# ComboBox item, then physically clicks "Send request/message" via mouse_event.
#
# Usage: powershell -File reply-place-call.ps1 -ReplyIndex 0

param(
    [int]$ReplyIndex = 0
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class PlaceCallClick {
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumCallback callback, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr parent, EnumCallback callback, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxLength);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxLength);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    // Thread input attachment for cross-process SetFocus
    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    public static extern IntPtr SetFocus(IntPtr hWnd);

    public delegate bool EnumCallback(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP   = 0x0004;
    public const uint KEYEVENTF_KEYUP      = 0x0002;
    public const byte VK_DOWN    = 0x28;
    public const byte VK_HOME    = 0x24;
    public const int  CB_GETCOUNT = 0x0146;
    public const int  SW_RESTORE  = 9;

    public static void ClickAt(int x, int y) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(50);
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(30);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, IntPtr.Zero);
    }

    public static void PressKey(byte vk) {
        keybd_event(vk, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(30);
        keybd_event(vk, 0, KEYEVENTF_KEYUP, IntPtr.Zero);
    }

    public static int GetComboCount(IntPtr hWnd) {
        return (int)SendMessage(hWnd, CB_GETCOUNT, IntPtr.Zero, IntPtr.Zero);
    }

    public static void HideOffScreen(IntPtr hWnd) {
        SetWindowPos(hWnd, IntPtr.Zero, -32000, -32000, 0, 0, 0x0001 | 0x0004 | 0x0010);
    }

    public static IntPtr FindWindowByTitle(string title) {
        IntPtr result = IntPtr.Zero;
        EnumWindows((hWnd, lParam) => {
            var sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            if (sb.ToString() == title) { result = hWnd; return false; }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    // Find the reply ComboBox (the one with fewest items > 0)
    public static IntPtr FindReplyCombo(IntPtr parent) {
        IntPtr result = IntPtr.Zero;
        int minCount = int.MaxValue;
        EnumChildWindows(parent, (hWnd, lParam) => {
            var sb = new StringBuilder(256);
            GetClassName(hWnd, sb, 256);
            if (sb.ToString() == "TComboBox") {
                int cnt = GetComboCount(hWnd);
                if (cnt > 0 && cnt < minCount) {
                    minCount = cnt;
                    result = hWnd;
                }
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    public static IntPtr FindButtonByText(IntPtr parent, string text) {
        IntPtr result = IntPtr.Zero;
        EnumChildWindows(parent, (hWnd, lParam) => {
            var sb = new StringBuilder(256);
            GetClassName(hWnd, sb, 256);
            if (sb.ToString() == "TButton") {
                sb.Clear();
                GetWindowText(hWnd, sb, 256);
                if (sb.ToString() == text) { result = hWnd; return false; }
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    // Cross-process SetFocus via thread input attachment
    public static void FocusControl(IntPtr dialogHwnd, IntPtr controlHwnd) {
        uint pid;
        uint targetThread = GetWindowThreadProcessId(dialogHwnd, out pid);
        uint ourThread = GetCurrentThreadId();
        AttachThreadInput(ourThread, targetThread, true);
        SetFocus(controlHwnd);
        AttachThreadInput(ourThread, targetThread, false);
    }
}
"@

try {
    $hwnd = [PlaceCallClick]::FindWindowByTitle("Place Call")
    if ($hwnd -eq [IntPtr]::Zero) {
        Write-Output '{"error":"Place Call dialog not found"}'
        exit 0
    }

    # Bring dialog on-screen and to foreground
    [PlaceCallClick]::ShowWindow($hwnd, 9) | Out-Null
    [PlaceCallClick]::SetForegroundWindow($hwnd) | Out-Null
    Start-Sleep -Milliseconds 300

    # Find the reply ComboBox
    $comboHwnd = [PlaceCallClick]::FindReplyCombo($hwnd)
    if ($comboHwnd -eq [IntPtr]::Zero) {
        [PlaceCallClick]::HideOffScreen($hwnd)
        Write-Output '{"error":"Reply ComboBox not found"}'
        exit 0
    }

    # Focus the ComboBox and press Home then Down to ensure item 0 is selected.
    # This uses keyboard input (natural user path), not CB_SETCURSEL (crashes Delphi).
    [PlaceCallClick]::FocusControl($hwnd, $comboHwnd)
    Start-Sleep -Milliseconds 100
    [PlaceCallClick]::PressKey([PlaceCallClick]::VK_HOME)
    Start-Sleep -Milliseconds 100

    # Find Send button and physically click it
    $sendBtn = [PlaceCallClick]::FindButtonByText($hwnd, "Send request/message")
    if ($sendBtn -eq [IntPtr]::Zero) {
        [PlaceCallClick]::HideOffScreen($hwnd)
        Write-Output '{"error":"Send button not found"}'
        exit 0
    }

    $rect = New-Object PlaceCallClick+RECT
    [PlaceCallClick]::GetWindowRect($sendBtn, [ref]$rect) | Out-Null
    $cx = [int](($rect.Left + $rect.Right) / 2)
    $cy = [int](($rect.Top + $rect.Bottom) / 2)
    [PlaceCallClick]::ClickAt($cx, $cy)

    Start-Sleep -Milliseconds 300
    [PlaceCallClick]::HideOffScreen($hwnd)

    Write-Output '{"success":true}'
} catch {
    Write-Output "{`"error`":`"$($_.Exception.Message)`"}"
}
