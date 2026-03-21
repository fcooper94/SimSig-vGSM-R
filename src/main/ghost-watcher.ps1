# ghost-watcher.ps1 — Background process that watches for incoming SimSig calls
# Launched by restore-telephone.ps1 when no calls are outstanding at app exit.
#
# Purpose: The stale TAnswerCallForm is minimized on exit. When the user answers
# their next call in SimSig, this watcher detects it and restores the form so
# SimSig can display the call details. Once restored, the watcher exits.
#
# Timeout: exits after 30 minutes if no call is answered (SimSig session likely ended).

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class GhostWatch {
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumCb cb, IntPtr lp);
    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr parent, EnumCb cb, IntPtr lp);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")]
    public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll")]
    public static extern bool GetMonitorInfo(IntPtr hMon, ref MONITORINFO mi);

    public delegate bool EnumCb(IntPtr h, IntPtr l);
    public const int LB_GETCOUNT = 0x018B;

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    public static IntPtr FindByClass(string cls) {
        IntPtr result = IntPtr.Zero;
        EnumWindows((h, l) => {
            var sb = new StringBuilder(256);
            GetClassName(h, sb, 256);
            if (sb.ToString() == cls) { result = h; return false; }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    public static IntPtr FindChildByClass(IntPtr parent, string cls) {
        IntPtr result = IntPtr.Zero;
        EnumChildWindows(parent, (h, l) => {
            var sb = new StringBuilder(256);
            GetClassName(h, sb, 256);
            if (sb.ToString() == cls) { result = h; return false; }
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
"@

$TIMEOUT_MINUTES = 30
$POLL_MS = 1000
$startTime = Get-Date
$logFile = Join-Path $PSScriptRoot "ghost-watcher-log.txt"
$log = @()
$log += "Ghost watcher started at $(Get-Date)"

# Find the SimSig main window to determine monitor center for restore position
$simsigHwnd = [GhostWatch]::FindByClass("TMDIMainForm")
$restoreX = 500
$restoreY = 300
if ($simsigHwnd -ne [IntPtr]::Zero) {
    $monitor = [GhostWatch]::MonitorFromWindow($simsigHwnd, 1)
    $mi = New-Object GhostWatch+MONITORINFO
    $mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($mi)
    if ([GhostWatch]::GetMonitorInfo($monitor, [ref]$mi)) {
        $restoreX = [int](($mi.rcWork.Left + $mi.rcWork.Right) / 2) - 200
        $restoreY = [int](($mi.rcWork.Top + $mi.rcWork.Bottom) / 2) - 150
    }
}

# Capture the current (stale) title of TAnswerCallForm
$answerHwnd = [GhostWatch]::FindByClass("TAnswerCallForm")
$staleTitle = ""
if ($answerHwnd -ne [IntPtr]::Zero) {
    $sb = New-Object System.Text.StringBuilder 256
    [GhostWatch]::GetWindowText($answerHwnd, $sb, 256)
    $staleTitle = $sb.ToString()
    $log += "Stale title: '$staleTitle'"
} else {
    $log += "TAnswerCallForm not found - exiting"
    $log | Out-File -FilePath $logFile -Encoding utf8
    exit
}

# Poll loop: watch for the TAnswerCallForm title to change
# When the user clicks "Answer call", SimSig updates the title to the new call
while ($true) {
    $elapsed = (Get-Date) - $startTime
    if ($elapsed.TotalMinutes -ge $TIMEOUT_MINUTES) { $log += "Timed out"; break }

    # Check if SimSig is still running
    $simsig = [GhostWatch]::FindByClass("TMDIMainForm")
    if ($simsig -eq [IntPtr]::Zero) { $log += "SimSig closed"; break }

    # Check TAnswerCallForm title
    $answerHwnd = [GhostWatch]::FindByClass("TAnswerCallForm")
    if ($answerHwnd -eq [IntPtr]::Zero) { $log += "TAnswerCallForm gone"; break }

    $sb = New-Object System.Text.StringBuilder 256
    [GhostWatch]::GetWindowText($answerHwnd, $sb, 256)
    $currentTitle = $sb.ToString()

    if ($currentTitle -ne $staleTitle -and $currentTitle -ne "") {
        # Title changed - user answered a new call, restore the form
        $log += "Title changed to: '$currentTitle' - restoring at ($restoreX, $restoreY)"
        [GhostWatch]::ShowWindow($answerHwnd, 9) | Out-Null
        [GhostWatch]::SetWindowPos($answerHwnd, [IntPtr]::Zero, $restoreX, $restoreY, 0, 0, 0x0001 -bor 0x0040) | Out-Null
        [GhostWatch]::SetForegroundWindow($answerHwnd) | Out-Null
        $log += "Restored"
        $log | Out-File -FilePath $logFile -Encoding utf8
        break
    }

    Start-Sleep -Milliseconds $POLL_MS
}

$log += "Exited at $(Get-Date)"
$log | Out-File -FilePath $logFile -Encoding utf8
