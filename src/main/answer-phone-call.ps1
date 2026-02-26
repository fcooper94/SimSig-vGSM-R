# answer-phone-call.ps1
# Selects a call in SimSig's Telephone Calls listbox, clicks Answer,
# reads the message from the response dialog, and outputs JSON.
# Does NOT auto-reply — leaves the dialog open for the user.
# Usage: powershell -File answer-phone-call.ps1 -Index 0

param(
    [int]$Index = 0,
    [string]$Train = ""
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class Win32Auto {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, StringBuilder lParam);

    public const int LB_GETCOUNT = 0x018B;
    public const int LB_SETCURSEL = 0x0186;
    public const int LB_GETTEXT = 0x0189;
    public const int LB_GETTEXTLEN = 0x018A;
    public const int BM_CLICK = 0x00F5;

    public static int GetCount(IntPtr hWnd) {
        return (int)SendMessage(hWnd, LB_GETCOUNT, IntPtr.Zero, IntPtr.Zero);
    }

    public static void SelectItem(IntPtr hWnd, int index) {
        SendMessage(hWnd, LB_SETCURSEL, (IntPtr)index, IntPtr.Zero);
    }

    public static string GetText(IntPtr hWnd, int index) {
        int len = (int)SendMessage(hWnd, LB_GETTEXTLEN, (IntPtr)index, IntPtr.Zero);
        if (len <= 0) return "";
        StringBuilder sb = new StringBuilder(len + 1);
        SendMessage(hWnd, LB_GETTEXT, (IntPtr)index, sb);
        return sb.ToString();
    }

    public static void ClickButton(IntPtr hWnd) {
        SendMessage(hWnd, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
    }

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    public static void HideOffScreen(IntPtr hWnd) {
        // Move window far off-screen without changing Z-order
        // SWP_NOSIZE (0x01) | SWP_NOZORDER (0x04) | SWP_NOACTIVATE (0x10)
        SetWindowPos(hWnd, IntPtr.Zero, -32000, -32000, 0, 0, 0x0001 | 0x0004 | 0x0010);
    }
}
"@

try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement

    # Find the Telephone Calls window
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

    if ($null -eq $window) {
        Write-Output '{"error":"Telephone Calls window not found"}'
        exit 0
    }

    # Find the TListBox
    $listBoxCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ClassNameProperty,
        "TListBox"
    )
    $listBox = $window.FindFirst(
        [System.Windows.Automation.TreeScope]::Descendants,
        $listBoxCond
    )

    if ($null -eq $listBox) {
        Write-Output '{"error":"ListBox not found"}'
        exit 0
    }

    $listBoxHwnd = [IntPtr]$listBox.Current.NativeWindowHandle
    $count = [Win32Auto]::GetCount($listBoxHwnd)

    # If a train name was provided, find its actual index in the listbox
    if ($Train -ne "") {
        $found = $false
        for ($i = 0; $i -lt $count; $i++) {
            $itemText = [Win32Auto]::GetText($listBoxHwnd, $i)
            if ($itemText -eq $Train) {
                $Index = $i
                $found = $true
                break
            }
        }
        if (-not $found) {
            Write-Output '{"error":"Call not found in list"}'
            exit 0
        }
    }

    if ($Index -ge $count) {
        Write-Output '{"error":"Call index out of range"}'
        exit 0
    }

    # Get the train name before answering
    $trainName = [Win32Auto]::GetText($listBoxHwnd, $Index)

    # Select the call in the listbox
    [Win32Auto]::SelectItem($listBoxHwnd, $Index)
    Start-Sleep -Milliseconds 50

    # Find and click the "Answer call" button
    $answerBtnCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        "Answer call"
    )
    $answerBtn = $window.FindFirst(
        [System.Windows.Automation.TreeScope]::Descendants,
        $answerBtnCond
    )

    if ($null -eq $answerBtn) {
        Write-Output '{"error":"Answer call button not found"}'
        exit 0
    }

    $answerBtnHwnd = [IntPtr]$answerBtn.Current.NativeWindowHandle
    [Win32Auto]::ClickButton($answerBtnHwnd)

    # Wait for the TAnswerCallForm dialog to appear (up to 3 seconds)
    $messageText = ""
    $dialogTitle = ""
    $answerDialog = $null

    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 100

        # Look for TAnswerCallForm
        $answerFormCond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ClassNameProperty,
            "TAnswerCallForm"
        )
        $answerDialog = $root.FindFirst(
            [System.Windows.Automation.TreeScope]::Children,
            $answerFormCond
        )

        if ($null -ne $answerDialog) {
            $dialogTitle = $answerDialog.Current.Name

            # Read the TMemo for the message text
            $memoCond = New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ClassNameProperty,
                "TMemo"
            )
            $memo = $answerDialog.FindFirst(
                [System.Windows.Automation.TreeScope]::Descendants,
                $memoCond
            )

            if ($null -ne $memo) {
                $messageText = $memo.Current.Name
            }

            # Read the reply options from the TListBox (for display only)
            $replyListBox = $answerDialog.FindFirst(
                [System.Windows.Automation.TreeScope]::Descendants,
                $listBoxCond
            )

            $replyOptions = @()
            if ($null -ne $replyListBox) {
                $replyHwnd = [IntPtr]$replyListBox.Current.NativeWindowHandle
                $replyCount = [Win32Auto]::GetCount($replyHwnd)
                for ($r = 0; $r -lt $replyCount; $r++) {
                    $replyOptions += [Win32Auto]::GetText($replyHwnd, $r)
                }
            }

            # Hide the answer dialog off-screen
            $answerHwnd = [IntPtr]$answerDialog.Current.NativeWindowHandle
            if ($answerHwnd -ne [IntPtr]::Zero) {
                [Win32Auto]::HideOffScreen($answerHwnd)
            }

            break
        }
    }

    # Build result
    $result = @{
        train   = $trainName
        title   = $dialogTitle
        message = $messageText
        replies = $replyOptions
    }

    $json = $result | ConvertTo-Json -Compress
    Write-Output $json
} catch {
    Write-Output "{`"error`":`"$($_.Exception.Message)`"}"
}
