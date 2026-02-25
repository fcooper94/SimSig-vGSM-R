# toggle-pause.ps1
# Clicks the SimSig clock twice to trigger pause then unpause.
# The clock is a lightweight Delphi control (no HWND), so we click by position.

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

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);

    [DllImport("user32.dll")]
    public static extern bool ScreenToClient(IntPtr hWnd, ref POINT lpPoint);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr FindWindowEx(IntPtr hWndParent, IntPtr hWndChildAfter, string lpszClass, string lpszWindow);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    public const uint WM_LBUTTONDOWN = 0x0201;
    public const uint WM_LBUTTONUP = 0x0202;

    public static void ClickClient(IntPtr hWnd, int clientX, int clientY) {
        IntPtr lParam = (IntPtr)((clientY << 16) | (clientX & 0xFFFF));
        SendMessage(hWnd, WM_LBUTTONDOWN, IntPtr.Zero, lParam);
        SendMessage(hWnd, WM_LBUTTONUP, IntPtr.Zero, lParam);
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

    public static string GetClass(IntPtr hWnd) {
        StringBuilder sb = new StringBuilder(256);
        GetClassName(hWnd, sb, 256);
        return sb.ToString();
    }
}
"@

try {
    # Find the SimSig main window
    [Win32Clock]::FindSimSig()
    $winHwnd = [Win32Clock]::simsigHwnd

    if ($winHwnd -eq [IntPtr]::Zero) {
        Write-Output "NO_WINDOW"
        exit 0
    }

    # Log what we found
    $sb = New-Object System.Text.StringBuilder 256
    [Win32Clock]::GetWindowText($winHwnd, $sb, 256) | Out-Null
    Write-Output "WINDOW: '$($sb.ToString())' hwnd=$winHwnd"

    # Enumerate immediate children via FindWindowEx
    $child = [IntPtr]::Zero
    $childCount = 0
    do {
        $child = [Win32Clock]::FindWindowEx($winHwnd, $child, $null, $null)
        if ($child -ne [IntPtr]::Zero) {
            $childCount++
            $cClass = [Win32Clock]::GetClass($child)
            $cSb = New-Object System.Text.StringBuilder 256
            [Win32Clock]::GetWindowText($child, $cSb, 256) | Out-Null
            $cRect = New-Object Win32Clock+RECT
            [Win32Clock]::GetWindowRect($child, [ref]$cRect) | Out-Null
            $w = $cRect.Right - $cRect.Left
            $h = $cRect.Bottom - $cRect.Top
            Write-Output "  CHILD: [$cClass] '$($cSb.ToString())' ${w}x${h} hwnd=$child"
        }
    } while ($child -ne [IntPtr]::Zero)

    Write-Output "CHILDREN: $childCount"

    # The clock is a non-windowed Delphi control (TLabel/TPaintBox).
    # It is in the toolbar area, upper-left of the client area.
    # From the screenshot: large green digital clock, below menu bar, left side.
    # Click at approximately (150, 55) in client coordinates.
    $clickX = 150
    $clickY = 55
    Write-Output "CLICKING client ($clickX, $clickY)"

    # Click to pause
    [Win32Clock]::ClickClient($winHwnd, $clickX, $clickY)
    Start-Sleep -Milliseconds 200
    # Click to unpause
    [Win32Clock]::ClickClient($winHwnd, $clickX, $clickY)
    Write-Output "DONE"
} catch {
    Write-Output "ERROR: $($_.Exception.Message)"
}
