# hangup-place-call.ps1
# Clicks "Hang up and close" on SimSig's Place Call dialog.

Add-Type -AssemblyName UIAutomationClient | Out-Null
Add-Type -AssemblyName UIAutomationTypes | Out-Null

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
}
"@

try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement

    $nameCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        "Place Call"
    )
    $dialog = $root.FindFirst(
        [System.Windows.Automation.TreeScope]::Children,
        $nameCond
    )

    if ($null -eq $dialog) {
        Write-Output '{"success":true,"note":"dialog already closed"}'
        exit 0
    }

    # Hide off-screen immediately in case it's visible
    $dialogHwnd = [IntPtr]$dialog.Current.NativeWindowHandle
    if ($dialogHwnd -ne [IntPtr]::Zero) {
        [PlaceCallHangup]::HideOffScreen($dialogHwnd)
    }

    # Find and click "Hang up and close" button
    $btnCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        "Hang up and close"
    )
    $btn = $dialog.FindFirst(
        [System.Windows.Automation.TreeScope]::Descendants,
        $btnCond
    )

    if ($null -ne $btn) {
        $btnHwnd = [IntPtr]$btn.Current.NativeWindowHandle
        [PlaceCallHangup]::ClickButton($btnHwnd)
        Write-Output '{"success":true}'
    } else {
        Write-Output '{"error":"Hang up and close button not found"}'
    }
} catch {
    Write-Output "{`"error`":`"$($_.Exception.Message)`"}"
}
