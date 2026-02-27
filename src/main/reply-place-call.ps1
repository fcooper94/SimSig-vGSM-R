# reply-place-call.ps1
# Uses UI Automation to find the reply ComboBox (same approach as read-place-call.ps1).
# Selects reply via keyboard (Home + Down keys), Tab to Send button, Enter.
# If a parameter dialog appears (e.g. "Enter train"), types headcode and presses Enter.
# After sending, reads the TMemo response text and returns it.
#
# Usage: powershell -File reply-place-call.ps1 -ReplyIndex 0 [-HeadCode 1F32]

param(
    [int]$ReplyIndex = 0,
    [string]$HeadCode = ""
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

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

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
    public const byte VK_DOWN  = 0x28;
    public const byte VK_HOME  = 0x24;
    public const byte VK_TAB   = 0x09;
    public const byte VK_RETURN = 0x0D;
    public const int CB_GETCOUNT    = 0x0146;
    public const int CB_GETLBTEXT   = 0x0148;
    public const int CB_GETLBTEXTLEN = 0x0149;
    public const int BM_CLICK = 0x00F5;
    public const int SW_RESTORE = 9;

    public static void PressKey(byte vk) {
        keybd_event(vk, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(30);
        keybd_event(vk, 0, KEYEVENTF_KEYUP, IntPtr.Zero);
    }

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

    # Find all TComboBox controls via UI Automation
    $comboCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ClassNameProperty,
        "TComboBox"
    )
    $allCombos = $dialog.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        $comboCond
    )

    # Check if "Send request/message" button exists (confirms we're connected)
    $sendBtnCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        "Send request/message"
    )
    $sendBtn = $dialog.FindFirst(
        [System.Windows.Automation.TreeScope]::Descendants,
        $sendBtnCond
    )

    # Identify the reply ComboBox by content — first item starts with reply keywords
    $replyKeywords = "^(Request|Message|Send|Cancel|Pass|Hold|Block|Continue|Ask|Authoris|Please)"
    $replyComboHwnd = [IntPtr]::Zero
    $replyCount = 0

    foreach ($combo in $allCombos) {
        $hw = [IntPtr]$combo.Current.NativeWindowHandle
        if ($hw -eq [IntPtr]::Zero) { continue }
        $cnt = [PlaceCallReply]::GetComboCount($hw)
        if ($cnt -gt 0) {
            $firstItem = [PlaceCallReply]::GetComboText($hw, 0)
            if ($firstItem -match $replyKeywords) {
                $replyComboHwnd = $hw
                $replyCount = $cnt
                break
            }
        }
    }

    # Fallback: if keyword match failed but Send button exists, pick combo with longest first item
    if ($replyComboHwnd -eq [IntPtr]::Zero -and $null -ne $sendBtn -and $allCombos.Count -ge 2) {
        foreach ($combo in $allCombos) {
            $hw = [IntPtr]$combo.Current.NativeWindowHandle
            if ($hw -eq [IntPtr]::Zero) { continue }
            $cnt = [PlaceCallReply]::GetComboCount($hw)
            if ($cnt -gt 0) {
                $firstItem = [PlaceCallReply]::GetComboText($hw, 0)
                if ($firstItem.Length -gt 20) {
                    $replyComboHwnd = $hw
                    $replyCount = $cnt
                    break
                }
            }
        }
    }

    if ($replyComboHwnd -eq [IntPtr]::Zero) {
        # Debug: dump all combo info
        $debugParts = @("combos=$($allCombos.Count)")
        $ci = 0
        foreach ($combo in $allCombos) {
            $hw = [IntPtr]$combo.Current.NativeWindowHandle
            if ($hw -eq [IntPtr]::Zero) { $ci++; continue }
            $cnt = [PlaceCallReply]::GetComboCount($hw)
            $first = ""
            if ($cnt -gt 0) { $first = [PlaceCallReply]::GetComboText($hw, 0) }
            $debugParts += "c${ci}=${cnt}items"
            if ($first) { $debugParts += "c${ci}first=$first" }
            $ci++
        }
        $debugStr = ($debugParts -join "; ") -replace '"', "'" -replace "`n", " " -replace "`r", ""
        [PlaceCallReply]::HideOffScreen($dialogHwnd)
        Write-Output "{`"error`":`"Reply ComboBox not found`",`"debug`":`"$debugStr`"}"
        exit 0
    }

    # Restore & foreground the dialog for keyboard focus (stays off-screen)
    [PlaceCallReply]::ShowWindow($dialogHwnd, 9) | Out-Null
    [PlaceCallReply]::SetForegroundWindow($dialogHwnd) | Out-Null
    Start-Sleep -Milliseconds 200

    # Focus the reply ComboBox and navigate to the desired index
    [PlaceCallReply]::FocusControl($dialogHwnd, $replyComboHwnd)
    Start-Sleep -Milliseconds 100
    [PlaceCallReply]::PressKey([PlaceCallReply]::VK_HOME)
    Start-Sleep -Milliseconds 50

    for ($i = 0; $i -lt $ReplyIndex; $i++) {
        [PlaceCallReply]::PressKey([PlaceCallReply]::VK_DOWN)
        Start-Sleep -Milliseconds 50
    }

    # Tab to the "Send request/message" button and press Enter
    [PlaceCallReply]::PressKey([PlaceCallReply]::VK_TAB)
    Start-Sleep -Milliseconds 100
    [PlaceCallReply]::PressKey([PlaceCallReply]::VK_RETURN)

    # Poll for parameter dialog (e.g. "Confirmation required" with edit box for headcode)
    Add-Type -AssemblyName System.Windows.Forms
    $paramDlg = [IntPtr]::Zero
    for ($poll = 0; $poll -lt 40; $poll++) {
        Start-Sleep -Milliseconds 25
        $paramDlg = [PlaceCallReply]::FindParameterDialog()
        if ($paramDlg -ne [IntPtr]::Zero) {
            [PlaceCallReply]::HideOffScreen($paramDlg)
            [PlaceCallReply]::SetForegroundWindow($paramDlg) | Out-Null
            Start-Sleep -Milliseconds 100
            break
        }
    }

    if ($paramDlg -ne [IntPtr]::Zero) {
        $hc = if ($HeadCode -ne "") { $HeadCode } else { "0000" }
        [System.Windows.Forms.SendKeys]::SendWait($hc)
        Start-Sleep -Milliseconds 300
        [PlaceCallReply]::PressKey([PlaceCallReply]::VK_RETURN)
    }

    # Poll for any message/OK dialog and dismiss it
    $msgDlg = [IntPtr]::Zero
    for ($poll = 0; $poll -lt 20; $poll++) {
        Start-Sleep -Milliseconds 25
        $msgDlg = [PlaceCallReply]::FindMessageDialog()
        if ($msgDlg -ne [IntPtr]::Zero) {
            [PlaceCallReply]::HideOffScreen($msgDlg)
            [PlaceCallReply]::SetForegroundWindow($msgDlg) | Out-Null
            Start-Sleep -Milliseconds 100
            break
        }
    }
    if ($msgDlg -ne [IntPtr]::Zero) {
        [PlaceCallReply]::PressKey([PlaceCallReply]::VK_RETURN)
        Start-Sleep -Milliseconds 300
    }

    # Wait a moment for SimSig to update the TMemo response
    Start-Sleep -Milliseconds 500

    # Read the TMemo response text (same approach as read-place-call.ps1)
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

    $result = @{
        success  = $true
        response = $responseText
    }
    $json = $result | ConvertTo-Json -Compress -Depth 3
    Write-Output $json
} catch {
    Write-Output "{`"error`":`"$($_.Exception.Message)`"}"
}
