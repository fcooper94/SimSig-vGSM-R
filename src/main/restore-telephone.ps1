# Restore ALL SimSig dialogs to center of SimSig's monitor, on top
# Runs as a detached process after Electron exits
# Finds every off-screen SimSig-owned window and moves it back

Start-Sleep -Milliseconds 500

try {
    Add-Type @"
    using System;
    using System.Runtime.InteropServices;

    public class WinRestore2 {
        [DllImport("user32.dll")]
        public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint dwFlags);
        [DllImport("user32.dll")]
        public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);
        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int maxLength);
        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder className, int maxLength);
        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        public static readonly IntPtr HWND_TOPMOST = (IntPtr)(-1);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        public struct MONITORINFO {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public uint dwFlags;
        }
    }
"@

    $log = @()
    $restoredTelephone = $false

    # Find SimSig main window to determine which monitor and process
    $simsigHwnd = [IntPtr]::Zero
    $findSimSigCb = [WinRestore2+EnumWindowsProc]{
        param([IntPtr]$hWnd, [IntPtr]$lParam)
        $sb = New-Object System.Text.StringBuilder 256
        [void][WinRestore2]::GetWindowText($hWnd, $sb, 256)
        if ($sb.ToString().StartsWith("SimSig -")) {
            $script:simsigHwnd = $hWnd
            return $false
        }
        return $true
    }
    [void][WinRestore2]::EnumWindows($findSimSigCb, [IntPtr]::Zero)

    # Get SimSig's process ID
    $simsigPid = [uint32]0
    if ($simsigHwnd -ne [IntPtr]::Zero) {
        [void][WinRestore2]::GetWindowThreadProcessId($simsigHwnd, [ref]$simsigPid)
        $log += "SimSig hwnd: $simsigHwnd  PID: $simsigPid"
    } else {
        $log += "SimSig main window not found"
    }

    # Get the work area of SimSig's monitor
    $centerX = 100
    $centerY = 100
    if ($simsigHwnd -ne [IntPtr]::Zero) {
        $monitor = [WinRestore2]::MonitorFromWindow($simsigHwnd, 1)
        $mi = New-Object WinRestore2+MONITORINFO
        $mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($mi)
        if ([WinRestore2]::GetMonitorInfo($monitor, [ref]$mi)) {
            $centerX = [int](($mi.rcWork.Left + $mi.rcWork.Right) / 2) - 200
            $centerY = [int](($mi.rcWork.Top + $mi.rcWork.Bottom) / 2) - 150
            $log += "Monitor: ($($mi.rcWork.Left),$($mi.rcWork.Top))-($($mi.rcWork.Right),$($mi.rcWork.Bottom))"
            $log += "Restore target: ($centerX, $centerY)"
        }
    }

    # SWP_NOSIZE (0x01) | SWP_SHOWWINDOW (0x40)
    $flags = 0x0001 -bor 0x0040

    # Enumerate ALL windows and collect off-screen ones belonging to SimSig
    $offScreenWindows = @()
    if ($simsigPid -gt 0) {
        $collectCb = [WinRestore2+EnumWindowsProc]{
            param([IntPtr]$hWnd, [IntPtr]$lParam)
            $wndPid = [uint32]0
            [void][WinRestore2]::GetWindowThreadProcessId($hWnd, [ref]$wndPid)
            if ($wndPid -eq $script:simsigPid) {
                $r = New-Object WinRestore2+RECT
                if ([WinRestore2]::GetWindowRect($hWnd, [ref]$r)) {
                    if ($r.Left -le -10000 -or $r.Top -le -10000) {
                        $script:offScreenWindows += $hWnd
                    }
                }
            }
            return $true
        }
        [void][WinRestore2]::EnumWindows($collectCb, [IntPtr]::Zero)

        $log += "Found $($offScreenWindows.Count) off-screen SimSig window(s)"

        # Restore TTelephoneForm on-screen; move TAnswerCallForm on-screen then close
        # (moving first ensures SimSig saves a visible position for future dialogs)
        $WM_CLOSE = 0x0010

        $offset = 0
        foreach ($wnd in $offScreenWindows) {
            $clsSb = New-Object System.Text.StringBuilder 256
            [void][WinRestore2]::GetClassName($wnd, $clsSb, 256)
            $cls = $clsSb.ToString()

            $titleSb = New-Object System.Text.StringBuilder 256
            [void][WinRestore2]::GetWindowText($wnd, $titleSb, 256)
            $title = $titleSb.ToString()

            # Skip the main SimSig window itself
            if ($wnd -eq $simsigHwnd) { continue }

            if ($cls -eq "TTelephoneForm") {
                # Restore Telephone Calls window on-screen
                [void][WinRestore2]::ShowWindow($wnd, 9)  # SW_RESTORE
                [void][WinRestore2]::SetWindowPos($wnd, [WinRestore2]::HWND_TOPMOST, ($centerX + $offset), ($centerY + $offset), 0, 0, $flags)
                [void][WinRestore2]::SetForegroundWindow($wnd)
                $log += "Restored [$cls] '$title' at ($($centerX + $offset), $($centerY + $offset))"
                $offset += 30
                $script:restoredTelephone = $true
            } elseif ($cls -eq "TAnswerCallForm") {
                # Move back on-screen so SimSig saves the visible position, then close
                [void][WinRestore2]::ShowWindow($wnd, 9)
                [void][WinRestore2]::SetWindowPos($wnd, [WinRestore2]::HWND_TOPMOST, ($centerX + $offset), ($centerY + $offset), 0, 0, $flags)
                Start-Sleep -Milliseconds 100
                [void][WinRestore2]::PostMessage($wnd, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
                $log += "Restored then closed [$cls] '$title' at ($($centerX + $offset), $($centerY + $offset))"
                $offset += 30
            } else {
                # Move on-screen so SimSig saves visible position, then close
                [void][WinRestore2]::ShowWindow($wnd, 9)
                [void][WinRestore2]::SetWindowPos($wnd, [WinRestore2]::HWND_TOPMOST, ($centerX + $offset), ($centerY + $offset), 0, 0, $flags)
                Start-Sleep -Milliseconds 100
                [void][WinRestore2]::PostMessage($wnd, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
                $log += "Restored then closed [$cls] '$title' at ($($centerX + $offset), $($centerY + $offset))"
                $offset += 30
            }
        }
    }

    # Only send F6 to open TTelephoneForm if we did NOT already restore it
    if (-not $restoredTelephone) {
        $hwnd = [WinRestore2]::FindWindow("TTelephoneForm", $null)
        if ($hwnd -eq [IntPtr]::Zero -and $simsigHwnd -ne [IntPtr]::Zero) {
            $log += "TTelephoneForm not found, sending F6"
            [void][WinRestore2]::PostMessage($simsigHwnd, 0x0100, [IntPtr]0x75, [IntPtr]::Zero)
            Start-Sleep -Milliseconds 50
            [void][WinRestore2]::PostMessage($simsigHwnd, 0x0101, [IntPtr]0x75, [IntPtr]::Zero)
            Start-Sleep -Milliseconds 500
            $hwnd = [WinRestore2]::FindWindow("TTelephoneForm", $null)
            if ($hwnd -ne [IntPtr]::Zero) {
                [void][WinRestore2]::ShowWindow($hwnd, 9)
                [void][WinRestore2]::SetWindowPos($hwnd, [WinRestore2]::HWND_TOPMOST, $centerX, $centerY, 0, 0, $flags)
                [void][WinRestore2]::SetForegroundWindow($hwnd)
                $log += "Restored TTelephoneForm (opened via F6)"
            } else {
                $log += "TTelephoneForm still not found after F6"
            }
        } else {
            $log += "TTelephoneForm already on-screen"
        }
    }

    $log | Out-File -FilePath "$PSScriptRoot\restore-log.txt" -Encoding utf8
} catch {
    "ERROR: $($_.Exception.Message)" | Out-File -FilePath "$PSScriptRoot\restore-log.txt" -Encoding utf8
}
