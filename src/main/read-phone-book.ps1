# read-phone-book.ps1
# Opens SimSig's "Place Call" dialog (O key), reads the ComboBox
# dropdown items, closes the dialog, and outputs JSON.

Add-Type -AssemblyName UIAutomationClient | Out-Null
Add-Type -AssemblyName UIAutomationTypes | Out-Null

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class PhoneBook {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, StringBuilder lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    public const int CB_GETCOUNT = 0x0146;
    public const int CB_GETLBTEXT = 0x0148;
    public const int CB_GETLBTEXTLEN = 0x0149;
    public const uint WM_KEYDOWN = 0x0100;
    public const uint WM_KEYUP = 0x0101;
    public const int WM_CLOSE = 0x0010;
    public const int VK_O = 0x4F;

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

    public static void CloseWindow(IntPtr hWnd) {
        PostMessage(hWnd, (uint)WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
    }
}
"@

try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement

    # Find SimSig main window
    [PhoneBook]::FindSimSig()
    if ([PhoneBook]::simsigHwnd -eq [IntPtr]::Zero) {
        Write-Output '{"error":"SimSig not found","contacts":[]}'
        exit 0
    }

    # Send 'O' key via PostMessage (no need to bring SimSig to foreground)
    [PhoneBook]::SendKey([PhoneBook]::simsigHwnd, [PhoneBook]::VK_O)
    Start-Sleep -Milliseconds 800

    # Wait for Place Call dialog to appear (up to 3 seconds)
    $placeCallDialog = $null
    $nameCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        "Place Call"
    )
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 100
        $placeCallDialog = $root.FindFirst(
            [System.Windows.Automation.TreeScope]::Children,
            $nameCond
        )
        if ($null -ne $placeCallDialog) { break }
    }

    if ($null -eq $placeCallDialog) {
        Write-Output '{"error":"Place Call dialog not found","contacts":[]}'
        exit 0
    }

    # Hide dialog off-screen immediately
    $dialogHwnd = [IntPtr]$placeCallDialog.Current.NativeWindowHandle
    if ($dialogHwnd -ne [IntPtr]::Zero) {
        [void][PhoneBook]::HideOffScreen($dialogHwnd)
    }

    # Find ALL TComboBox controls — use the one with items that look like contacts
    # (FindFirst doesn't guarantee visual order in UI Automation)
    $comboCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ClassNameProperty,
        "TComboBox"
    )
    $allCombos = $placeCallDialog.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        $comboCond
    )

    $contacts = @()
    foreach ($combo in $allCombos) {
        $hw = [IntPtr]$combo.Current.NativeWindowHandle
        if ($hw -eq [IntPtr]::Zero) { continue }
        $cnt = [PhoneBook]::GetComboCount($hw)
        if ($cnt -gt 0) {
            # Check if first item looks like a contact (not a request/message keyword)
            $firstItem = [PhoneBook]::GetComboText($hw, 0)
            if ($firstItem -and $firstItem -notmatch "^(Request|Message|Send|Cancel|Pass|Hold|Block|Continue)") {
                for ($i = 0; $i -lt $cnt; $i++) {
                    $text = [PhoneBook]::GetComboText($hw, $i)
                    if ($text) { $contacts += $text }
                }
                break
            }
        }
    }

    # Close the Place Call dialog
    if ($dialogHwnd -ne [IntPtr]::Zero) {
        [PhoneBook]::CloseWindow($dialogHwnd)
    }

    $result = @{ contacts = $contacts }
    if ($contacts.Count -eq 0) {
        $result.contacts = @()
    }
    $json = $result | ConvertTo-Json -Compress -Depth 3
    Write-Output $json
} catch {
    Write-Output "{`"error`":`"$($_.Exception.Message)`",`"contacts`":[]}"
}
