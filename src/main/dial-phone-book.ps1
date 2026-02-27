# dial-phone-book.ps1
# Opens SimSig's "Place Call" dialog, selects a contact by index
# in the ComboBox, and clicks Dial.
# Usage: powershell -File dial-phone-book.ps1 -Index 0

param(
    [int]$Index = 0
)

Add-Type -AssemblyName UIAutomationClient | Out-Null
Add-Type -AssemblyName UIAutomationTypes | Out-Null

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class PhoneBookDial {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", EntryPoint = "SendMessage", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessageSb(IntPtr hWnd, int msg, IntPtr wParam, StringBuilder lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    public static extern int GetDlgCtrlID(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetParent(IntPtr hWnd);

    public const int CB_SETCURSEL = 0x014E;
    public const int CB_GETCOUNT = 0x0146;
    public const int CB_GETLBTEXT = 0x0148;
    public const int CB_GETLBTEXTLEN = 0x0149;
    public const int BM_CLICK = 0x00F5;
    public const uint WM_KEYDOWN = 0x0100;
    public const uint WM_KEYUP = 0x0101;
    public const int WM_COMMAND = 0x0111;
    public const int WM_CLOSE = 0x0010;
    public const int VK_O = 0x4F;
    public const int CBN_SELCHANGE = 1;

    public static void SelectComboItem(IntPtr hWnd, int index) {
        SendMessage(hWnd, CB_SETCURSEL, (IntPtr)index, IntPtr.Zero);
        // Notify the parent (Delphi TComboBox needs CBN_SELCHANGE to update internally)
        IntPtr parent = GetParent(hWnd);
        int ctrlId = GetDlgCtrlID(hWnd);
        IntPtr wParam = (IntPtr)((CBN_SELCHANGE << 16) | (ctrlId & 0xFFFF));
        SendMessage(parent, WM_COMMAND, wParam, hWnd);
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

    public static void ClickButton(IntPtr hWnd) {
        SendMessage(hWnd, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
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

    public static void SendKey(IntPtr hWnd, int vk) {
        PostMessage(hWnd, WM_KEYDOWN, (IntPtr)vk, IntPtr.Zero);
        PostMessage(hWnd, WM_KEYUP, (IntPtr)vk, IntPtr.Zero);
    }

    public static void HideOffScreen(IntPtr hWnd) {
        SetWindowPos(hWnd, IntPtr.Zero, -32000, -32000, 0, 0, 0x0001 | 0x0004 | 0x0010);
    }
}
"@

try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement

    # Find SimSig main window
    [PhoneBookDial]::FindSimSig()
    if ([PhoneBookDial]::simsigHwnd -eq [IntPtr]::Zero) {
        Write-Output '{"error":"SimSig not found"}'
        exit 0
    }

    # Check if Place Call dialog is already open
    $nameCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        "Place Call"
    )
    $placeCallDialog = $root.FindFirst(
        [System.Windows.Automation.TreeScope]::Children,
        $nameCond
    )

    # If not open, send 'O' key via PostMessage
    if ($null -eq $placeCallDialog) {
        [PhoneBookDial]::SendKey([PhoneBookDial]::simsigHwnd, [PhoneBookDial]::VK_O)
        Start-Sleep -Milliseconds 800

        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            Start-Sleep -Milliseconds 100
            $placeCallDialog = $root.FindFirst(
                [System.Windows.Automation.TreeScope]::Children,
                $nameCond
            )
            if ($null -ne $placeCallDialog) { break }
        }
    }

    if ($null -eq $placeCallDialog) {
        Write-Output '{"error":"Place Call dialog not found"}'
        exit 0
    }

    # Hide dialog off-screen
    $dialogHwnd = [IntPtr]$placeCallDialog.Current.NativeWindowHandle
    if ($dialogHwnd -ne [IntPtr]::Zero) {
        [void][PhoneBookDial]::HideOffScreen($dialogHwnd)
    }

    # Find the contacts ComboBox (the one whose first item isn't a request keyword)
    # FindFirst doesn't guarantee visual order in UI Automation
    $comboCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ClassNameProperty,
        "TComboBox"
    )
    $allCombos = $placeCallDialog.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        $comboCond
    )

    $bestHwnd = [IntPtr]::Zero
    foreach ($combo in $allCombos) {
        $hw = [IntPtr]$combo.Current.NativeWindowHandle
        if ($hw -eq [IntPtr]::Zero) { continue }
        $cnt = [PhoneBookDial]::GetComboCount($hw)
        if ($cnt -gt 0) {
            $firstItem = [PhoneBookDial]::GetComboText($hw, 0)
            if ($firstItem -and $firstItem -notmatch "^(Request|Message|Send|Cancel|Pass|Hold|Block|Continue)") {
                $bestHwnd = $hw
                break
            }
        }
    }

    if ($bestHwnd -eq [IntPtr]::Zero) {
        Write-Output '{"error":"ComboBox not found"}'
        exit 0
    }

    $bestCount = [PhoneBookDial]::GetComboCount($bestHwnd)

    if ($Index -ge $bestCount) {
        Write-Output '{"error":"Contact index out of range"}'
        exit 0
    }

    # Select the contact
    [PhoneBookDial]::SelectComboItem($bestHwnd, $Index)
    Start-Sleep -Milliseconds 100

    # Find and click the Dial button
    $dialBtnCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        "Dial"
    )
    $dialBtn = $placeCallDialog.FindFirst(
        [System.Windows.Automation.TreeScope]::Descendants,
        $dialBtnCond
    )

    if ($null -eq $dialBtn) {
        Write-Output '{"error":"Dial button not found"}'
        exit 0
    }

    $dialBtnHwnd = [IntPtr]$dialBtn.Current.NativeWindowHandle
    [PhoneBookDial]::ClickButton($dialBtnHwnd)

    Write-Output '{"success":true}'
} catch {
    Write-Output "{`"error`":`"$($_.Exception.Message)`"}"
}
