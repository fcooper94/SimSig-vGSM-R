# reply-phone-call.ps1
# Selects a reply option in SimSig's Answer Call dialog and clicks Reply.
# Usage: powershell -File reply-phone-call.ps1 -ReplyIndex 0 [-HeadCode 1F32]

param(
    [int]$ReplyIndex = 0,
    [string]$HeadCode = ""
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public class Win32Reply {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", EntryPoint = "SendMessage", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessageStr(IntPtr hWnd, int msg, IntPtr wParam, string lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr FindWindow(string className, string windowName);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string className, string windowName);

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr parent, EnumCallback callback, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int maxLength);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder className, int maxLength);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumCallback callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    public delegate bool EnumCallback(IntPtr hWnd, IntPtr lParam);

    public const int LB_SETCURSEL = 0x0186;
    public const int BM_CLICK = 0x00F5;
    public const int WM_SETTEXT = 0x000C;

    public static void SelectItem(IntPtr hWnd, int index) {
        SendMessage(hWnd, LB_SETCURSEL, (IntPtr)index, IntPtr.Zero);
    }

    public static void ClickButton(IntPtr hWnd) {
        SendMessage(hWnd, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
    }

    // Async click — does not block if the button opens a modal dialog
    public static void ClickButtonAsync(IntPtr hWnd) {
        PostMessage(hWnd, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
    }

    public static void SetText(IntPtr hWnd, string text) {
        SendMessageStr(hWnd, WM_SETTEXT, IntPtr.Zero, text);
    }

    // Find an edit control anywhere in the window hierarchy (recursive)
    public static IntPtr FindEditControl(IntPtr parent) {
        IntPtr result = IntPtr.Zero;
        EnumChildWindows(parent, (hWnd, lParam) => {
            var sb = new System.Text.StringBuilder(256);
            GetClassName(hWnd, sb, 256);
            string cls = sb.ToString();
            if (cls == "TEdit" || cls == "Edit") {
                result = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    // Find a visible top-level window titled "Message" or "Confirmation" with an Ok/OK button
    public static IntPtr FindMessageDialog(string[] buttonTexts) {
        IntPtr result = IntPtr.Zero;
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            var sb = new System.Text.StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            string title = sb.ToString();
            if (title == "Message" || title.Contains("onfirmation")) {
                // Verify it has a matching button
                IntPtr btn = FindButtonByText(hWnd, buttonTexts);
                if (btn != IntPtr.Zero) {
                    result = hWnd;
                    return false;
                }
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    // Find a visible top-level window that has a TEdit child and "onfirmation" in its title
    public static IntPtr FindConfirmationDialog() {
        IntPtr result = IntPtr.Zero;
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            var sb = new System.Text.StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            string title = sb.ToString();
            if (title.Contains("onfirmation")) {
                // Verify it has an edit control
                IntPtr edit = FindEditControl(hWnd);
                if (edit != IntPtr.Zero) {
                    result = hWnd;
                    return false;
                }
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    // Find a child button by text (OK, &OK, Close)
    public static IntPtr FindButtonByText(IntPtr parent, string[] texts) {
        IntPtr result = IntPtr.Zero;
        EnumChildWindows(parent, (hWnd, lParam) => {
            var sb = new System.Text.StringBuilder(256);
            GetClassName(hWnd, sb, 256);
            string cls = sb.ToString();
            if (cls == "TButton" || cls == "Button") {
                sb.Clear();
                GetWindowText(hWnd, sb, 256);
                string btnText = sb.ToString();
                foreach (string t in texts) {
                    if (btnText == t) {
                        result = hWnd;
                        return false; // stop enumerating
                    }
                }
            }
            return true; // continue
        }, IntPtr.Zero);
        return result;
    }
}
"@

try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement

    # Find the TAnswerCallForm dialog
    $answerFormCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ClassNameProperty,
        "TAnswerCallForm"
    )
    $dialog = $root.FindFirst(
        [System.Windows.Automation.TreeScope]::Children,
        $answerFormCond
    )

    if ($null -eq $dialog) {
        Write-Output '{"error":"Answer dialog not found"}'
        exit 0
    }

    # Save SimSig's process ID so we can send F6 later if needed
    $simsigPid = $dialog.Current.ProcessId

    # Find the TListBox (reply options)
    $listBoxCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ClassNameProperty,
        "TListBox"
    )
    $listBox = $dialog.FindFirst(
        [System.Windows.Automation.TreeScope]::Descendants,
        $listBoxCond
    )

    if ($null -eq $listBox) {
        Write-Output '{"error":"Reply listbox not found"}'
        exit 0
    }

    $listBoxHwnd = [IntPtr]$listBox.Current.NativeWindowHandle

    # Select the reply option
    [Win32Reply]::SelectItem($listBoxHwnd, $ReplyIndex)
    Start-Sleep -Milliseconds 100

    # Find and click the Reply button
    $replyBtnCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        "Reply"
    )
    $replyBtn = $dialog.FindFirst(
        [System.Windows.Automation.TreeScope]::Descendants,
        $replyBtnCond
    )

    if ($null -eq $replyBtn) {
        Write-Output '{"error":"Reply button not found"}'
        exit 0
    }

    $replyBtnHwnd = [IntPtr]$replyBtn.Current.NativeWindowHandle
    # Use async PostMessage — Reply button may open a modal dialog that
    # would block a synchronous SendMessage(BM_CLICK) indefinitely
    [Win32Reply]::ClickButtonAsync($replyBtnHwnd)

    $okTexts = @("OK", "&OK", "Ok", "Close")

    # If a headcode was provided, handle the confirmation dialog
    if ($HeadCode -ne "") {
        for ($attempt = 0; $attempt -lt 15; $attempt++) {
            Start-Sleep -Milliseconds 200

            # Search ALL top-level windows for the confirmation dialog
            $confirmHwnd = [Win32Reply]::FindConfirmationDialog()
            if ($confirmHwnd -eq [IntPtr]::Zero) { continue }

            # We found it — get the edit control and type the headcode
            $editHwnd = [Win32Reply]::FindEditControl($confirmHwnd)
            if ($editHwnd -ne [IntPtr]::Zero) {
                [Win32Reply]::SetText($editHwnd, $HeadCode)
                Start-Sleep -Milliseconds 50

                $okHwnd = [Win32Reply]::FindButtonByText($confirmHwnd, $okTexts)
                if ($okHwnd -ne [IntPtr]::Zero) {
                    # Async click — OK may open another modal dialog
                    [Win32Reply]::ClickButtonAsync($okHwnd)
                }
                break
            }
        }
    }

    # Wait for any subsequent OK/Close dialog and dismiss it
    # SimSig shows a "Message" popup after the reply is processed
    Start-Sleep -Milliseconds 500
    for ($attempt = 0; $attempt -lt 15; $attempt++) {
        # Use EnumWindows to find a "Message" or "Confirmation" dialog with an Ok button
        $popupHwnd = [Win32Reply]::FindMessageDialog($okTexts)

        if ($popupHwnd -ne [IntPtr]::Zero) {
            $okHwnd = [Win32Reply]::FindButtonByText($popupHwnd, $okTexts)
            if ($okHwnd -ne [IntPtr]::Zero) {
                [Win32Reply]::ClickButton($okHwnd)
                break
            }
        }

        Start-Sleep -Milliseconds 200
    }

    # Check if the Telephone Calls window is still open
    Start-Sleep -Milliseconds 300
    $telFormCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ClassNameProperty,
        "TTelephoneForm"
    )
    $telWindow = $root.FindFirst(
        [System.Windows.Automation.TreeScope]::Children,
        $telFormCond
    )

    if ($null -eq $telWindow -and $simsigPid -gt 0) {
        # Window closed — send F6 to SimSig's main window to reopen it
        try {
            $proc = Get-Process -Id $simsigPid -ErrorAction Stop
            $mainHwnd = $proc.MainWindowHandle
            if ($mainHwnd -ne [IntPtr]::Zero) {
                # WM_KEYDOWN=0x0100, VK_F6=0x75
                [Win32Reply]::PostMessage($mainHwnd, 0x0100, [IntPtr]0x75, [IntPtr]::Zero) | Out-Null
                Start-Sleep -Milliseconds 50
                [Win32Reply]::PostMessage($mainHwnd, 0x0101, [IntPtr]0x75, [IntPtr]::Zero) | Out-Null
            }
        } catch {}
    }

    Write-Output '{"success":true}'
} catch {
    Write-Output "{`"error`":`"$($_.Exception.Message)`"}"
}
