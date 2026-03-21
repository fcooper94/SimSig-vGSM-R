# Restore ALL SimSig dialogs to center of SimSig's monitor, on top
# Runs as a detached process after Electron exits
# Finds every off-screen SimSig-owned window and moves it back

Start-Sleep -Milliseconds 150

# Unmute SimSig audio first
try {
    $muteScript = Join-Path $PSScriptRoot "mute-simsig.ps1"
    if (Test-Path $muteScript) {
        & $muteScript -Action unmute | Out-Null
    }
} catch { }

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
        [DllImport("user32.dll")]
        public static extern bool SetCursorPos(int X, int Y);
        [DllImport("user32.dll")]
        public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);
        [DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr hWnd);

        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;

        public static void ClickAt(int x, int y) {
            SetCursorPos(x, y);
            mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, IntPtr.Zero);
            mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, IntPtr.Zero);
        }

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        public static readonly IntPtr HWND_TOPMOST = (IntPtr)(-1);
        public static readonly IntPtr HWND_TOP = IntPtr.Zero;

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

        # Split into categories: telephone (keep), answer call (close off-screen), others (restore then close)
        $telephoneWindows = @()
        $answerCallWindows = @()
        $otherWindows = @()
        foreach ($wnd in $offScreenWindows) {
            if ($wnd -eq $simsigHwnd) { continue }
            $clsSb = New-Object System.Text.StringBuilder 256
            [void][WinRestore2]::GetClassName($wnd, $clsSb, 256)
            $cls = $clsSb.ToString()
            if ($cls -eq "TTelephoneForm") {
                $telephoneWindows += $wnd
            } elseif ($cls -eq "TAnswerCallForm") {
                $answerCallWindows += $wnd
            } else {
                $otherWindows += $wnd
            }
        }

        $offset = 0

        # TAnswerCallForm: restore on-screen so SimSig can reuse it for future calls.
        # We cannot close it (SimSig ignores WM_CLOSE, clicking X breaks state).
        # Just move it back to a visible position — SimSig will update its content
        # when the user answers the next call.
        foreach ($wnd in $answerCallWindows) {
            [void][WinRestore2]::ShowWindow($wnd, 9)
            [void][WinRestore2]::SetWindowPos($wnd, [WinRestore2]::HWND_TOP, ($centerX + $offset), ($centerY + $offset), 0, 0, $flags)
            $log += "Restored [TAnswerCallForm] on-screen at ($($centerX + $offset), $($centerY + $offset))"
            $offset += 30
        }

        # Other dialogs (Place Call, etc.): restore on-screen only (do NOT close — crashes SimSig)
        foreach ($wnd in $otherWindows) {
            $clsSb = New-Object System.Text.StringBuilder 256
            [void][WinRestore2]::GetClassName($wnd, $clsSb, 256)
            $cls = $clsSb.ToString()
            $titleSb = New-Object System.Text.StringBuilder 256
            [void][WinRestore2]::GetWindowText($wnd, $titleSb, 256)
            $title = $titleSb.ToString()

            [void][WinRestore2]::ShowWindow($wnd, 9)
            [void][WinRestore2]::SetWindowPos($wnd, [WinRestore2]::HWND_TOP, ($centerX + $offset), ($centerY + $offset), 0, 0, $flags)
            $log += "Restored [$cls] '$title' at ($($centerX + $offset), $($centerY + $offset))"
            $offset += 30
        }

        # Then: restore TTelephoneForm last so it stays on top
        foreach ($wnd in $telephoneWindows) {
            $titleSb = New-Object System.Text.StringBuilder 256
            [void][WinRestore2]::GetWindowText($wnd, $titleSb, 256)
            $title = $titleSb.ToString()

            [void][WinRestore2]::ShowWindow($wnd, 9)  # SW_RESTORE
            [void][WinRestore2]::SetWindowPos($wnd, [WinRestore2]::HWND_TOP, ($centerX + $offset), ($centerY + $offset), 0, 0, $flags)
            [void][WinRestore2]::SetForegroundWindow($wnd)
            $log += "Restored [TTelephoneForm] '$title' at ($($centerX + $offset), $($centerY + $offset))"
            $offset += 30
            $script:restoredTelephone = $true
        }
    }

    # Clean up leftover SimSig dialogs using C# for reliable button finding
    # Strips & accelerator prefixes from button text before matching
    Add-Type -TypeDefinition @"
    using System;
    using System.Runtime.InteropServices;
    using System.Text;
    public class DialogCleanup {
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCb cb, IntPtr lp);
        [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumCb cb, IntPtr lp);
        [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
        public delegate bool EnumCb(IntPtr h, IntPtr l);
        public const uint BM_CLICK = 0x00F5;

        public static IntPtr FindVisibleWindow(string title) {
            IntPtr result = IntPtr.Zero;
            EnumWindows((h, l) => {
                if (!IsWindowVisible(h)) return true;
                var sb = new StringBuilder(256);
                GetWindowText(h, sb, 256);
                if (sb.ToString() == title) { result = h; return false; }
                return true;
            }, IntPtr.Zero);
            return result;
        }

        public static IntPtr FindChildButton(IntPtr parent, string text) {
            IntPtr result = IntPtr.Zero;
            EnumChildWindows(parent, (h, l) => {
                var sb = new StringBuilder(256);
                GetWindowText(h, sb, 256);
                if (sb.ToString().Replace("&", "") == text) { result = h; return false; }
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

        [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
        public const int LB_GETCOUNT = 0x018B;
    }
"@ -ErrorAction SilentlyContinue

    # Clean up dialogs - different paths for outstanding calls vs no calls
    $telHwnd2 = [DialogCleanup]::FindVisibleWindow("Telephone Calls")
    if ($telHwnd2 -ne [IntPtr]::Zero) {
        $listBox = [DialogCleanup]::FindChildByClass($telHwnd2, "TListBox")
        $callCount = 0
        if ($listBox -ne [IntPtr]::Zero) {
            $callCount = [int][DialogCleanup]::SendMessage($listBox, [DialogCleanup]::LB_GETCOUNT, [IntPtr]::Zero, [IntPtr]::Zero)
            $log += "Outstanding calls: $callCount"
        }

        if ($callCount -gt 0) {
            # Outstanding call - answer it, then close the Answer Call dialog
            $answerBtn = [DialogCleanup]::FindChildButton($telHwnd2, "Answer call")
            if ($answerBtn -ne [IntPtr]::Zero) {
                $listBox2 = [DialogCleanup]::FindChildByClass($telHwnd2, "TListBox")
                if ($listBox2 -ne [IntPtr]::Zero) {
                    [DialogCleanup]::SendMessage($listBox2, 0x0186, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
                    Start-Sleep -Milliseconds 50
                }
                [DialogCleanup]::SendMessage($answerBtn, [DialogCleanup]::BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
                $log += "Clicked 'Answer call' to consume outstanding call"
                Start-Sleep -Milliseconds 150

                # Close the Answer Call dialog via physical X button click
                Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue | Out-Null
                Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue | Out-Null
                $root = [System.Windows.Automation.AutomationElement]::RootElement
                $cond = New-Object System.Windows.Automation.PropertyCondition(
                    [System.Windows.Automation.AutomationElement]::ClassNameProperty, "TAnswerCallForm"
                )
                $answerDlg = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
                if ($null -ne $answerDlg) {
                    $dlgHwnd = [IntPtr]$answerDlg.Current.NativeWindowHandle
                    [WinRestore2]::ShowWindow($dlgHwnd, 9) | Out-Null
                    [WinRestore2]::SetForegroundWindow($dlgHwnd) | Out-Null
                    Start-Sleep -Milliseconds 100
                    $rect = New-Object WinRestore2+RECT
                    [WinRestore2]::GetWindowRect($dlgHwnd, [ref]$rect) | Out-Null
                    $xBtnX = $rect.Right - 20
                    $xBtnY = $rect.Top + 15
                    [WinRestore2]::ClickAt($xBtnX, $xBtnY)
                    $log += "Closed Answer Call dialog via X button"
                    Start-Sleep -Milliseconds 100
                }
            }
        } else {
            # No outstanding calls - minimize stale TAnswerCallForm, press F6 for fresh
            # Telephone Calls dialog, then launch ghost watcher

            # Minimize the stale TAnswerCallForm
            $answerHwnd = [IntPtr]::Zero
            [DialogCleanup]::EnumWindows([DialogCleanup+EnumCb]{
                param($h,$l)
                $sb = New-Object System.Text.StringBuilder 256
                [DialogCleanup]::GetClassName($h, $sb, 256)
                if ($sb.ToString() -eq "TAnswerCallForm") { $script:answerHwnd = $h; return $false }
                return $true
            }, [IntPtr]::Zero) | Out-Null
            if ($answerHwnd -ne [IntPtr]::Zero) {
                [WinRestore2]::ShowWindow($answerHwnd, 6) | Out-Null
                $log += "Minimized stale TAnswerCallForm"
            }

            # Press F6 on SimSig to close and reopen Telephone Calls (non-stale)
            if ($simsigHwnd -ne [IntPtr]::Zero) {
                # F6 toggles the Telephone Calls window - press twice: close stale, open fresh
                [void][WinRestore2]::PostMessage($simsigHwnd, 0x0100, [IntPtr]0x75, [IntPtr]::Zero)
                Start-Sleep -Milliseconds 50
                [void][WinRestore2]::PostMessage($simsigHwnd, 0x0101, [IntPtr]0x75, [IntPtr]::Zero)
                Start-Sleep -Milliseconds 100
                [void][WinRestore2]::PostMessage($simsigHwnd, 0x0100, [IntPtr]0x75, [IntPtr]::Zero)
                Start-Sleep -Milliseconds 50
                [void][WinRestore2]::PostMessage($simsigHwnd, 0x0101, [IntPtr]0x75, [IntPtr]::Zero)
                Start-Sleep -Milliseconds 150
                $log += "Pressed F6 twice to reopen fresh Telephone Calls"
            }

            # Launch ghost watcher to restore TAnswerCallForm when next call appears
            $ghostScript = Join-Path $PSScriptRoot "ghost-watcher.ps1"
            if (Test-Path $ghostScript) {
                Start-Process powershell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ghostScript`"" -WindowStyle Hidden
                $log += "Launched ghost watcher"
            }
        }

        # Click "Place call..." then "Hang up and close" to clean up
        # If SimSig is paused, this will pop a message box — dismiss it and skip
        $placeBtn = [DialogCleanup]::FindChildButton($telHwnd2, "Place call...")
        if ($placeBtn -ne [IntPtr]::Zero) {
            [DialogCleanup]::SendMessage($placeBtn, [DialogCleanup]::BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
            $log += "Clicked 'Place call...'"
            Start-Sleep -Milliseconds 150

            # Check if a "paused" message box appeared — dismiss it
            $pausedHandled = $false
            [DialogCleanup]::EnumWindows([DialogCleanup+EnumCb]{
                param($h,$l)
                if (![DialogCleanup]::IsWindowVisible($h)) { return $true }
                $sb = New-Object System.Text.StringBuilder 256
                [DialogCleanup]::GetWindowText($h, $sb, 256)
                $t = $sb.ToString()
                if ($t -like "*SimSig" -and $t -ne "") {
                    # Check if it has an OK button (message dialog, not main window)
                    $okBtn = [DialogCleanup]::FindChildButton($h, "OK")
                    if ($okBtn -eq [IntPtr]::Zero) { $okBtn = [DialogCleanup]::FindChildButton($h, "Ok") }
                    if ($okBtn -ne [IntPtr]::Zero) {
                        [DialogCleanup]::SendMessage($okBtn, [DialogCleanup]::BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
                        $script:pausedHandled = $true
                        return $false
                    }
                }
                return $true
            }, [IntPtr]::Zero) | Out-Null

            if ($pausedHandled) {
                $log += "Dismissed paused dialog - skipping Place Call cleanup"
            } else {
                $placeDlg = [DialogCleanup]::FindVisibleWindow("Place Call")
                if ($placeDlg -ne [IntPtr]::Zero) {
                    $hangBtn = [DialogCleanup]::FindChildButton($placeDlg, "Hang up and close")
                    if ($hangBtn -ne [IntPtr]::Zero) {
                        [DialogCleanup]::SendMessage($hangBtn, [DialogCleanup]::BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
                        $log += "Clicked 'Hang up and close' - dialogs cleaned up"
                    } else {
                        $log += "Could not find 'Hang up and close' button"
                    }
                } else {
                    $log += "Place Call dialog did not open"
                }
            }
        } else {
            $log += "Could not find 'Place call...' button"
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
            Start-Sleep -Milliseconds 150
            $hwnd = [WinRestore2]::FindWindow("TTelephoneForm", $null)
            if ($hwnd -ne [IntPtr]::Zero) {
                [void][WinRestore2]::ShowWindow($hwnd, 9)
                [void][WinRestore2]::SetWindowPos($hwnd, [WinRestore2]::HWND_TOP, $centerX, $centerY, 0, 0, $flags)
                [void][WinRestore2]::SetForegroundWindow($hwnd)
                $log += "Restored TTelephoneForm (opened via F6)"
            } else {
                $log += "TTelephoneForm still not found after F6"
            }
        } else {
            $log += "TTelephoneForm already on-screen"
        }
    }

    # Final cleanup: close the Telephone Calls dialog if still visible
    $telFinal = [DialogCleanup]::FindVisibleWindow("Telephone Calls")
    if ($telFinal -ne [IntPtr]::Zero) {
        $closeBtn = [DialogCleanup]::FindChildButton($telFinal, "Close")
        if ($closeBtn -ne [IntPtr]::Zero) {
            [DialogCleanup]::SendMessage($closeBtn, [DialogCleanup]::BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
            $log += "Closed Telephone Calls dialog"
        }
    }

    $log | Out-File -FilePath "$PSScriptRoot\restore-log.txt" -Encoding utf8
} catch {
    "ERROR: $($_.Exception.Message)" | Out-File -FilePath "$PSScriptRoot\restore-log.txt" -Encoding utf8
}
