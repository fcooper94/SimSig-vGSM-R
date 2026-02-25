# open-telephone-window.ps1
# Ensures the SimSig "Telephone Calls" window (F6) is open.
# If already open, does nothing. If closed, finds SimSig and sends F6.
# Uses EnumWindows for reliable Delphi window detection.

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class SimSigTel {
    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumCallback callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxLength);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxLength);

    public delegate bool EnumCallback(IntPtr hWnd, IntPtr lParam);

    public static IntPtr TelephoneHwnd = IntPtr.Zero;
    public static IntPtr MainFormHwnd = IntPtr.Zero;
    public static uint SimSigPid = 0;

    public static bool EnumProc(IntPtr hWnd, IntPtr lParam) {
        if (!IsWindowVisible(hWnd)) return true;
        StringBuilder cls = new StringBuilder(256);
        GetClassName(hWnd, cls, 256);
        string className = cls.ToString();

        if (className == "TTelephoneForm") {
            TelephoneHwnd = hWnd;
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            SimSigPid = pid;
        }
        if (className == "TMainForm" || className == "TSimForm") {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (SimSigPid == 0 || pid == SimSigPid) {
                MainFormHwnd = hWnd;
                SimSigPid = pid;
            }
        }
        return true;
    }

    public static void FindWindows() {
        TelephoneHwnd = IntPtr.Zero;
        MainFormHwnd = IntPtr.Zero;
        SimSigPid = 0;
        EnumWindows(new EnumCallback(EnumProc), IntPtr.Zero);
    }
}
"@

function Get-SimTitle {
    if ([SimSigTel]::MainFormHwnd -eq [IntPtr]::Zero) { return "" }
    $sb = New-Object System.Text.StringBuilder 512
    [SimSigTel]::GetWindowText([SimSigTel]::MainFormHwnd, $sb, 512) | Out-Null
    return $sb.ToString()
}

# Extract sim name from title like "SimSig - London Bridge ASC Mini Sim (server on port 50505)"
function Get-SimName($title) {
    if ($title -match "^SimSig\s*-\s*(.+?)\s*\(") {
        return $Matches[1].Trim()
    }
    if ($title -match "^SimSig\s*-\s*(.+)$") {
        return $Matches[1].Trim()
    }
    return ""
}

try {
    [SimSigTel]::FindWindows()

    # Read window title for sim name
    $title = Get-SimTitle
    $simName = Get-SimName $title
    $simNameJson = $simName -replace '\\', '\\' -replace '"', '\"'

    if ([SimSigTel]::TelephoneHwnd -ne [IntPtr]::Zero) {
        Write-Output "{`"status`":`"already_open`",`"simName`":`"$simNameJson`"}"
        exit 0
    }

    if ([SimSigTel]::MainFormHwnd -eq [IntPtr]::Zero) {
        Write-Output '{"status":"simsig_not_found"}'
        exit 0
    }

    # Send F6 to open telephone window
    [SimSigTel]::PostMessage([SimSigTel]::MainFormHwnd, 0x0100, [IntPtr]0x75, [IntPtr]::Zero) | Out-Null
    Start-Sleep -Milliseconds 50
    [SimSigTel]::PostMessage([SimSigTel]::MainFormHwnd, 0x0101, [IntPtr]0x75, [IntPtr]::Zero) | Out-Null

    # Verify it opened
    Start-Sleep -Milliseconds 500
    [SimSigTel]::FindWindows()

    if ([SimSigTel]::TelephoneHwnd -ne [IntPtr]::Zero) {
        Write-Output "{`"status`":`"opened`",`"simName`":`"$simNameJson`"}"
    } else {
        Write-Output "{`"status`":`"f6_sent_but_not_verified`",`"simName`":`"$simNameJson`"}"
    }
} catch {
    Write-Output "{`"error`":`"$($_.Exception.Message)`"}"
}
