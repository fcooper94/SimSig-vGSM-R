# answer-phone-call.ps1
# Selects a call in SimSig's Telephone Calls listbox, clicks Answer,
# reads the message from the response dialog, and outputs JSON.
# Does NOT auto-reply — leaves the dialog open for the user.
# Uses pure Win32 API only (no UI Automation) to avoid disturbing SimSig.
# Usage: powershell -File answer-phone-call.ps1 -Index 0

param(
    [int]$Index = 0,
    [string]$Train = ""
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public class Win32Auto {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, StringBuilder lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc callback, IntPtr lParam);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    public const int LB_GETCOUNT = 0x018B;
    public const int LB_SETCURSEL = 0x0186;
    public const int LB_GETTEXT = 0x0189;
    public const int LB_GETTEXTLEN = 0x018A;
    public const int BM_CLICK = 0x00F5;
    public const int WM_GETTEXT = 0x000D;
    public const int WM_GETTEXTLENGTH = 0x000E;
    public const uint WM_CLOSE = 0x0010;
    public const uint WM_KEYDOWN = 0x0100;
    public const uint WM_KEYUP = 0x0101;
    public const int VK_F6 = 0x75;

    public static int GetCount(IntPtr hWnd) {
        return (int)SendMessage(hWnd, LB_GETCOUNT, IntPtr.Zero, IntPtr.Zero);
    }

    public static void SelectItem(IntPtr hWnd, int index) {
        SendMessage(hWnd, LB_SETCURSEL, (IntPtr)index, IntPtr.Zero);
    }

    public static string GetText(IntPtr hWnd, int index) {
        int len = (int)SendMessage(hWnd, LB_GETTEXTLEN, (IntPtr)index, IntPtr.Zero);
        if (len <= 0) return "";
        StringBuilder sb = new StringBuilder(len + 1);
        SendMessage(hWnd, LB_GETTEXT, (IntPtr)index, sb);
        return sb.ToString();
    }

    public static void ClickButton(IntPtr hWnd) {
        SendMessage(hWnd, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
    }

    public static void CloseWindow(IntPtr hWnd) {
        PostMessage(hWnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
    }

    public static void HideOffScreen(IntPtr hWnd) {
        SetWindowPos(hWnd, IntPtr.Zero, -32000, -32000, 0, 0, 0x0001 | 0x0004 | 0x0010);
    }

    public static void SendF6(IntPtr hWnd) {
        PostMessage(hWnd, WM_KEYDOWN, (IntPtr)VK_F6, IntPtr.Zero);
        PostMessage(hWnd, WM_KEYUP, (IntPtr)VK_F6, IntPtr.Zero);
    }

    // Read text from any window control via WM_GETTEXT
    public static string GetControlText(IntPtr hWnd) {
        int len = (int)SendMessage(hWnd, WM_GETTEXTLENGTH, IntPtr.Zero, IntPtr.Zero);
        if (len <= 0) return "";
        StringBuilder sb = new StringBuilder(len + 1);
        SendMessage(hWnd, WM_GETTEXT, (IntPtr)(len + 1), sb);
        return sb.ToString();
    }

    // --- Window finding helpers (pure Win32, no UIA) ---

    public static IntPtr simsigHwnd = IntPtr.Zero;
    private static EnumWindowsProc _simCb;
    public static void FindSimSig() {
        simsigHwnd = IntPtr.Zero;
        _simCb = (hWnd, lParam) => {
            StringBuilder sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            if (sb.ToString().StartsWith("SimSig -")) {
                simsigHwnd = hWnd;
                return false;
            }
            return true;
        };
        EnumWindows(_simCb, IntPtr.Zero);
    }

    // Find a top-level window by class name
    private static IntPtr _foundTop;
    private static string _topClass;
    private static EnumWindowsProc _topCb;
    public static IntPtr FindTopWindowByClass(string className) {
        _foundTop = IntPtr.Zero;
        _topClass = className;
        _topCb = (hWnd, lParam) => {
            StringBuilder sb = new StringBuilder(256);
            GetClassName(hWnd, sb, 256);
            if (sb.ToString() == _topClass) {
                _foundTop = hWnd;
                return false;
            }
            return true;
        };
        EnumWindows(_topCb, IntPtr.Zero);
        return _foundTop;
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

    // Check if a class name looks like a button
    private static bool IsButtonClass(string cls) {
        return cls == "TButton" || cls == "TBitBtn" || cls == "TSpeedButton"
            || cls == "Button" || cls.Contains("Btn") || cls.Contains("Button");
    }

    // Find a child button by its text label (handles & prefix)
    private static IntPtr _foundBtn;
    private static string _btnText;
    private static EnumWindowsProc _btnCb;
    public static IntPtr FindButtonByText(IntPtr parent, string text) {
        _foundBtn = IntPtr.Zero;
        _btnText = text;
        _btnCb = (hWnd, lParam) => {
            StringBuilder cls = new StringBuilder(256);
            GetClassName(hWnd, cls, 256);
            string c = cls.ToString();
            if (IsButtonClass(c)) {
                StringBuilder txt = new StringBuilder(256);
                GetWindowText(hWnd, txt, 256);
                string btnText = txt.ToString().Replace("&", "");
                if (btnText == _btnText || btnText.Equals(_btnText, StringComparison.OrdinalIgnoreCase)) {
                    _foundBtn = hWnd;
                    return false;
                }
            }
            return true;
        };
        EnumChildWindows(parent, _btnCb, IntPtr.Zero);
        return _foundBtn;
    }

    // Debug: list all child windows with class and text
    public static string EnumAllChildren(IntPtr parent) {
        var sb = new StringBuilder();
        EnumChildWindows(parent, (hWnd, lParam) => {
            var cls = new StringBuilder(256);
            GetClassName(hWnd, cls, 256);
            var txt = new StringBuilder(256);
            GetWindowText(hWnd, txt, 256);
            sb.AppendFormat("{0}:{1}|", cls.ToString(), txt.ToString());
            return true;
        }, IntPtr.Zero);
        return sb.ToString();
    }

    // Find a top-level window by title text
    private static IntPtr _foundTitle;
    private static string _titleText;
    private static EnumWindowsProc _titleCb;
    public static IntPtr FindTopWindowByTitle(string title) {
        _foundTitle = IntPtr.Zero;
        _titleText = title;
        _titleCb = (hWnd, lParam) => {
            StringBuilder sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            if (sb.ToString() == _titleText) {
                _foundTitle = hWnd;
                return false;
            }
            return true;
        };
        EnumWindows(_titleCb, IntPtr.Zero);
        return _foundTitle;
    }
}
"@

try {
    # Close any stale TAnswerCallForm from a previous session/call
    $staleHwnd = [Win32Auto]::FindTopWindowByClass("TAnswerCallForm")
    if ($staleHwnd -ne [IntPtr]::Zero) {
        [Win32Auto]::CloseWindow($staleHwnd)
        Start-Sleep -Milliseconds 500

        # Closing the dialog may also close the Telephone Calls window
        # Send F6 to SimSig to ensure it's open again
        [Win32Auto]::FindSimSig()
        if ([Win32Auto]::simsigHwnd -ne [IntPtr]::Zero) {
            [Win32Auto]::SendF6([Win32Auto]::simsigHwnd)
            Start-Sleep -Milliseconds 500
        }
    }

    # Find the TTelephoneForm window
    $teleHwnd = [Win32Auto]::FindTopWindowByClass("TTelephoneForm")

    if ($teleHwnd -eq [IntPtr]::Zero) {
        # Try sending F6 to open it
        [Win32Auto]::FindSimSig()
        if ([Win32Auto]::simsigHwnd -ne [IntPtr]::Zero) {
            [Win32Auto]::SendF6([Win32Auto]::simsigHwnd)
            Start-Sleep -Milliseconds 500
            $teleHwnd = [Win32Auto]::FindTopWindowByClass("TTelephoneForm")
        }
    }

    if ($teleHwnd -eq [IntPtr]::Zero) {
        Write-Output '{"error":"Telephone Calls window not found"}'
        exit 0
    }

    # Hide the telephone window off-screen
    [Win32Auto]::HideOffScreen($teleHwnd)

    # Find the TListBox child
    $listBoxHwnd = [Win32Auto]::FindChildByClass($teleHwnd, "TListBox")

    if ($listBoxHwnd -eq [IntPtr]::Zero) {
        Write-Output '{"error":"ListBox not found"}'
        exit 0
    }

    $count = [Win32Auto]::GetCount($listBoxHwnd)

    # If a train name was provided, find its actual index in the listbox
    if ($Train -ne "") {
        $found = $false
        for ($i = 0; $i -lt $count; $i++) {
            $itemText = [Win32Auto]::GetText($listBoxHwnd, $i)
            if ($itemText -eq $Train) {
                $Index = $i
                $found = $true
                break
            }
        }
        if (-not $found) {
            Write-Output '{"error":"Call not found in list"}'
            exit 0
        }
    }

    if ($Index -ge $count) {
        Write-Output '{"error":"Call index out of range"}'
        exit 0
    }

    # Get the train name before answering
    $trainName = [Win32Auto]::GetText($listBoxHwnd, $Index)

    # Select the call in the listbox
    [Win32Auto]::SelectItem($listBoxHwnd, $Index)
    Start-Sleep -Milliseconds 50

    # Find and click the "Answer call" button
    $answerBtnHwnd = [Win32Auto]::FindButtonByText($teleHwnd, "Answer call")

    if ($answerBtnHwnd -eq [IntPtr]::Zero) {
        $children = [Win32Auto]::EnumAllChildren($teleHwnd)
        $dbg = $children -replace '"', "'"
        Write-Output "{`"error`":`"Answer call button not found`",`"children`":`"$dbg`"}"
        exit 0
    }

    [Win32Auto]::ClickButton($answerBtnHwnd)

    # Wait for the TAnswerCallForm dialog to appear (up to 3 seconds)
    $messageText = ""
    $dialogTitle = ""
    $replyOptions = @()
    $answerHwnd = [IntPtr]::Zero

    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 100

        $answerHwnd = [Win32Auto]::FindTopWindowByClass("TAnswerCallForm")

        if ($answerHwnd -ne [IntPtr]::Zero) {
            # Read dialog title via GetWindowText
            $titleSb = New-Object System.Text.StringBuilder 256
            [Win32Auto]::GetWindowText($answerHwnd, $titleSb, 256) | Out-Null
            $dialogTitle = $titleSb.ToString()

            # Read the TMemo message text via WM_GETTEXT
            $memoHwnd = [Win32Auto]::FindChildByClass($answerHwnd, "TMemo")
            if ($memoHwnd -ne [IntPtr]::Zero) {
                $messageText = [Win32Auto]::GetControlText($memoHwnd)
            }

            # Read the reply options from the TListBox
            $replyListHwnd = [Win32Auto]::FindChildByClass($answerHwnd, "TListBox")
            if ($replyListHwnd -ne [IntPtr]::Zero) {
                $replyCount = [Win32Auto]::GetCount($replyListHwnd)
                for ($r = 0; $r -lt $replyCount; $r++) {
                    $replyOptions += [Win32Auto]::GetText($replyListHwnd, $r)
                }
            }

            # Hide the answer dialog off-screen
            [Win32Auto]::HideOffScreen($answerHwnd)

            break
        }
    }

    # Hide any lingering Place Call dialog
    $placeCallHwnd = [Win32Auto]::FindTopWindowByTitle("Place Call")
    if ($placeCallHwnd -ne [IntPtr]::Zero) {
        [Win32Auto]::HideOffScreen($placeCallHwnd)
    }

    # Build result
    $result = @{
        train   = $trainName
        title   = $dialogTitle
        message = $messageText
        replies = $replyOptions
    }

    $json = $result | ConvertTo-Json -Compress
    Write-Output $json
} catch {
    Write-Output "{`"error`":`"$($_.Exception.Message)`"}"
}
