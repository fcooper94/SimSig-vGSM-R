Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class WS {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EC cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EC cb, IntPtr l);
    public delegate bool EC(IntPtr h, IntPtr l);
    [DllImport("user32.dll",CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll",CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll",CharSet=CharSet.Auto)] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
    [DllImport("user32.dll",CharSet=CharSet.Auto)] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, StringBuilder l);
    public const int LB_GETCOUNT=0x018B; public const int LB_GETTEXT=0x0189; public const int LB_GETTEXTLEN=0x018A;

    public static List<string> results = new List<string>();

    public static void ScanAll() {
        results.Clear();
        EnumWindows((hwnd, lp) => {
            StringBuilder cls = new StringBuilder(256);
            GetClassName(hwnd, cls, 256);
            StringBuilder title = new StringBuilder(256);
            GetWindowText(hwnd, title, 256);
            string c = cls.ToString();
            if (!c.StartsWith("T")) return true;

            // Check children for TListBox with items
            EnumChildWindows(hwnd, (ch, cl) => {
                StringBuilder ccls = new StringBuilder(256);
                GetClassName(ch, ccls, 256);
                if (ccls.ToString() == "TListBox") {
                    int count = (int)SendMessage(ch, LB_GETCOUNT, IntPtr.Zero, IntPtr.Zero);
                    if (count > 0) {
                        results.Add(c + " | [" + title + "] | LB hwnd=" + ch + " count=" + count);
                        for (int i = 0; i < count && i < 5; i++) {
                            int len = (int)SendMessage(ch, LB_GETTEXTLEN, (IntPtr)i, IntPtr.Zero);
                            if (len > 0) {
                                StringBuilder sb = new StringBuilder(len + 1);
                                SendMessage(ch, LB_GETTEXT, (IntPtr)i, sb);
                                results.Add("  [" + i + "] " + sb.ToString());
                            } else {
                                results.Add("  [" + i + "] (len=0)");
                            }
                        }
                    }
                }
                return true;
            }, IntPtr.Zero);
            return true;
        }, IntPtr.Zero);
    }
}
"@

[WS]::ScanAll()
if ([WS]::results.Count -eq 0) {
    Write-Output "No SimSig windows with TListBox items found"
} else {
    foreach ($r in [WS]::results) { Write-Output $r }
}
