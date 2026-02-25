# toggle-pause.ps1
# Clicks the SimSig clock twice to trigger pause then unpause,
# then sends F6 to open the Telephone Calls dialog if it isn't already open.
# The clock is a lightweight Delphi control (no HWND), so we click by position.

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class Win32Clock {
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    public const uint WM_LBUTTONDOWN = 0x0201;
    public const uint WM_LBUTTONUP = 0x0202;
    public const uint WM_KEYDOWN = 0x0100;
    public const uint WM_KEYUP = 0x0101;
    public const int VK_F6 = 0x75;

    public static void ClickClient(IntPtr hWnd, int clientX, int clientY) {
        IntPtr lParam = (IntPtr)((clientY << 16) | (clientX & 0xFFFF));
        SendMessage(hWnd, WM_LBUTTONDOWN, IntPtr.Zero, lParam);
        SendMessage(hWnd, WM_LBUTTONUP, IntPtr.Zero, lParam);
    }

    public static void SendF6(IntPtr hWnd) {
        PostMessage(hWnd, WM_KEYDOWN, (IntPtr)VK_F6, IntPtr.Zero);
        PostMessage(hWnd, WM_KEYUP, (IntPtr)VK_F6, IntPtr.Zero);
    }

    public static IntPtr simsigHwnd = IntPtr.Zero;
    private static EnumWindowsProc _callback;
    public static void FindSimSig() {
        simsigHwnd = IntPtr.Zero;
        _callback = (hWnd, lParam) => {
            StringBuilder sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            if (sb.ToString().StartsWith("SimSig -")) {
                simsigHwnd = hWnd;
                return false;
            }
            return true;
        };
        EnumWindows(_callback, IntPtr.Zero);
    }
}
"@

try {
    [Win32Clock]::FindSimSig()
    $winHwnd = [Win32Clock]::simsigHwnd
    if ($winHwnd -eq [IntPtr]::Zero) { exit 0 }

    # Click the clock at (150, 55) in client coordinates to pause
    [Win32Clock]::ClickClient($winHwnd, 150, 55)
    Start-Sleep -Milliseconds 200
    # Click again to unpause
    [Win32Clock]::ClickClient($winHwnd, 150, 55)

    # Open Telephone Calls dialog (F6) if not already open
    Start-Sleep -Milliseconds 300
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $teleCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        "Telephone Calls"
    )
    $teleWin = $root.FindFirst(
        [System.Windows.Automation.TreeScope]::Children,
        $teleCond
    )
    if ($null -eq $teleWin) {
        $classCond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ClassNameProperty,
            "TTelephoneForm"
        )
        $teleWin = $root.FindFirst(
            [System.Windows.Automation.TreeScope]::Children,
            $classCond
        )
    }
    if ($null -eq $teleWin) {
        [Win32Clock]::SendF6($winHwnd)
    }
} catch {}
