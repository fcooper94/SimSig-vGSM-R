# read-message-log.ps1
# ──────────────────────────────────────────────────────────────────────
# Reads the SimSig message log (TViewMessagesForm → TListBox).
# Returns JSON with all lines for diffing by PhoneReader in Node.js.
#
# The message log is a separate top-level window (class TViewMessagesForm)
# containing a TListBox with owner-drawn items. Read via LB_GETCOUNT/LB_GETTEXT.
# Read-only — sends no clicks or modifications to SimSig.
# ──────────────────────────────────────────────────────────────────────

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class SimSigMsgLog {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, StringBuilder lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumCallback callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr parent, EnumCallback callback, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxLength);

    public delegate bool EnumCallback(IntPtr hWnd, IntPtr lParam);

    public const int LB_GETCOUNT = 0x018B;
    public const int LB_GETTEXT = 0x0189;
    public const int LB_GETTEXTLEN = 0x018A;

    private static EnumCallback _callback;
    private static EnumCallback _childCallback;
    public static IntPtr messagesForm = IntPtr.Zero;
    public static IntPtr listBox = IntPtr.Zero;

    // Find TViewMessagesForm (the message log window)
    public static void FindMessagesWindow() {
        messagesForm = IntPtr.Zero;
        _callback = (hWnd, lParam) => {
            StringBuilder sb = new StringBuilder(256);
            GetClassName(hWnd, sb, 256);
            if (sb.ToString() == "TViewMessagesForm") {
                messagesForm = hWnd;
                return false;
            }
            return true;
        };
        EnumWindows(_callback, IntPtr.Zero);
    }

    // Find TListBox child inside the messages form
    public static void FindListBox() {
        listBox = IntPtr.Zero;
        if (messagesForm == IntPtr.Zero) return;
        _childCallback = (hWnd, lParam) => {
            StringBuilder sb = new StringBuilder(256);
            GetClassName(hWnd, sb, 256);
            if (sb.ToString() == "TListBox") {
                listBox = hWnd;
                return false;
            }
            return true;
        };
        EnumChildWindows(messagesForm, _childCallback, IntPtr.Zero);
    }

    // Read all items from the listbox
    public static List<string> ReadAllItems() {
        var items = new List<string>();
        if (listBox == IntPtr.Zero) return items;

        int count = (int)SendMessage(listBox, LB_GETCOUNT, IntPtr.Zero, IntPtr.Zero);
        if (count <= 0) return items;

        for (int i = 0; i < count; i++) {
            int len = (int)SendMessage(listBox, LB_GETTEXTLEN, (IntPtr)i, IntPtr.Zero);
            if (len <= 0) continue;
            var sb = new StringBuilder(len + 1);
            SendMessage(listBox, LB_GETTEXT, (IntPtr)i, sb);
            string text = sb.ToString().Trim();
            if (text.Length > 0) items.Add(text);
        }
        return items;
    }
}
"@

try {
    [SimSigMsgLog]::FindMessagesWindow()
    if ([SimSigMsgLog]::messagesForm -eq [IntPtr]::Zero) {
        Write-Output '{"lines":[],"lineCount":0}'
        exit
    }

    [SimSigMsgLog]::FindListBox()
    if ([SimSigMsgLog]::listBox -eq [IntPtr]::Zero) {
        Write-Output '{"lines":[],"lineCount":0}'
        exit
    }

    $lines = [SimSigMsgLog]::ReadAllItems()

    # Build JSON manually for reliability
    $items = @()
    foreach ($line in $lines) {
        $escaped = $line -replace '\\', '\\\\' -replace '"', '\"' -replace "`r", '' -replace "`n", ' '
        $items += "`"$escaped`""
    }
    $json = "[" + ($items -join ",") + "]"
    Write-Output "{`"lines`":$json,`"lineCount`":$($lines.Count)}"
} catch {
    $errMsg = $_.Exception.Message -replace '"', "'"
    Write-Output "{`"lines`":[],`"lineCount`":0,`"error`":`"$errMsg`"}"
}
