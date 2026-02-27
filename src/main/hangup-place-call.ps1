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

    public const int BM_CLICK = 0x00F5;

    public static void ClickButton(IntPtr hWnd) {
        SendMessage(hWnd, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
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
