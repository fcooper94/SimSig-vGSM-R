# read-phone-calls.ps1
# Reads the SimSig "Telephone Calls" window using Win32 API
# The TListBox is owner-drawn (Delphi), so LB_GETTEXT only returns
# the train identifier. All items in the list are unanswered calls.
# Outputs a JSON array to stdout.

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class SimSigListBox {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, StringBuilder lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    public const int LB_GETCOUNT = 0x018B;
    public const int LB_GETTEXT = 0x0189;
    public const int LB_GETTEXTLEN = 0x018A;
    public const uint WM_KEYDOWN = 0x0100;
    public const uint WM_KEYUP = 0x0101;
    public const int VK_F6 = 0x75;

    public static int GetCount(IntPtr hWnd) {
        return (int)SendMessage(hWnd, LB_GETCOUNT, IntPtr.Zero, IntPtr.Zero);
    }

    public static string GetText(IntPtr hWnd, int index) {
        int len = (int)SendMessage(hWnd, LB_GETTEXTLEN, (IntPtr)index, IntPtr.Zero);
        if (len <= 0) return "";
        StringBuilder sb = new StringBuilder(len + 1);
        SendMessage(hWnd, LB_GETTEXT, (IntPtr)index, sb);
        return sb.ToString();
    }

    public static IntPtr simsigHwnd = IntPtr.Zero;
    private static EnumWindowsProc _callback;
    public static void FindSimSig() {
        simsigHwnd = IntPtr.Zero;
        _callback = (hWnd, lParam) => {
            StringBuilder sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            if (sb.ToString().StartsWith("SimSig -")) {
                simsigHwnd = hWnd;
                return false;
            }
            return true;
        };
        EnumWindows(_callback, IntPtr.Zero);
    }

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    public static void HideOffScreen(IntPtr hWnd) {
        // Move window far off-screen and push to bottom of Z-order
        // SWP_NOSIZE (0x01) | SWP_NOACTIVATE (0x10)
        SetWindowPos(hWnd, (IntPtr)1, -32000, -32000, 0, 0, 0x0001 | 0x0010);
    }

    public static void SendF6(IntPtr hWnd) {
        PostMessage(hWnd, WM_KEYDOWN, (IntPtr)VK_F6, IntPtr.Zero);
        PostMessage(hWnd, WM_KEYUP, (IntPtr)VK_F6, IntPtr.Zero);
    }
}
"@

try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $calls = @()
    $simName = ""

    # Read sim name from SimSig window title using EnumWindows (reliable for Delphi)
    [SimSigListBox]::FindSimSig()
    if ([SimSigListBox]::simsigHwnd -ne [IntPtr]::Zero) {
        $sb = New-Object System.Text.StringBuilder 256
        [SimSigListBox]::GetWindowText([SimSigListBox]::simsigHwnd, $sb, 256) | Out-Null
        $title = $sb.ToString()
        if ($title -match "^SimSig\s*-\s*(.+?)\s*\(") {
            $simName = $Matches[1].Trim()
        } elseif ($title -match "^SimSig\s*-\s*(.+)$") {
            $simName = $Matches[1].Trim()
        }
    }

    # Find the "Telephone Calls" window
    $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        "Telephone Calls"
    )
    $window = $root.FindFirst(
        [System.Windows.Automation.TreeScope]::Children,
        $condition
    )
    if ($null -eq $window) {
        $classCond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ClassNameProperty,
            "TTelephoneForm"
        )
        $window = $root.FindFirst(
            [System.Windows.Automation.TreeScope]::Children,
            $classCond
        )
    }

    # If telephone window is not open, send F6 to SimSig to open it
    if ($null -eq $window) {
        [SimSigListBox]::FindSimSig()
        $simHwnd = [SimSigListBox]::simsigHwnd
        if ($simHwnd -ne [IntPtr]::Zero) {
            [SimSigListBox]::SendF6($simHwnd)
        }
    }

    # Read calls from listbox if telephone window is open
    if ($null -ne $window) {
        # Keep the telephone window hidden off-screen
        $teleHwnd = [IntPtr]$window.Current.NativeWindowHandle
        if ($teleHwnd -ne [IntPtr]::Zero) {
            [SimSigListBox]::HideOffScreen($teleHwnd)
        }

        $listBoxCond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ClassNameProperty,
            "TListBox"
        )
        $listBox = $window.FindFirst(
            [System.Windows.Automation.TreeScope]::Descendants,
            $listBoxCond
        )
        if ($null -ne $listBox) {
            $hwnd = [IntPtr]$listBox.Current.NativeWindowHandle
            $count = [SimSigListBox]::GetCount($hwnd)
            for ($i = 0; $i -lt $count; $i++) {
                $text = [SimSigListBox]::GetText($hwnd, $i)
                if ($text) {
                    $calls += @{ train = $text; status = "Unanswered" }
                }
            }
        }
    }

    $result = @{ calls = $calls; simName = $simName }
    if ($calls.Count -eq 0) {
        $result.calls = @()
    }
    $json = $result | ConvertTo-Json -Compress -Depth 3
    Write-Output $json
} catch {
    Write-Output '{"calls":[],"simName":""}'
}
