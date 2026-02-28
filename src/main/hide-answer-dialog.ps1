# hide-answer-dialog.ps1
# Dismisses any lingering TAnswerCallForm after hang-up.
# The dialog only becomes responsive after clicking "Answer call" on the
# TTelephoneForm, so we click that first, then press Escape to close it.
# Finally ensures the Telephone Calls window is re-opened for new calls.

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class HideAnswer {
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumCallback callback, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr parent, EnumCallback callback, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxLength);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxLength);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    public delegate bool EnumCallback(IntPtr hWnd, IntPtr lParam);

    public const uint WM_KEYDOWN = 0x0100;
    public const uint WM_KEYUP = 0x0101;
    public const int VK_F6 = 0x75;
    public const byte VK_ESCAPE = 0x1B;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const int SW_RESTORE = 9;
    public const int BM_CLICK = 0x00F5;

    public static IntPtr FindByClass(string cls) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hWnd, lParam) => {
            var sb = new StringBuilder(256);
            GetClassName(hWnd, sb, 256);
            if (sb.ToString() == cls) { found = hWnd; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static IntPtr FindSimSig() {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hWnd, lParam) => {
            var sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            if (sb.ToString().StartsWith("SimSig -")) { found = hWnd; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static IntPtr FindButtonByText(IntPtr parent, string text) {
        IntPtr found = IntPtr.Zero;
        EnumChildWindows(parent, (hWnd, lParam) => {
            var cls = new StringBuilder(256);
            GetClassName(hWnd, cls, 256);
            if (cls.ToString() == "TButton" || cls.ToString() == "TBitBtn") {
                var txt = new StringBuilder(256);
                GetWindowText(hWnd, txt, 256);
                string btnText = txt.ToString().Replace("&", "");
                if (btnText.Equals(text, StringComparison.OrdinalIgnoreCase)) {
                    found = hWnd;
                    return false;
                }
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static void HideOffScreen(IntPtr hWnd) {
        SetWindowPos(hWnd, IntPtr.Zero, -32000, -32000, 0, 0, 0x0001 | 0x0004 | 0x0010);
    }

    public static void PressKey(byte vk) {
        keybd_event(vk, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(30);
        keybd_event(vk, 0, KEYEVENTF_KEYUP, IntPtr.Zero);
    }
}
"@

$answerHwnd = [HideAnswer]::FindByClass("TAnswerCallForm")
if ($answerHwnd -eq [IntPtr]::Zero) {
    Write-Output '{"success":true,"action":"none"}'
    exit 0
}

# Step 1: Click "Answer call" on TTelephoneForm to make the dialog responsive
$teleHwnd = [HideAnswer]::FindByClass("TTelephoneForm")
if ($teleHwnd -eq [IntPtr]::Zero) {
    # Re-open telephone window via F6
    $simsig = [HideAnswer]::FindSimSig()
    if ($simsig -ne [IntPtr]::Zero) {
        [HideAnswer]::PostMessage($simsig, [HideAnswer]::WM_KEYDOWN, [IntPtr]([HideAnswer]::VK_F6), [IntPtr]::Zero) | Out-Null
        [HideAnswer]::PostMessage($simsig, [HideAnswer]::WM_KEYUP, [IntPtr]([HideAnswer]::VK_F6), [IntPtr]::Zero) | Out-Null
        Start-Sleep -Milliseconds 500
        $teleHwnd = [HideAnswer]::FindByClass("TTelephoneForm")
    }
}

if ($teleHwnd -ne [IntPtr]::Zero) {
    $answerBtn = [HideAnswer]::FindButtonByText($teleHwnd, "Answer call")
    if ($answerBtn -ne [IntPtr]::Zero) {
        [HideAnswer]::SendMessage($answerBtn, [HideAnswer]::BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
        Start-Sleep -Milliseconds 500
    }
}

# Step 2: The TAnswerCallForm should now be responsive — try to close it
$answerHwnd2 = [HideAnswer]::FindByClass("TAnswerCallForm")
if ($answerHwnd2 -ne [IntPtr]::Zero) {
    # Send WM_CLOSE first; if that doesn't work, hide off-screen
    [HideAnswer]::PostMessage($answerHwnd2, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    Start-Sleep -Milliseconds 500

    # Fallback: hide off-screen if still there
    $answerHwnd3 = [HideAnswer]::FindByClass("TAnswerCallForm")
    if ($answerHwnd3 -ne [IntPtr]::Zero) {
        [HideAnswer]::HideOffScreen($answerHwnd3)
    }
}

# Step 3: Ensure Telephone Calls window is open and hidden off-screen
$teleHwnd2 = [HideAnswer]::FindByClass("TTelephoneForm")
if ($teleHwnd2 -eq [IntPtr]::Zero) {
    $simsig = [HideAnswer]::FindSimSig()
    if ($simsig -ne [IntPtr]::Zero) {
        [HideAnswer]::PostMessage($simsig, [HideAnswer]::WM_KEYDOWN, [IntPtr]([HideAnswer]::VK_F6), [IntPtr]::Zero) | Out-Null
        [HideAnswer]::PostMessage($simsig, [HideAnswer]::WM_KEYUP, [IntPtr]([HideAnswer]::VK_F6), [IntPtr]::Zero) | Out-Null
        Start-Sleep -Milliseconds 500
        $teleHwnd2 = [HideAnswer]::FindByClass("TTelephoneForm")
    }
}
if ($teleHwnd2 -ne [IntPtr]::Zero) {
    [HideAnswer]::HideOffScreen($teleHwnd2)
}

Write-Output '{"success":true,"action":"closed"}'
