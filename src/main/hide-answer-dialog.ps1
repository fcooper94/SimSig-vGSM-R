# hide-answer-dialog.ps1
# Closes any open TAnswerCallForm dialog using WM_CLOSE.

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class HideAnswer {
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumCallback callback, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder className, int maxLength);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    public delegate bool EnumCallback(IntPtr hWnd, IntPtr lParam);

    public const uint WM_CLOSE = 0x0010;

    public static void CloseAllByClass(string cls) {
        EnumWindows((hWnd, lParam) => {
            var sb = new System.Text.StringBuilder(256);
            GetClassName(hWnd, sb, 256);
            if (sb.ToString() == cls) {
                PostMessage(hWnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
            }
            return true;
        }, IntPtr.Zero);
    }
}
"@

[HideAnswer]::CloseAllByClass("TAnswerCallForm")
Write-Output '{"success":true}'
