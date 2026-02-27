# read-phone-calls.ps1
# Reads the SimSig "Telephone Calls" window using Win32 API
# The TListBox is owner-drawn (Delphi), so LB_GETTEXT only returns
# the train identifier. All items in the list are unanswered calls.
# Outputs a JSON array to stdout.

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class SimSigListBox {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, StringBuilder lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    public const int LB_GETCOUNT = 0x018B;
    public const int LB_GETTEXT = 0x0189;
    public const int LB_GETTEXTLEN = 0x018A;
    public const uint WM_KEYDOWN = 0x0100;
    public const uint WM_KEYUP = 0x0101;
    public const uint WM_CLOSE = 0x0010;
    public const int VK_F6 = 0x75;

    public static int GetCount(IntPtr hWnd) {
        return (int)SendMessage(hWnd, LB_GETCOUNT, IntPtr.Zero, IntPtr.Zero);
    }

    public static string GetText(IntPtr hWnd, int index) {
        int len = (int)SendMessage(hWnd, LB_GETTEXTLEN, (IntPtr)index, IntPtr.Zero);
        if (len <= 0) return "";
        StringBuilder sb = new StringBuilder(len + 1);
        SendMessage(hWnd, LB_GETTEXT, (IntPtr)index, sb);
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

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc callback, IntPtr lParam);

    // Find a top-level window by class name using EnumWindows
    private static IntPtr _foundHwnd;
    private static string _searchClass;
    private static EnumWindowsProc _classCb;
    public static IntPtr FindTopWindowByClass(string className) {
        _foundHwnd = IntPtr.Zero;
        _searchClass = className;
        _classCb = (hWnd, lParam) => {
            StringBuilder sb = new StringBuilder(256);
            GetClassName(hWnd, sb, 256);
            if (sb.ToString() == _searchClass) {
                _foundHwnd = hWnd;
                return false;
            }
            return true;
        };
        EnumWindows(_classCb, IntPtr.Zero);
        return _foundHwnd;
    }

    // Find a top-level window by title
    private static IntPtr _foundTitle;
    private static string _searchTitle;
    private static EnumWindowsProc _titleCb;
    public static IntPtr FindTopWindowByTitle(string title) {
        _foundTitle = IntPtr.Zero;
        _searchTitle = title;
        _titleCb = (hWnd, lParam) => {
            StringBuilder sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            if (sb.ToString() == _searchTitle) {
                _foundTitle = hWnd;
                return false;
            }
            return true;
        };
        EnumWindows(_titleCb, IntPtr.Zero);
        return _foundTitle;
    }

    // Find a child window by class name
    private static IntPtr _foundChild;
    private static string _childClass;
    private static EnumWindowsProc _childCb;
    public static IntPtr FindChildByClass(IntPtr parent, string className) {
        _foundChild = IntPtr.Zero;
        _childClass = className;
        _childCb = (hWnd, lParam) => {
            StringBuilder sb = new StringBuilder(256);
            GetClassName(hWnd, sb, 256);
            if (sb.ToString() == _childClass) {
                _foundChild = hWnd;
                return false;
            }
            return true;
        };
        EnumChildWindows(parent, _childCb, IntPtr.Zero);
        return _foundChild;
    }

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public static bool IsOffScreen(IntPtr hWnd) {
        RECT r;
        if (!GetWindowRect(hWnd, out r)) return false;
        return r.Left <= -30000 && r.Top <= -30000;
    }

    public static void HideOffScreen(IntPtr hWnd) {
        // Only move if not already off-screen (avoids flicker on every poll)
        if (IsOffScreen(hWnd)) return;
        // SWP_NOSIZE (0x01) | SWP_NOZORDER (0x04) | SWP_NOACTIVATE (0x10)
        SetWindowPos(hWnd, IntPtr.Zero, -32000, -32000, 0, 0, 0x0001 | 0x0004 | 0x0010);
    }

    public static void SendF6(IntPtr hWnd) {
        PostMessage(hWnd, WM_KEYDOWN, (IntPtr)VK_F6, IntPtr.Zero);
        PostMessage(hWnd, WM_KEYUP, (IntPtr)VK_F6, IntPtr.Zero);
    }

    // Read pixel from screen (no messages sent to SimSig — fully passive)
    [DllImport("user32.dll")]
    public static extern IntPtr GetDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

    [DllImport("gdi32.dll")]
    public static extern uint GetPixel(IntPtr hdc, int x, int y);

    // Returns "red", "green", or hex color for debugging
    // Only works when SimSig window is visible (not covered by another window)
    public static string ReadClockColor(IntPtr hWnd) {
        RECT r;
        if (!GetWindowRect(hWnd, out r)) return "unknown";
        // Read from screen DC at absolute coordinates — sends no messages to SimSig
        IntPtr hdc = GetDC(IntPtr.Zero);
        if (hdc == IntPtr.Zero) return "no_dc";

        // Sample a few points across the clock area
        // Clock is in toolbar, roughly y=35..55 from window top, x=70..200
        string result = "no_match";
        int[] xOff = { 80, 100, 120, 140, 160 };
        int[] yOff = { 38, 42, 46, 50 };
        foreach (int dx in xOff) {
            foreach (int dy in yOff) {
                int sx = r.Left + dx;
                int sy = r.Top + dy;
                uint color = GetPixel(hdc, sx, sy);
                if (color == 0xFFFFFFFF) continue;
                int cr = (int)(color & 0xFF);
                int cg = (int)((color >> 8) & 0xFF);
                int cb = (int)((color >> 16) & 0xFF);
                if (cr > 150 && cg < 80 && cb < 80) { result = "red"; goto done; }
                if (cg > 100 && cr < 80 && cb < 80) { result = "green"; goto done; }
                result = String.Format("#{0:X2}{1:X2}{2:X2}", cr, cg, cb);
            }
        }
        done:
        ReleaseDC(IntPtr.Zero, hdc);
        return result;
    }

}
"@

try {
    $calls = @()
    $simName = ""

    # Read sim name from SimSig window title using EnumWindows (reliable for Delphi)
    [SimSigListBox]::FindSimSig()
    if ([SimSigListBox]::simsigHwnd -ne [IntPtr]::Zero) {
        $sb = New-Object System.Text.StringBuilder 256
        [SimSigListBox]::GetWindowText([SimSigListBox]::simsigHwnd, $sb, 256) | Out-Null
        $title = $sb.ToString()
        if ($title -match "^SimSig\s*-\s*(.+?)\s*\(") {
            $simName = $Matches[1].Trim()
        } elseif ($title -match "^SimSig\s*-\s*(.+)$") {
            $simName = $Matches[1].Trim()
        }
    }

    # Find the TTelephoneForm window using pure Win32 API (no UI Automation)
    $teleHwnd = [SimSigListBox]::FindTopWindowByClass("TTelephoneForm")

    # If telephone window is not open, don't send F6 from here.
    # The caller (PhoneReader) handles opening it once via a separate script.

    # Read calls from listbox if telephone window is open
    if ($teleHwnd -ne [IntPtr]::Zero) {
        # Keep the telephone window hidden off-screen
        [SimSigListBox]::HideOffScreen($teleHwnd)

        # Find the TListBox child using pure Win32 API
        $listBoxHwnd = [SimSigListBox]::FindChildByClass($teleHwnd, "TListBox")
        if ($listBoxHwnd -ne [IntPtr]::Zero) {
            $count = [SimSigListBox]::GetCount($listBoxHwnd)
            for ($i = 0; $i -lt $count; $i++) {
                $text = [SimSigListBox]::GetText($listBoxHwnd, $i)
                if ($text) {
                    $calls += @{ train = $text; status = "Unanswered" }
                }
            }
        }
    }

    # Check if TAnswerCallForm is open (report to renderer for hang-up detection)
    $answerHwnd = [SimSigListBox]::FindTopWindowByClass("TAnswerCallForm")
    $answerDialogOpen = $answerHwnd -ne [IntPtr]::Zero
    if ($answerDialogOpen) {
        [SimSigListBox]::HideOffScreen($answerHwnd)
    }

    # Hide the Place Call dialog if it's on-screen (our app manages it)
    $placeCallHwnd = [SimSigListBox]::FindTopWindowByTitle("Place Call")
    if ($placeCallHwnd -ne [IntPtr]::Zero) {
        [SimSigListBox]::HideOffScreen($placeCallHwnd)
    }

    $simsigFound = [SimSigListBox]::simsigHwnd -ne [IntPtr]::Zero

    # Detect pause state by reading the clock background color
    $clockColor = ""
    $paused = $false
    if ([SimSigListBox]::simsigHwnd -ne [IntPtr]::Zero) {
        $clockColor = [SimSigListBox]::ReadClockColor([SimSigListBox]::simsigHwnd)
        $paused = $clockColor -eq "red"
    }

    $result = @{ calls = $calls; simName = $simName; simsigFound = $simsigFound; clockColor = $clockColor; paused = $paused; answerDialogOpen = $answerDialogOpen }
    if ($calls.Count -eq 0) {
        $result.calls = @()
    }
    $json = $result | ConvertTo-Json -Compress -Depth 3
    Write-Output $json
} catch {
    Write-Output '{"calls":[],"simName":"","simsigFound":false}'
}
