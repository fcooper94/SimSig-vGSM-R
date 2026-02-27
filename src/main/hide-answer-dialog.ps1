# hide-answer-dialog.ps1
# Hides any open TAnswerCallForm off-screen so it doesn't linger after hang-up.
# We cannot close/destroy this dialog — SimSig ignores WM_CLOSE, and clicking X
# breaks SimSig's internal state so it won't create new answer dialogs.

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class HideAnswer {
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumCallback callback, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder className, int maxLength);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    public delegate bool EnumCallback(IntPtr hWnd, IntPtr lParam);

    public static void HideAllByClass(string cls) {
        EnumWindows((hWnd, lParam) => {
            var sb = new System.Text.StringBuilder(256);
            GetClassName(hWnd, sb, 256);
            if (sb.ToString() == cls) {
                // Move off-screen: SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE
                SetWindowPos(hWnd, IntPtr.Zero, -32000, -32000, 0, 0, 0x0001 | 0x0004 | 0x0010);
            }
            return true;
        }, IntPtr.Zero);
    }
}
"@

[HideAnswer]::HideAllByClass("TAnswerCallForm")
Write-Output '{"success":true}'
