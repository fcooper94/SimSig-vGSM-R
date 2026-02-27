# read-place-call.ps1
# Reads the SimSig "Place Call" (TDialForm) dialog state after dialing.
# When connected, replies are in a TComboBox (not TListBox).
# Outputs JSON: { "connected": true/false, "message": "...", "replies": [...] }

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
    public const int CB_GETCOUNT = 0x0146;
    public const int CB_GETLBTEXT = 0x0148;
    public const int CB_GETLBTEXTLEN = 0x0149;

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

    # Check if "Send request/message" button exists (only present when connected)
    $sendBtnCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        "Send request/message"
    )
    $sendBtn = $dialog.FindFirst(
        [System.Windows.Automation.TreeScope]::Descendants,
        $sendBtnCond
    )

    # Find all TComboBox controls
    $comboCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ClassNameProperty,
        "TComboBox"
    )
    $allCombos = $dialog.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        $comboCond
    )

    # Identify the reply ComboBox by keyword matching on first item.
    # The reply combo has request/message items; the contacts combo has location names.
    $replyComboHwnd = [IntPtr]::Zero
    $replyItems = @()
    $replyKeywords = "^(Request|Message|Send|Cancel|Pass|Hold|Block|Continue|Ask|Authoris|Please)"

    foreach ($combo in $allCombos) {
        $hw = [IntPtr]$combo.Current.NativeWindowHandle
        if ($hw -eq [IntPtr]::Zero) { continue }
        $cnt = [PlaceCallReader]::GetComboCount($hw)
        if ($cnt -gt 0) {
            $firstItem = [PlaceCallReader]::GetComboText($hw, 0)
            if ($firstItem -match $replyKeywords) {
                $replyComboHwnd = $hw
                for ($i = 0; $i -lt $cnt; $i++) {
                    $text = [PlaceCallReader]::GetComboText($hw, $i)
                    if ($text) { $replyItems += $text }
                }
                break
            }
        }
    }

    # Fallback: pick the combo with the longest first item (request text vs location name)
    if ($replyComboHwnd -eq [IntPtr]::Zero -and $allCombos.Count -ge 2) {
        foreach ($combo in $allCombos) {
            $hw = [IntPtr]$combo.Current.NativeWindowHandle
            if ($hw -eq [IntPtr]::Zero) { continue }
            $cnt = [PlaceCallReader]::GetComboCount($hw)
            if ($cnt -gt 0) {
                $firstItem = [PlaceCallReader]::GetComboText($hw, 0)
                if ($firstItem.Length -gt 20) {
                    $replyComboHwnd = $hw
                    for ($i = 0; $i -lt $cnt; $i++) {
                        $text = [PlaceCallReader]::GetComboText($hw, $i)
                        if ($text) { $replyItems += $text }
                    }
                    break
                }
            }
        }
    }

    # Connected = reply combo found with items
    if ($replyComboHwnd -eq [IntPtr]::Zero -or $replyItems.Count -eq 0) {
        # Not connected yet — dump debug info
        $debugParts = @("combos=$($allCombos.Count)")
        $ci = 0
        foreach ($combo in $allCombos) {
            $hw = [IntPtr]$combo.Current.NativeWindowHandle
            if ($hw -eq [IntPtr]::Zero) { $ci++; continue }
            $cnt = [PlaceCallReader]::GetComboCount($hw)
            $first = ""
            if ($cnt -gt 0) { $first = [PlaceCallReader]::GetComboText($hw, 0) }
            $debugParts += "c${ci}=${cnt}items"
            if ($first) { $debugParts += "c${ci}first=$first" }
            $ci++
        }
        $btnCond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ClassNameProperty,
            "TButton"
        )
        $allBtns = $dialog.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            $btnCond
        )
        $btnNames = @()
        foreach ($btn in $allBtns) { $btnNames += $btn.Current.Name }
        $debugParts += "btns=$($btnNames -join '|')"

        $debugStr = ($debugParts -join "; ") -replace '"', "'" -replace "`n", " " -replace "`r", ""
        Write-Output "{`"connected`":false,`"debug`":`"$debugStr`"}"
        exit 0
    }

    # Connected — read TMemo message text
    $messageText = ""
    $memoCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ClassNameProperty,
        "TMemo"
    )
    $memo = $dialog.FindFirst(
        [System.Windows.Automation.TreeScope]::Descendants,
        $memoCond
    )
    if ($null -ne $memo) {
        $messageText = ($memo.Current.Name).Trim()
    }

    # Build JSON manually to guarantee replies is always a JSON array
    $escapedMsg = ($messageText -replace '\\', '\\\\' -replace '"', '\"' -replace "`n", '\n' -replace "`r", '')
    $repliesJson = @()
    foreach ($r in $replyItems) {
        $escaped = ($r -replace '\\', '\\\\' -replace '"', '\"' -replace "`n", '\n' -replace "`r", '')
        $repliesJson += "`"$escaped`""
    }
    $repliesArr = "[" + ($repliesJson -join ",") + "]"
    Write-Output "{`"connected`":true,`"message`":`"$escapedMsg`",`"replies`":$repliesArr}"
} catch {
    Write-Output "{`"connected`":false,`"error`":`"$($_.Exception.Message)`"}"
}
