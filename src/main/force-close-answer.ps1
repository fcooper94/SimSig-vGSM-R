# Force-dismiss a stale TAnswerCallForm using UI Automation InvokePattern
Add-Type -AssemblyName UIAutomationClient | Out-Null
Add-Type -AssemblyName UIAutomationTypes | Out-Null

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class ForceDismiss {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
    public const int LB_SETCURSEL = 0x0186;
    public static void SelectItem(IntPtr hWnd, int index) {
        SendMessage(hWnd, LB_SETCURSEL, (IntPtr)index, IntPtr.Zero);
    }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);
    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int cmd);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;

    public static void ClickAt(int x, int y) {
        SetCursorPos(x, y);
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, IntPtr.Zero);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, IntPtr.Zero);
    }
}
"@

# Save cursor position so we can restore it after physical click
$savedCursor = New-Object ForceDismiss+POINT
[ForceDismiss]::GetCursorPos([ref]$savedCursor) | Out-Null

$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty, "TAnswerCallForm"
)
$dialog = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)

if ($null -eq $dialog) {
    Write-Host "No TAnswerCallForm found"
    exit 0
}

Write-Host "Found: $($dialog.Current.Name)"
$dialogHwnd = [IntPtr]$dialog.Current.NativeWindowHandle

# Make sure dialog is visible and foreground
[ForceDismiss]::ShowWindow($dialogHwnd, 9) | Out-Null
[ForceDismiss]::SetForegroundWindow($dialogHwnd) | Out-Null
Start-Sleep -Milliseconds 300

# Find TListBox and select first item
$lbCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty, "TListBox"
)
$lb = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $lbCond)
if ($null -ne $lb) {
    $lbHwnd = [IntPtr]$lb.Current.NativeWindowHandle
    [ForceDismiss]::SelectItem($lbHwnd, 0)
    Write-Host "Selected item 0"
}

# Find Reply button and physically click it
$btnCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, "Reply"
)
$replyBtn = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
if ($null -ne $replyBtn) {
    $btnHwnd = [IntPtr]$replyBtn.Current.NativeWindowHandle
    $rect = New-Object ForceDismiss+RECT
    [ForceDismiss]::GetWindowRect($btnHwnd, [ref]$rect) | Out-Null
    $cx = [int](($rect.Left + $rect.Right) / 2)
    $cy = [int](($rect.Top + $rect.Bottom) / 2)
    Write-Host "Clicking Reply button at ($cx, $cy)"
    [ForceDismiss]::ClickAt($cx, $cy)
} else {
    Write-Host "Reply button not found"
}

# Restore cursor to original position
[ForceDismiss]::SetCursorPos($savedCursor.X, $savedCursor.Y) | Out-Null

Write-Host "Done"
