# reply-place-call.ps1
# ──────────────────────────────────────────────────────────────────────
# Handles outgoing (Place Call) replies in SimSig's Place Call dialog.
# Called from ipc-handlers.js via execFile when the user sends a reply
# during an outgoing call (signaller-to-signaller, token hut, etc.).
#
# FLOW:
#   1. Find the Place Call dialog (top-level window titled "Place Call")
#   2. Find the reply control — TListBox or TComboBox depending on SimSig version
#   3. Select the reply by index (LB_SETCURSEL or CB_SETCURSEL)
#   4. Click the "Send request/message" button via PostMessage (async — see below)
#   5. Handle any follow-up dialogs:
#      a. Yes/No confirmation dialog — click Yes
#      b. Headcode entry dialog ("Confirmation required" with TEdit) — type headcode, click OK
#      c. Message/OK dialog — click OK to dismiss
#   6. Read the TMemo response text (SimSig's reply to us) and return it as JSON
#
# IMPORTANT — PostMessage vs SendMessage:
#   The "Send request/message" button click MUST use PostMessage (async).
#   SendMessage(BM_CLICK) blocks if the button opens a modal dialog (e.g.
#   headcode confirmation), hanging the script until the 30s timeout kills it.
#
# HEADCODE CONFIRMATION:
#   Some replies (e.g. "permission for train to enter") trigger a confirmation
#   dialog. The Yes/No type is a simple confirmation with no TEdit — dismiss it.
#   The headcode entry type has "onfirmation" in the title + a TEdit child
#   where the headcode must be typed. TLabel text says "Enter XXXX to confirm"
#   but TLabel is a Delphi TGraphicControl with no HWND — we try to read it
#   via EnumChildWindows but fall back to the HeadCode parameter if not found.
#
# Usage: powershell -File reply-place-call.ps1 -ReplyIndex 0 [-HeadCode 1F32]
# ──────────────────────────────────────────────────────────────────────

param(
    [int]$ReplyIndex = 0,
    [string]$HeadCode = "",
    [string]$Param2 = "",
    [string]$ContactName = ""
)

Add-Type -AssemblyName UIAutomationClient | Out-Null
Add-Type -AssemblyName UIAutomationTypes | Out-Null

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class PlaceCallReply {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", EntryPoint = "SendMessage", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessageSb(IntPtr hWnd, int msg, IntPtr wParam, StringBuilder lParam);

    [DllImport("user32.dll", EntryPoint = "SendMessage", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessageStr(IntPtr hWnd, int msg, IntPtr wParam, string lParam);

    public const int WM_SETTEXT = 0x000C;

    public static void SetText(IntPtr hWnd, string text) {
        SendMessageStr(hWnd, WM_SETTEXT, IntPtr.Zero, text);
    }

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    // Thread input attachment for cross-process SetFocus
    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    public static extern IntPtr SetFocus(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumCallback callback, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr parent, EnumCallback callback, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxLength);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxLength);

    public delegate bool EnumCallback(IntPtr hWnd, IntPtr lParam);

    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const byte VK_DOWN   = 0x28;
    public const byte VK_HOME   = 0x24;
    public const byte VK_TAB    = 0x09;
    public const byte VK_RETURN = 0x0D;

    // ComboBox messages
    public const int CB_GETCOUNT    = 0x0146;
    public const int CB_GETLBTEXT   = 0x0148;
    public const int CB_GETLBTEXTLEN = 0x0149;

    // ListBox messages
    public const int LB_GETCOUNT    = 0x018B;
    public const int LB_GETTEXT     = 0x0189;
    public const int LB_GETTEXTLEN  = 0x018A;
    public const int LB_SETCURSEL   = 0x0186;

    public const int BM_CLICK = 0x00F5;
    public const int SW_RESTORE = 9;

    public static void PressKey(byte vk) {
        keybd_event(vk, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(30);
        keybd_event(vk, 0, KEYEVENTF_KEYUP, IntPtr.Zero);
    }

    // ComboBox helpers
    public static int GetComboCount(IntPtr hWnd) {
        return (int)SendMessage(hWnd, CB_GETCOUNT, IntPtr.Zero, IntPtr.Zero);
    }
    public static string GetComboText(IntPtr hWnd, int index) {
        int len = (int)SendMessage(hWnd, CB_GETLBTEXTLEN, (IntPtr)index, IntPtr.Zero);
        if (len <= 0) return "";
        StringBuilder sb = new StringBuilder(len + 1);
        SendMessageSb(hWnd, CB_GETLBTEXT, (IntPtr)index, sb);
        return sb.ToString();
    }

    // ListBox helpers
    public static int GetListBoxCount(IntPtr hWnd) {
        return (int)SendMessage(hWnd, LB_GETCOUNT, IntPtr.Zero, IntPtr.Zero);
    }
    public static string GetListBoxText(IntPtr hWnd, int index) {
        int len = (int)SendMessage(hWnd, LB_GETTEXTLEN, (IntPtr)index, IntPtr.Zero);
        if (len <= 0) return "";
        StringBuilder sb = new StringBuilder(len + 1);
        SendMessageSb(hWnd, LB_GETTEXT, (IntPtr)index, sb);
        return sb.ToString();
    }
    public static void SetListBoxSel(IntPtr hWnd, int index) {
        SendMessage(hWnd, LB_SETCURSEL, (IntPtr)index, IntPtr.Zero);
    }

    public static void HideOffScreen(IntPtr hWnd) {
        SetWindowPos(hWnd, IntPtr.Zero, -32000, -32000, 0, 0, 0x0001 | 0x0004 | 0x0010);
    }

    // Cross-process SetFocus via thread input attachment
    public static void FocusControl(IntPtr dialogHwnd, IntPtr controlHwnd) {
        uint pid;
        uint targetThread = GetWindowThreadProcessId(dialogHwnd, out pid);
        uint ourThread = GetCurrentThreadId();
        AttachThreadInput(ourThread, targetThread, true);
        SetFocus(controlHwnd);
        AttachThreadInput(ourThread, targetThread, false);
    }

    // Find a visible window with "onfirmation" or "arameter" in title that has an edit child
    public static IntPtr FindParameterDialog() {
        IntPtr result = IntPtr.Zero;
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            var sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            string title = sb.ToString();
            if (title.Contains("onfirmation") || title.Contains("arameter")) {
                IntPtr edit = FindEditControl(hWnd);
                if (edit != IntPtr.Zero) {
                    result = hWnd;
                    return false;
                }
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    public static IntPtr FindEditControl(IntPtr parent) {
        IntPtr result = IntPtr.Zero;
        EnumChildWindows(parent, (hWnd, lParam) => {
            var sb = new StringBuilder(256);
            GetClassName(hWnd, sb, 256);
            string cls = sb.ToString();
            if (cls == "TEdit" || cls == "Edit") {
                result = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    // Find a visible Yes/No confirmation dialog (no edit control required)
    public static IntPtr FindConfirmationDialog() {
        IntPtr result = IntPtr.Zero;
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            var sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            string title = sb.ToString();
            if (title.Contains("onfirmation") || title.Contains("onfirm")) {
                IntPtr yesBtn = FindButtonByAnyText(hWnd, new string[] {"Yes", "&Yes"});
                if (yesBtn != IntPtr.Zero) {
                    result = hWnd;
                    return false;
                }
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    // Find a visible message dialog with OK/Close button
    public static IntPtr FindMessageDialog() {
        IntPtr result = IntPtr.Zero;
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            var sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            string title = sb.ToString();
            if (title == "Message" || title.Contains("onfirmation")) {
                IntPtr btn = FindButtonByAnyText(hWnd, new string[] {"OK", "Ok", "&OK", "Close"});
                if (btn != IntPtr.Zero) {
                    result = hWnd;
                    return false;
                }
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    public static IntPtr FindButtonByAnyText(IntPtr parent, string[] texts) {
        IntPtr result = IntPtr.Zero;
        EnumChildWindows(parent, (hWnd, lParam) => {
            var sb = new StringBuilder(256);
            GetClassName(hWnd, sb, 256);
            string cls = sb.ToString();
            if (cls == "TButton" || cls == "Button") {
                sb.Clear();
                GetWindowText(hWnd, sb, 256);
                string btnText = sb.ToString();
                foreach (string t in texts) {
                    if (btnText == t) { result = hWnd; return false; }
                }
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
"@

try {
    # Save cursor position so we can restore it after BM_CLICK interactions
    $savedCursor = New-Object PlaceCallReply+POINT
    [PlaceCallReply]::GetCursorPos([ref]$savedCursor) | Out-Null

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
        Write-Output '{"error":"Place Call dialog not found"}'
        exit 0
    }

    $dialogHwnd = [IntPtr]$dialog.Current.NativeWindowHandle

    # Keep dialog off-screen
    if ($dialogHwnd -ne [IntPtr]::Zero) {
        [PlaceCallReply]::HideOffScreen($dialogHwnd)
    }

    $replyControlHwnd = [IntPtr]::Zero
    $replyControlType = ""  # "listbox" or "combo"

    # 1) Check TListBox controls first — any listbox with items is a reply control
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
        $cnt = [PlaceCallReply]::GetListBoxCount($hw)
        if ($cnt -gt 0) {
            $replyControlHwnd = $hw
            $replyControlType = "listbox"
            break
        }
    }

    # 2) If no listbox, check TComboBox controls
    #    Skip the contacts combo by checking if it contains the contact we dialed.
    if ($replyControlHwnd -eq [IntPtr]::Zero) {
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
            $cnt = [PlaceCallReply]::GetComboCount($hw)
            if ($cnt -le 0) { continue }

            # If we know who we called, skip the combo that contains that name
            $isContactsCombo = $false
            if ($ContactName) {
                for ($i = 0; $i -lt $cnt; $i++) {
                    $text = [PlaceCallReply]::GetComboText($hw, $i)
                    if ($text -eq $ContactName) {
                        $isContactsCombo = $true
                        break
                    }
                }
            }
            if ($isContactsCombo) { continue }

            $replyControlHwnd = $hw
            $replyControlType = "combo"
            break
        }
    }

    if ($replyControlHwnd -eq [IntPtr]::Zero) {
        [PlaceCallReply]::HideOffScreen($dialogHwnd)
        Write-Output '{"error":"Reply control not found (no TListBox or TComboBox with reply items)"}'
        exit 0
    }

    # Find the "Send request/message" button
    $sendBtnCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        "Send request/message"
    )
    $sendBtn = $dialog.FindFirst(
        [System.Windows.Automation.TreeScope]::Descendants,
        $sendBtnCond
    )
    $sendBtnHwnd = if ($null -ne $sendBtn) { [IntPtr]$sendBtn.Current.NativeWindowHandle } else { [IntPtr]::Zero }

    if ($replyControlType -eq "listbox") {
        # For TListBox: use LB_SETCURSEL to select the item, then BM_CLICK Send button
        [PlaceCallReply]::SetListBoxSel($replyControlHwnd, $ReplyIndex)
        Start-Sleep -Milliseconds 100

        if ($sendBtnHwnd -ne [IntPtr]::Zero) {
            [PlaceCallReply]::SendMessage($sendBtnHwnd, [PlaceCallReply]::BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
        }
    } else {
        # For TComboBox: use CB_SETCURSEL to select the item, then BM_CLICK Send button
        [PlaceCallReply]::SendMessage($replyControlHwnd, 0x014E, [IntPtr]$ReplyIndex, [IntPtr]::Zero) | Out-Null  # CB_SETCURSEL
        Start-Sleep -Milliseconds 100

        if ($sendBtnHwnd -ne [IntPtr]::Zero) {
            [PlaceCallReply]::SendMessage($sendBtnHwnd, [PlaceCallReply]::BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
        }
    }

    # Poll for either a simple Yes/No confirmation dialog or a parameter dialog with edit box.
    # SimSig may show a "Confirmation required" Yes/No first, THEN a headcode entry dialog after.
    $paramDlg = [IntPtr]::Zero
    $confirmDlg = [IntPtr]::Zero
    for ($poll = 0; $poll -lt 40; $poll++) {
        Start-Sleep -Milliseconds 25
        # Check for parameter dialog (has TEdit for headcode entry)
        $paramDlg = [PlaceCallReply]::FindParameterDialog()
        if ($paramDlg -ne [IntPtr]::Zero) {
            [PlaceCallReply]::HideOffScreen($paramDlg)
            break
        }
        # Check for simple Yes/No confirmation dialog (no edit box)
        $confirmDlg = [PlaceCallReply]::FindConfirmationDialog()
        if ($confirmDlg -ne [IntPtr]::Zero) {
            [PlaceCallReply]::HideOffScreen($confirmDlg)
            break
        }
    }

    # Handle simple Yes/No confirmation first (e.g. "Confirmation required for this action")
    if ($confirmDlg -ne [IntPtr]::Zero) {
        $yesBtn = [PlaceCallReply]::FindButtonByAnyText($confirmDlg, @("Yes", "&Yes"))
        if ($yesBtn -ne [IntPtr]::Zero) {
            [PlaceCallReply]::SendMessage($yesBtn, [PlaceCallReply]::BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
        }
        Start-Sleep -Milliseconds 300

        # After dismissing confirmation, poll again for a parameter dialog (headcode entry)
        $paramDlg = [IntPtr]::Zero
        for ($poll = 0; $poll -lt 40; $poll++) {
            Start-Sleep -Milliseconds 25
            $paramDlg = [PlaceCallReply]::FindParameterDialog()
            if ($paramDlg -ne [IntPtr]::Zero) {
                [PlaceCallReply]::HideOffScreen($paramDlg)
                break
            }
        }
    }

    if ($paramDlg -ne [IntPtr]::Zero) {
        # Try to read the expected headcode from the dialog label ("Enter XXXX to confirm")
        $hc = if ($HeadCode -ne "") { $HeadCode } else { "0000" }
        $labelHc = ""
        [PlaceCallReply]::EnumChildWindows($paramDlg, [PlaceCallReply+EnumCallback]{
            param($h, $l)
            $sb2 = New-Object System.Text.StringBuilder 256
            [PlaceCallReply]::GetClassName($h, $sb2, 256) | Out-Null
            $cls2 = $sb2.ToString()
            if ($cls2 -eq "TLabel" -or $cls2 -eq "TStaticText" -or $cls2 -eq "Static") {
                $sb2.Clear()
                [PlaceCallReply]::GetWindowText($h, $sb2, 256) | Out-Null
                $ltxt = $sb2.ToString()
                if ($ltxt -match "Enter\s+(\S+)\s+to\s+confirm") {
                    $script:labelHc = $matches[1]
                }
            }
            return $true
        }, [IntPtr]::Zero) | Out-Null
        if ($labelHc -ne "") {
            $hc = $labelHc
            [Console]::Error.WriteLine("Extracted headcode from dialog label: $hc")
        }

        # Set headcode text directly on the TEdit control via WM_SETTEXT
        $editHwnd = [PlaceCallReply]::FindEditControl($paramDlg)
        if ($editHwnd -ne [IntPtr]::Zero) {
            [PlaceCallReply]::SetText($editHwnd, $hc)
            Start-Sleep -Milliseconds 100
            [PlaceCallReply]::FocusControl($paramDlg, $editHwnd)
            Start-Sleep -Milliseconds 50
        }
        # Click OK button via BM_CLICK
        $okBtn = [PlaceCallReply]::FindButtonByAnyText($paramDlg, @("OK", "Ok", "&OK", "Yes", "&Yes"))
        if ($okBtn -ne [IntPtr]::Zero) {
            [PlaceCallReply]::SendMessage($okBtn, [PlaceCallReply]::BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
        }
        Start-Sleep -Milliseconds 300

        # If dialog is still there, retry with keyboard Enter
        if ([PlaceCallReply]::IsWindowVisible($paramDlg)) {
            if ($editHwnd -ne [IntPtr]::Zero) {
                [PlaceCallReply]::SetText($editHwnd, $hc)
                Start-Sleep -Milliseconds 50
                [PlaceCallReply]::FocusControl($paramDlg, $editHwnd)
                Start-Sleep -Milliseconds 50
            }
            [PlaceCallReply]::SetForegroundWindow($paramDlg) | Out-Null
            Start-Sleep -Milliseconds 50
            [PlaceCallReply]::PressKey([PlaceCallReply]::VK_RETURN)
            Start-Sleep -Milliseconds 300
        }
    }

    # Poll for a second parameter dialog (e.g. platform number for Platform Alteration)
    $paramDlg2 = [IntPtr]::Zero
    for ($poll = 0; $poll -lt 40; $poll++) {
        Start-Sleep -Milliseconds 25
        $paramDlg2 = [PlaceCallReply]::FindParameterDialog()
        if ($paramDlg2 -ne [IntPtr]::Zero) {
            [PlaceCallReply]::HideOffScreen($paramDlg2)
            break
        }
    }

    if ($paramDlg2 -ne [IntPtr]::Zero) {
        $p2 = if ($Param2 -ne "") { $Param2 } else { "" }

        $editHwnd2 = [PlaceCallReply]::FindEditControl($paramDlg2)
        if ($editHwnd2 -ne [IntPtr]::Zero) {
            [PlaceCallReply]::SetText($editHwnd2, $p2)
            Start-Sleep -Milliseconds 100
            [PlaceCallReply]::FocusControl($paramDlg2, $editHwnd2)
            Start-Sleep -Milliseconds 50
        }
        $okBtn2 = [PlaceCallReply]::FindButtonByAnyText($paramDlg2, @("OK", "Ok", "&OK", "Yes", "&Yes"))
        if ($okBtn2 -ne [IntPtr]::Zero) {
            [PlaceCallReply]::SendMessage($okBtn2, [PlaceCallReply]::BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
        }
        Start-Sleep -Milliseconds 300

        # If dialog is still there, retry with keyboard Enter
        if ([PlaceCallReply]::IsWindowVisible($paramDlg2)) {
            if ($editHwnd2 -ne [IntPtr]::Zero) {
                [PlaceCallReply]::SetText($editHwnd2, $p2)
                Start-Sleep -Milliseconds 50
                [PlaceCallReply]::FocusControl($paramDlg2, $editHwnd2)
                Start-Sleep -Milliseconds 50
            }
            [PlaceCallReply]::SetForegroundWindow($paramDlg2) | Out-Null
            Start-Sleep -Milliseconds 50
            [PlaceCallReply]::PressKey([PlaceCallReply]::VK_RETURN)
            Start-Sleep -Milliseconds 300
        }
    }

    # Poll for any message/OK dialog and dismiss via BM_CLICK
    $msgDlg = [IntPtr]::Zero
    for ($poll = 0; $poll -lt 20; $poll++) {
        Start-Sleep -Milliseconds 25
        $msgDlg = [PlaceCallReply]::FindMessageDialog()
        if ($msgDlg -ne [IntPtr]::Zero) {
            [PlaceCallReply]::HideOffScreen($msgDlg)
            Start-Sleep -Milliseconds 50
            break
        }
    }
    if ($msgDlg -ne [IntPtr]::Zero) {
        $okBtn = [PlaceCallReply]::FindButtonByAnyText($msgDlg, @("OK", "Ok", "&OK", "Close"))
        if ($okBtn -ne [IntPtr]::Zero) {
            [PlaceCallReply]::SendMessage($okBtn, [PlaceCallReply]::BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
        }
        Start-Sleep -Milliseconds 300
    }

    # Wait a moment for SimSig to update the TMemo response
    Start-Sleep -Milliseconds 500

    # Read the TMemo response text
    $responseText = ""

    # Re-find the dialog in case it refreshed
    $dialog2 = $root.FindFirst(
        [System.Windows.Automation.TreeScope]::Children,
        $nameCond
    )

    if ($null -ne $dialog2) {
        $memoCond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ClassNameProperty,
            "TMemo"
        )
        $memo = $dialog2.FindFirst(
            [System.Windows.Automation.TreeScope]::Descendants,
            $memoCond
        )
        if ($null -ne $memo) {
            $responseText = $memo.Current.Name
        }

        # Keep dialog hidden
        $dh2 = [IntPtr]$dialog2.Current.NativeWindowHandle
        if ($dh2 -ne [IntPtr]::Zero) {
            [PlaceCallReply]::HideOffScreen($dh2)
        }
    }

    # Restore cursor to original position
    [PlaceCallReply]::SetCursorPos($savedCursor.X, $savedCursor.Y) | Out-Null

    $escapedResp = ($responseText -replace '\\', '\\\\' -replace '"', '\"' -replace "`n", '\n' -replace "`r", '')
    Write-Output "{`"success`":true,`"response`":`"$escapedResp`"}"
} catch {
    # Restore cursor on error too
    try { [PlaceCallReply]::SetCursorPos($savedCursor.X, $savedCursor.Y) | Out-Null } catch {}
    $escapedErr = ($_.Exception.Message -replace '\\', '\\\\' -replace '"', '\"' -replace "`n", ' ' -replace "`r", '')
    Write-Output "{`"error`":`"$escapedErr`"}"
}
