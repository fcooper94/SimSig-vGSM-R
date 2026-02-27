# reply-phone-call.ps1
# Selects a reply option in SimSig's Answer Call dialog and clicks Reply
# using physical mouse/keyboard simulation (same approach as place-call).
# Usage: powershell -File reply-phone-call.ps1 -ReplyIndex 0 [-HeadCode 1F32]

param(
    [int]$ReplyIndex = 0,
    [string]$HeadCode = ""
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class Win32Reply {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", EntryPoint = "SendMessage", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessageStr(IntPtr hWnd, int msg, IntPtr wParam, string lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumCallback callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr parent, EnumCallback callback, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxLength);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxLength);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int cmd);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    // Thread input attachment for cross-process SetFocus
    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    public static extern IntPtr SetFocus(IntPtr hWnd);

    public delegate bool EnumCallback(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP   = 0x0004;
    public const uint KEYEVENTF_KEYUP      = 0x0002;
    public const byte VK_DOWN = 0x28;
    public const byte VK_HOME = 0x24;
    public const int  LB_GETCOUNT = 0x018B;
    public const int  WM_SETTEXT  = 0x000C;
    public const int  SW_RESTORE  = 9;

    public static void ClickAt(int x, int y) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(50);
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(30);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, IntPtr.Zero);
    }

    public static void PressKey(byte vk) {
        keybd_event(vk, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(30);
        keybd_event(vk, 0, KEYEVENTF_KEYUP, IntPtr.Zero);
    }

    public static int GetListCount(IntPtr hWnd) {
        return (int)SendMessage(hWnd, LB_GETCOUNT, IntPtr.Zero, IntPtr.Zero);
    }

    public static void SetText(IntPtr hWnd, string text) {
        SendMessageStr(hWnd, WM_SETTEXT, IntPtr.Zero, text);
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

    // Find an edit control anywhere in the window hierarchy
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

    // Find a visible top-level window titled "Message" or "Confirmation" with an OK button
    public static IntPtr FindMessageDialog(string[] buttonTexts) {
        IntPtr result = IntPtr.Zero;
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            var sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            string title = sb.ToString();
            if (title == "Message" || title.Contains("onfirmation")) {
                IntPtr btn = FindButtonByText(hWnd, buttonTexts);
                if (btn != IntPtr.Zero) {
                    result = hWnd;
                    return false;
                }
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    // Find a visible top-level window with a TEdit child and "onfirmation" in title
    public static IntPtr FindConfirmationDialog() {
        IntPtr result = IntPtr.Zero;
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            var sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            string title = sb.ToString();
            if (title.Contains("onfirmation")) {
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

    // Find SimSig main window
    public static IntPtr FindSimSig() {
        IntPtr result = IntPtr.Zero;
        EnumWindows((hWnd, lParam) => {
            var sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            if (sb.ToString().StartsWith("SimSig -")) {
                result = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    // Find a top-level window by class name
    public static IntPtr FindTopWindowByClass(string className) {
        IntPtr result = IntPtr.Zero;
        EnumWindows((hWnd, lParam) => {
            var sb = new StringBuilder(256);
            GetClassName(hWnd, sb, 256);
            if (sb.ToString() == className) {
                result = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    // Find a top-level window by title
    public static IntPtr FindTopWindowByTitle(string title) {
        IntPtr result = IntPtr.Zero;
        EnumWindows((hWnd, lParam) => {
            var sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            if (sb.ToString() == title) {
                result = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    // Find a child window by class name
    public static IntPtr FindChildByClass(IntPtr parent, string className) {
        IntPtr result = IntPtr.Zero;
        EnumChildWindows(parent, (hWnd, lParam) => {
            var sb = new StringBuilder(256);
            GetClassName(hWnd, sb, 256);
            if (sb.ToString() == className) {
                result = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    // Find a child button by a single text label (strips & accelerator prefix)
    public static IntPtr FindButtonByLabel(IntPtr parent, string text) {
        IntPtr result = IntPtr.Zero;
        EnumChildWindows(parent, (hWnd, lParam) => {
            var sb = new StringBuilder(256);
            GetClassName(hWnd, sb, 256);
            string cls = sb.ToString();
            if (cls == "TButton" || cls == "Button") {
                sb.Clear();
                GetWindowText(hWnd, sb, 256);
                string btnText = sb.ToString().Replace("&", "");
                if (btnText.Equals(text, StringComparison.OrdinalIgnoreCase)) {
                    result = hWnd;
                    return false;
                }
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    // Find a child button by text (multiple options)
    public static IntPtr FindButtonByText(IntPtr parent, string[] texts) {
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
                    if (btnText == t) {
                        result = hWnd;
                        return false;
                    }
                }
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
"@

try {
    # Find the TAnswerCallForm dialog using pure Win32 API
    $dialogHwnd = [Win32Reply]::FindTopWindowByClass("TAnswerCallForm")

    if ($dialogHwnd -eq [IntPtr]::Zero) {
        Write-Output '{"error":"Answer dialog not found"}'
        exit 0
    }

    # Find the TListBox (reply options) child
    $listBoxHwnd = [Win32Reply]::FindChildByClass($dialogHwnd, "TListBox")

    if ($listBoxHwnd -eq [IntPtr]::Zero) {
        Write-Output '{"error":"Reply listbox not found"}'
        exit 0
    }

    # Find the Reply button child
    $replyBtnHwnd = [Win32Reply]::FindButtonByLabel($dialogHwnd, "Reply")

    if ($replyBtnHwnd -eq [IntPtr]::Zero) {
        Write-Output '{"error":"Reply button not found"}'
        exit 0
    }

    # Keep dialog off-screen — just restore and foreground for keyboard focus
    [Win32Reply]::ShowWindow($dialogHwnd, [Win32Reply]::SW_RESTORE) | Out-Null
    [Win32Reply]::SetForegroundWindow($dialogHwnd) | Out-Null
    Start-Sleep -Milliseconds 300

    # Focus the ListBox, select reply with Home + Down arrows
    [Win32Reply]::FocusControl($dialogHwnd, $listBoxHwnd)
    Start-Sleep -Milliseconds 150
    [Win32Reply]::PressKey([Win32Reply]::VK_HOME)
    Start-Sleep -Milliseconds 150

    for ($i = 0; $i -lt $ReplyIndex; $i++) {
        [Win32Reply]::PressKey([Win32Reply]::VK_DOWN)
        Start-Sleep -Milliseconds 100
    }
    Start-Sleep -Milliseconds 150

    # Press Enter to click Reply, then poll rapidly to catch confirmation dialog before it renders
    [Win32Reply]::PressKey(0x0D)  # VK_RETURN
    $confirmDlg = [IntPtr]::Zero
    for ($poll = 0; $poll -lt 40; $poll++) {
        Start-Sleep -Milliseconds 25
        $confirmDlg = [Win32Reply]::FindConfirmationDialog()
        if ($confirmDlg -ne [IntPtr]::Zero) {
            [Win32Reply]::HideOffScreen($confirmDlg)
            [Win32Reply]::SetForegroundWindow($confirmDlg) | Out-Null
            Start-Sleep -Milliseconds 100
            break
        }
    }

    # Type headcode and press Enter
    Add-Type -AssemblyName System.Windows.Forms
    $hc = if ($HeadCode -ne "") { $HeadCode } else { "0000" }
    [System.Windows.Forms.SendKeys]::SendWait($hc)
    Start-Sleep -Milliseconds 500
    [Win32Reply]::PressKey(0x0D)  # VK_RETURN

    # Poll for message/OK dialog and hide instantly
    $msgDlg = [IntPtr]::Zero
    for ($poll = 0; $poll -lt 40; $poll++) {
        Start-Sleep -Milliseconds 25
        $msgDlg = [Win32Reply]::FindMessageDialog(@("OK", "Ok", "&OK", "Close"))
        if ($msgDlg -ne [IntPtr]::Zero) {
            [Win32Reply]::HideOffScreen($msgDlg)
            [Win32Reply]::SetForegroundWindow($msgDlg) | Out-Null
            Start-Sleep -Milliseconds 100
            break
        }
    }
    [Win32Reply]::PressKey(0x0D)  # VK_RETURN

    # Poll for any second message dialog
    $msgDlg2 = [IntPtr]::Zero
    for ($poll = 0; $poll -lt 20; $poll++) {
        Start-Sleep -Milliseconds 25
        $msgDlg2 = [Win32Reply]::FindMessageDialog(@("OK", "Ok", "&OK", "Close"))
        if ($msgDlg2 -ne [IntPtr]::Zero) {
            [Win32Reply]::HideOffScreen($msgDlg2)
            [Win32Reply]::SetForegroundWindow($msgDlg2) | Out-Null
            Start-Sleep -Milliseconds 100
            break
        }
    }
    [Win32Reply]::PressKey(0x0D)  # VK_RETURN
    Start-Sleep -Milliseconds 300

    # Soft close: if TAnswerCallForm is still open, try Escape then hide off-screen
    Start-Sleep -Milliseconds 300
    $aHwnd = [Win32Reply]::FindTopWindowByClass("TAnswerCallForm")
    if ($aHwnd -ne [IntPtr]::Zero) {
        [Win32Reply]::SetForegroundWindow($aHwnd) | Out-Null
        Start-Sleep -Milliseconds 100
        [Win32Reply]::PressKey(0x1B)  # VK_ESCAPE
        Start-Sleep -Milliseconds 500

        # Check if it closed — if not, hide off-screen
        $aHwnd2 = [Win32Reply]::FindTopWindowByClass("TAnswerCallForm")
        if ($aHwnd2 -ne [IntPtr]::Zero) {
            [Win32Reply]::HideOffScreen($aHwnd2)
        }
    }

    # Hide any lingering Place Call dialog
    $pcHwnd = [Win32Reply]::FindTopWindowByTitle("Place Call")
    if ($pcHwnd -ne [IntPtr]::Zero) {
        [Win32Reply]::HideOffScreen($pcHwnd)
    }

    # Check if the Telephone Calls window is still open
    Start-Sleep -Milliseconds 300
    $telHwnd = [Win32Reply]::FindTopWindowByClass("TTelephoneForm")

    if ($telHwnd -eq [IntPtr]::Zero) {
        # Window closed — send F6 to SimSig's main window to reopen it
        $simHwnd = [Win32Reply]::FindSimSig()
        if ($simHwnd -ne [IntPtr]::Zero) {
            [Win32Reply]::PostMessage($simHwnd, 0x0100, [IntPtr]0x75, [IntPtr]::Zero) | Out-Null
            Start-Sleep -Milliseconds 50
            [Win32Reply]::PostMessage($simHwnd, 0x0101, [IntPtr]0x75, [IntPtr]::Zero) | Out-Null
            Start-Sleep -Milliseconds 500
            $telHwnd2 = [Win32Reply]::FindTopWindowByClass("TTelephoneForm")
            if ($telHwnd2 -ne [IntPtr]::Zero) {
                [Win32Reply]::HideOffScreen($telHwnd2)
            }
        }
    } else {
        [Win32Reply]::HideOffScreen($telHwnd)
    }

    Write-Output '{"success":true}'
} catch {
    Write-Output "{`"error`":`"$($_.Exception.Message)`"}"
}
