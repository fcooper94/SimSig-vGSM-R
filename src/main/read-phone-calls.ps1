# read-phone-calls.ps1
# Reads the SimSig "Telephone Calls" window using Win32 API
# The TListBox is owner-drawn (Delphi), so LB_GETTEXT only returns
# the train identifier. All items in the list are unanswered calls.
# Outputs a JSON array to stdout.

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement

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
        # Try by class name as fallback
        $classCond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ClassNameProperty,
            "TTelephoneForm"
        )
        $window = $root.FindFirst(
            [System.Windows.Automation.TreeScope]::Children,
            $classCond
        )
    }

    if ($null -eq $window) {
        Write-Output "[]"
        exit 0
    }

    # Find the TListBox control
    $listBoxCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ClassNameProperty,
        "TListBox"
    )
    $listBox = $window.FindFirst(
        [System.Windows.Automation.TreeScope]::Descendants,
        $listBoxCond
    )

    if ($null -eq $listBox) {
        Write-Output "[]"
        exit 0
    }

    $handle = $listBox.Current.NativeWindowHandle

    # Define Win32 SendMessage for ListBox
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

    $hwnd = [IntPtr]$handle
    $count = [SimSigListBox]::GetCount($hwnd)

    if ($count -le 0) {
        Write-Output "[]"
        exit 0
    }

    $calls = @()
    for ($i = 0; $i -lt $count; $i++) {
        $text = [SimSigListBox]::GetText($hwnd, $i)
        if ($text) {
            $call = @{
                train  = $text
                status = "Unanswered"
            }
            $calls += $call
        }
    }

    if ($calls.Count -eq 0) {
        Write-Output "[]"
    } elseif ($calls.Count -eq 1) {
        $json = $calls[0] | ConvertTo-Json -Compress
        Write-Output "[$json]"
    } else {
        $json = $calls | ConvertTo-Json -Compress
        Write-Output $json
    }
} catch {
    Write-Output "[]"
}
