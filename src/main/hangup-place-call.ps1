# hangup-place-call.ps1
# Clicks "Hang up and close" on SimSig's Place Call dialog.

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class PlaceCallHangup {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    public const int BM_CLICK = 0x00F5;

    public static void ClickButton(IntPtr hWnd) {
        SendMessage(hWnd, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
    }

    public static void HideOffScreen(IntPtr hWnd) {
        SetWindowPos(hWnd, IntPtr.Zero, -32000, -32000, 0, 0, 0x0001 | 0x0004 | 0x0010);
    }

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumCb callback, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr parent, EnumCb callback, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int maxLength);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder className, int maxLength);
    public delegate bool EnumCb(IntPtr hWnd, IntPtr lParam);

    public static IntPtr FindWindowByTitle(string title) {
        IntPtr result = IntPtr.Zero;
        EnumWindows((hWnd, lParam) => {
            var sb = new System.Text.StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            if (sb.ToString() == title) {
                result = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    public static IntPtr FindButtonByText(IntPtr parent, string text) {
        IntPtr result = IntPtr.Zero;
        EnumChildWindows(parent, (hWnd, lParam) => {
            var sb = new System.Text.StringBuilder(256);
            GetClassName(hWnd, sb, 256);
            string cls = sb.ToString();
            if (cls == "TButton" || cls == "Button") {
                sb.Clear();
                GetWindowText(hWnd, sb, 256);
                if (sb.ToString() == text) {
                    result = hWnd;
                    return false;
                }
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
"@

try {
    # Find the "Place Call" dialog by title using Win32 EnumWindows
    $dialogHwnd = [PlaceCallHangup]::FindWindowByTitle("Place Call")

    if ($dialogHwnd -eq [IntPtr]::Zero) {
        Write-Output '{"success":true,"note":"dialog already closed"}'
        exit 0
    }

    # Hide off-screen immediately in case it's visible
    [PlaceCallHangup]::HideOffScreen($dialogHwnd)

    # Find and click "Hang up and close" button using Win32 EnumChildWindows
    $btnHwnd = [PlaceCallHangup]::FindButtonByText($dialogHwnd, "Hang up and close")

    if ($btnHwnd -ne [IntPtr]::Zero) {
        [PlaceCallHangup]::ClickButton($btnHwnd)
        Write-Output '{"success":true}'
    } else {
        Write-Output '{"error":"Hang up and close button not found"}'
    }
} catch {
    Write-Output "{`"error`":`"$($_.Exception.Message)`"}"
}
