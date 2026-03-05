# suppress-failure-dialogs.ps1
# ──────────────────────────────────────────────────────────────────────
# Finds and auto-dismisses SimSig failure notification dialogs:
#   - Track circuit failure (TCF)
#   - Points failure
#   - Signal lamp failure / TRTS
#
# Runs periodically from PhoneReader poll cycle. Enumerates visible
# top-level windows, reads their text, and clicks OK on matching dialogs.
# Returns JSON with any dismissed dialog texts for the alerts feed.
#
# Uses PostMessage(BM_CLICK) — async, same pattern as reply-phone-call.ps1.
# ──────────────────────────────────────────────────────────────────────

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class Win32Suppress {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

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
    public static extern bool IsWindow(IntPtr hWnd);

    public delegate bool EnumCallback(IntPtr hWnd, IntPtr lParam);

    public const int BM_CLICK = 0x00F5;
    public const int WM_GETTEXT = 0x000D;
    public const int WM_GETTEXTLENGTH = 0x000E;

    // Read text content from a window control (TMemo, TStaticText, etc.)
    public static string GetWindowTextStr(IntPtr hWnd) {
        int len = (int)SendMessage(hWnd, WM_GETTEXTLENGTH, IntPtr.Zero, IntPtr.Zero);
        if (len <= 0) return "";
        var sb = new StringBuilder(len + 1);
        SendMessage(hWnd, WM_GETTEXT, (IntPtr)(len + 1), sb);
        return sb.ToString();
    }

    // Read all child text content from a dialog (concatenates text from all children)
    public static string ReadDialogText(IntPtr parent) {
        var texts = new List<string>();
        EnumChildWindows(parent, (hWnd, lParam) => {
            var sb = new StringBuilder(256);
            GetClassName(hWnd, sb, 256);
            string cls = sb.ToString();
            // Read text from label/memo/static controls (skip buttons and edits)
            if (cls == "TLabel" || cls == "TMemo" || cls == "TStaticText"
                || cls == "Static" || cls == "TPanel") {
                string text = GetWindowTextStr(hWnd);
                if (!string.IsNullOrWhiteSpace(text)) texts.Add(text.Trim());
            }
            return true;
        }, IntPtr.Zero);
        // Also read the window's own title
        var titleSb = new StringBuilder(512);
        GetWindowText(parent, titleSb, 512);
        string title = titleSb.ToString();
        if (!string.IsNullOrWhiteSpace(title)) texts.Insert(0, title.Trim());
        return string.Join(" | ", texts);
    }

    // Find OK/Yes/Close button in a dialog
    public static IntPtr FindOkButton(IntPtr parent) {
        string[] texts = new string[] { "OK", "Ok", "&OK", "Yes", "&Yes", "Close" };
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

    // Check if text contains failure-related keywords
    public static bool IsFailureDialog(string text) {
        string lower = text.ToLower();
        return lower.Contains("failure") || lower.Contains("trts")
            || lower.Contains("track circuit") || lower.Contains("points fail")
            || lower.Contains("signal fail") || lower.Contains("lamp fail");
    }

    // Find all visible failure dialogs and dismiss them
    public static List<string> SuppressAll() {
        var dismissed = new List<string>();
        var dialogs = new List<IntPtr>();

        // Collect all candidate dialogs first
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            var sb = new StringBuilder(256);
            GetClassName(hWnd, sb, 256);
            string cls = sb.ToString();
            // SimSig uses TMessageForm for alerts; also check #32770 (standard dialog)
            if (cls == "TMessageForm" || cls == "#32770") {
                dialogs.Add(hWnd);
            }
            return true;
        }, IntPtr.Zero);

        // Check each dialog
        foreach (var dlg in dialogs) {
            if (!IsWindow(dlg) || !IsWindowVisible(dlg)) continue;
            string text = ReadDialogText(dlg);
            if (string.IsNullOrWhiteSpace(text)) continue;
            if (!IsFailureDialog(text)) continue;

            // Found a failure dialog — find OK button and click it
            IntPtr btn = FindOkButton(dlg);
            if (btn != IntPtr.Zero) {
                PostMessage(btn, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
                dismissed.Add(text);
            }
        }

        return dismissed;
    }
}
"@

try {
    $results = [Win32Suppress]::SuppressAll()
    if ($results.Count -gt 0) {
        $items = @()
        foreach ($text in $results) {
            $escaped = $text -replace '\\', '\\\\' -replace '"', '\"' -replace "`r", '' -replace "`n", ' '
            $items += "`"$escaped`""
        }
        $json = "[" + ($items -join ",") + "]"
        Write-Output "{`"dismissed`":$json}"
    } else {
        Write-Output '{"dismissed":[]}'
    }
} catch {
    Write-Output '{"dismissed":[],"error":"' + ($_.Exception.Message -replace '"', "'") + '"}'
}
