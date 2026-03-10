# force-close-call.ps1
# Dismisses the TAnswerCallForm without clicking "Answer call" on TTelephoneForm.
# Used for force-close only — avoids consuming the next queued call from SimSig.

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class ForceClose {
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumCallback callback, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxLength);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxLength);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);

    public delegate bool EnumCallback(IntPtr hWnd, IntPtr lParam);

    public const byte VK_ESCAPE = 0x1B;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const int VK_F6 = 0x75;
    public const uint WM_KEYDOWN = 0x0100;
    public const uint WM_KEYUP = 0x0101;

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

$answerHwnd = [ForceClose]::FindByClass("TAnswerCallForm")
if ($answerHwnd -eq [IntPtr]::Zero) {
    Write-Output '{"success":true,"action":"none"}'
    exit 0
}

# Step 1: Try WM_CLOSE directly (dialog is responsive during an active call)
[ForceClose]::PostMessage($answerHwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
Start-Sleep -Milliseconds 500

# Step 2: If still there, try Escape key
$answerHwnd2 = [ForceClose]::FindByClass("TAnswerCallForm")
if ($answerHwnd2 -ne [IntPtr]::Zero) {
    [ForceClose]::SetForegroundWindow($answerHwnd2)
    Start-Sleep -Milliseconds 100
    [ForceClose]::PressKey([ForceClose]::VK_ESCAPE)
    Start-Sleep -Milliseconds 500
}

# Step 3: If STILL there, hide off-screen as last resort
$answerHwnd3 = [ForceClose]::FindByClass("TAnswerCallForm")
if ($answerHwnd3 -ne [IntPtr]::Zero) {
    [ForceClose]::HideOffScreen($answerHwnd3)
}

# Step 4: Ensure Telephone Calls window is open and hidden off-screen
$teleHwnd = [ForceClose]::FindByClass("TTelephoneForm")
if ($teleHwnd -eq [IntPtr]::Zero) {
    $simsig = [ForceClose]::FindSimSig()
    if ($simsig -ne [IntPtr]::Zero) {
        [ForceClose]::PostMessage($simsig, [ForceClose]::WM_KEYDOWN, [IntPtr]([ForceClose]::VK_F6), [IntPtr]::Zero) | Out-Null
        [ForceClose]::PostMessage($simsig, [ForceClose]::WM_KEYUP, [IntPtr]([ForceClose]::VK_F6), [IntPtr]::Zero) | Out-Null
        Start-Sleep -Milliseconds 500
        $teleHwnd = [ForceClose]::FindByClass("TTelephoneForm")
    }
}
if ($teleHwnd -ne [IntPtr]::Zero) {
    [ForceClose]::HideOffScreen($teleHwnd)
}

Write-Output '{"success":true,"action":"closed"}'
