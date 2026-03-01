# read-place-call.ps1
# Reads the SimSig "Place Call" (TDialForm) dialog state after dialing.
# Reply options may be in a TListBox (multi-option) or TComboBox (single request).
# Outputs JSON: { "connected": true/false, "message": "...", "replies": [...] }

param(
    [string]$ContactName = ""
)

Add-Type -AssemblyName UIAutomationClient | Out-Null
Add-Type -AssemblyName UIAutomationTypes | Out-Null

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public class PlaceCallReader {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, StringBuilder lParam);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    // ComboBox messages
    public const int CB_GETCOUNT    = 0x0146;
    public const int CB_GETLBTEXT   = 0x0148;
    public const int CB_GETLBTEXTLEN = 0x0149;

    // ListBox messages
    public const int LB_GETCOUNT    = 0x018B;
    public const int LB_GETTEXT     = 0x0189;
    public const int LB_GETTEXTLEN  = 0x018A;

    public static int GetComboCount(IntPtr hWnd) {
        return (int)SendMessage(hWnd, CB_GETCOUNT, IntPtr.Zero, IntPtr.Zero);
    }

    public static string GetComboText(IntPtr hWnd, int index) {
        int len = (int)SendMessage(hWnd, CB_GETLBTEXTLEN, (IntPtr)index, IntPtr.Zero);
        if (len <= 0) return "";
        StringBuilder sb = new StringBuilder(len + 1);
        SendMessage(hWnd, CB_GETLBTEXT, (IntPtr)index, sb);
        return sb.ToString();
    }

    public static int GetListBoxCount(IntPtr hWnd) {
        return (int)SendMessage(hWnd, LB_GETCOUNT, IntPtr.Zero, IntPtr.Zero);
    }

    public static string GetListBoxText(IntPtr hWnd, int index) {
        int len = (int)SendMessage(hWnd, LB_GETTEXTLEN, (IntPtr)index, IntPtr.Zero);
        if (len <= 0) return "";
        StringBuilder sb = new StringBuilder(len + 1);
        SendMessage(hWnd, LB_GETTEXT, (IntPtr)index, sb);
        return sb.ToString();
    }

    public static void HideOffScreen(IntPtr hWnd) {
        SetWindowPos(hWnd, IntPtr.Zero, -32000, -32000, 0, 0, 0x0001 | 0x0004 | 0x0010);
    }
}
"@

try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement

    # Find the "Place Call" dialog by title
    $nameCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        "Place Call"
    )
    $dialog = $root.FindFirst(
        [System.Windows.Automation.TreeScope]::Children,
        $nameCond
    )

    if ($null -eq $dialog) {
        Write-Output '{"connected":false,"debug":"dialog not found"}'
        exit 0
    }

    # Keep it hidden off-screen
    $dialogHwnd = [IntPtr]$dialog.Current.NativeWindowHandle
    if ($dialogHwnd -ne [IntPtr]::Zero) {
        [PlaceCallReader]::HideOffScreen($dialogHwnd)
    }

    $replyItems = @()
    $replyControlType = ""  # "listbox" or "combo"

    # Check if connected by looking for TMemo (the message area that appears once the call connects)
    $memoCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ClassNameProperty,
        "TMemo"
    )
    $memoCheck = $dialog.FindFirst(
        [System.Windows.Automation.TreeScope]::Descendants,
        $memoCond
    )
    $isConnected = ($null -ne $memoCheck)

    if ($isConnected) {
        # Look for reply options in TListBox first
        $listCond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ClassNameProperty,
            "TListBox"
        )
        $allLists = $dialog.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            $listCond
        )
        foreach ($lb in $allLists) {
            $hw = [IntPtr]$lb.Current.NativeWindowHandle
            if ($hw -eq [IntPtr]::Zero) { continue }
            $cnt = [PlaceCallReader]::GetListBoxCount($hw)
            if ($cnt -gt 0) {
                $replyControlType = "listbox"
                for ($i = 0; $i -lt $cnt; $i++) {
                    $text = [PlaceCallReader]::GetListBoxText($hw, $i)
                    if ($text) { $replyItems += $text }
                }
                break
            }
        }

        # If no listbox replies, check TComboBox controls
        # Skip the contacts combo by checking if it contains the contact we dialed.
        if ($replyItems.Count -eq 0) {
            $comboCond = New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ClassNameProperty,
                "TComboBox"
            )
            $allCombos = $dialog.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                $comboCond
            )
            foreach ($combo in $allCombos) {
                $hw = [IntPtr]$combo.Current.NativeWindowHandle
                if ($hw -eq [IntPtr]::Zero) { continue }
                $cnt = [PlaceCallReader]::GetComboCount($hw)
                if ($cnt -le 0) { continue }

                # If we know who we called, skip the combo that contains that name
                $isContactsCombo = $false
                if ($ContactName) {
                    for ($i = 0; $i -lt $cnt; $i++) {
                        $text = [PlaceCallReader]::GetComboText($hw, $i)
                        if ($text -eq $ContactName) {
                            $isContactsCombo = $true
                            break
                        }
                    }
                }
                if ($isContactsCombo) { continue }

                $replyControlType = "combo"
                for ($i = 0; $i -lt $cnt; $i++) {
                    $text = [PlaceCallReader]::GetComboText($hw, $i)
                    if ($text) { $replyItems += $text }
                }
                break
            }
        }
    }

    if (-not $isConnected) {
        Write-Output '{"connected":false,"debug":"no TMemo — still ringing"}'
        exit 0
    }

    # Connected — read TMemo message text
    $messageText = ""
    if ($null -ne $memoCheck) {
        $messageText = ($memoCheck.Current.Name).Trim()
    }

    # Build JSON manually to guarantee replies is always a JSON array
    $escapedMsg = ($messageText -replace '\\', '\\\\' -replace '"', '\"' -replace "`n", '\n' -replace "`r", '')
    $repliesJson = @()
    foreach ($r in $replyItems) {
        $escaped = ($r -replace '\\', '\\\\' -replace '"', '\"' -replace "`n", '\n' -replace "`r", '')
        $repliesJson += "`"$escaped`""
    }
    $repliesArr = "[" + ($repliesJson -join ",") + "]"
    Write-Output "{`"connected`":true,`"message`":`"$escapedMsg`",`"replies`":$repliesArr,`"replyControl`":`"$replyControlType`"}"
} catch {
    Write-Output "{`"connected`":false,`"error`":`"$($_.Exception.Message)`"}"
}
