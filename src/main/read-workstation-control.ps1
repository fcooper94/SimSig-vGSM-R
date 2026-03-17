# read-workstation-control.ps1
# Reads SimSig's "Workstation Control" dialog to find panel assignments.
# Uses the same Win32 API approach as read-phone-calls.ps1.
# Returns JSON: { panels: [{ name, controller }] }
# The user must open the dialog (Multiplayer > Workstation Control).

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class WksRead {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, StringBuilder lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    public const int LB_GETCOUNT = 0x018B;
    public const int LB_GETTEXT = 0x0189;
    public const int LB_GETTEXTLEN = 0x018A;

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
}
"@

try {
    # Find the Workstation Control dialog by title
    $dialogHwnd = [WksRead]::FindTopWindowByTitle("Workstation Control")
    if ($dialogHwnd -eq [IntPtr]::Zero) {
        Write-Output '{"error":"Workstation Control dialog not found. Open it from Multiplayer menu."}'
        exit 0
    }

    # Find the TListBox child
    $listBoxHwnd = [WksRead]::FindChildByClass($dialogHwnd, "TListBox")
    if ($listBoxHwnd -eq [IntPtr]::Zero) {
        Write-Output '{"error":"TListBox not found inside Workstation Control dialog"}'
        exit 0
    }

    $count = [WksRead]::GetCount($listBoxHwnd)

    $panels = @()
    for ($i = 0; $i -lt $count; $i++) {
        $text = [WksRead]::GetText($listBoxHwnd, $i)
        if ($text) {
            if ($text -match "^(.+?)\s*\(in control\)\s*$") {
                $panels += @{ name = $Matches[1].Trim(); controller = "self" }
            } elseif ($text -match "^(.+?)\s*\(([^)]+)\)\s*$") {
                $panels += @{ name = $Matches[1].Trim(); controller = $Matches[2].Trim() }
            } else {
                $panels += @{ name = $text.Trim(); controller = "" }
            }
        }
    }

    $result = @{ panels = $panels; count = $count; listBoxHwnd = $listBoxHwnd.ToString() }
    $json = $result | ConvertTo-Json -Compress -Depth 3
    Write-Output $json
} catch {
    $msg = $_.Exception.Message -replace '"', '\"'
    Write-Output "{`"error`":`"$msg`"}"
}
