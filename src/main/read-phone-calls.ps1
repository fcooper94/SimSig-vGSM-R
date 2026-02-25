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

    public const int LB_GETCOUNT = 0x018B;
    public const int LB_GETTEXT = 0x0189;
    public const int LB_GETTEXTLEN = 0x018A;

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
}
"@

try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $calls = @()
    $simName = ""

    # Read sim name from TMainForm/TSimForm window title first
    $mainCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ClassNameProperty,
        "TMainForm"
    )
    $mainWin = $root.FindFirst(
        [System.Windows.Automation.TreeScope]::Children,
        $mainCond
    )
    if ($null -eq $mainWin) {
        $simCond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ClassNameProperty,
            "TSimForm"
        )
        $mainWin = $root.FindFirst(
            [System.Windows.Automation.TreeScope]::Children,
            $simCond
        )
    }
    if ($null -ne $mainWin) {
        $title = $mainWin.Current.Name
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

    # Read calls from listbox if telephone window is open
    if ($null -ne $window) {
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
