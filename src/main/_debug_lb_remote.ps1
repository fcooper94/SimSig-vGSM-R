# Debug: Find ALL TTelephoneForm windows and read each one

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class RemoteLB {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCb cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumCb cb, IntPtr l);
    public delegate bool EnumCb(IntPtr h, IntPtr l);
    [DllImport("user32.dll",CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll",CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll",CharSet=CharSet.Auto)] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a, bool i, uint p);
    [DllImport("kernel32.dll")] public static extern bool ReadProcessMemory(IntPtr p, IntPtr a, byte[] b, uint s, out uint r);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);

    public static List<IntPtr> allTele = new List<IntPtr>();
    public static void FindAll() {
        allTele.Clear();
        EnumCb cb = (h, l) => {
            var sb = new StringBuilder(256);
            GetClassName(h, sb, 256);
            if (sb.ToString() == "TTelephoneForm") allTele.Add(h);
            return true;
        };
        EnumWindows(cb, IntPtr.Zero);
    }

    public static IntPtr FindChild(IntPtr p, string c) {
        IntPtr f = IntPtr.Zero;
        EnumCb cb = (h, l) => {
            var sb = new StringBuilder(256);
            GetClassName(h, sb, 256);
            if (sb.ToString() == c) { f = h; return false; }
            return true;
        };
        EnumChildWindows(p, cb, IntPtr.Zero);
        return f;
    }
}
"@

[RemoteLB]::FindAll()
Write-Output "Found $([RemoteLB]::allTele.Count) TTelephoneForm window(s)"

foreach ($tele in [RemoteLB]::allTele) {
    $title = New-Object System.Text.StringBuilder 256
    [RemoteLB]::GetWindowText($tele, $title, 256) | Out-Null
    $vis = [RemoteLB]::IsWindowVisible($tele)
    $rect = New-Object RemoteLB+RECT
    [RemoteLB]::GetWindowRect($tele, [ref]$rect) | Out-Null
    Write-Output ""
    Write-Output "=== TTelephoneForm hwnd=$tele title=[$($title.ToString())] visible=$vis pos=$($rect.Left),$($rect.Top) ==="

    $lb = [RemoteLB]::FindChild($tele, "TListBox")
    if ($lb -eq [IntPtr]::Zero) { Write-Output "  No TListBox found"; continue }

    $count = [int][RemoteLB]::SendMessage($lb, 0x018B, [IntPtr]::Zero, [IntPtr]::Zero)
    Write-Output "  TListBox=$lb LB_GETCOUNT=$count"

    if ($count -le 0) { continue }

    # Open process
    $simPid = [uint32]0
    [RemoteLB]::GetWindowThreadProcessId($tele, [ref]$simPid) | Out-Null
    $proc = [RemoteLB]::OpenProcess(0x0038, $false, $simPid)
    if ($proc -eq [IntPtr]::Zero) { Write-Output "  Cannot open process (need admin)"; continue }

    for ($i = 0; $i -lt $count -and $i -lt 20; $i++) {
        $itemData = [RemoteLB]::SendMessage($lb, 0x0199, [IntPtr]$i, [IntPtr]::Zero)
        if ([int64]$itemData -le 0x10000) { continue }

        $objBuf = New-Object byte[] 4096
        $objRead = [uint32]0
        $ok = [RemoteLB]::ReadProcessMemory($proc, $itemData, $objBuf, 4096, [ref]$objRead)
        if (-not $ok -or $objRead -eq 0) { continue }

        $raw = [System.Text.Encoding]::Default.GetString($objBuf, 0, [int]$objRead)

        # Search for transfer/panel info
        $transferMatch = [regex]::Matches($raw, '(?i)transfer|panel\s*\d|Transferred')
        $strings = [regex]::Matches($raw, '[\x20-\x7E]{5,}')
        $first3 = ($strings | Select-Object -First 3 | ForEach-Object { $_.Value }) -join " | "

        if ($transferMatch.Count -gt 0) {
            $found = ($transferMatch | ForEach-Object { $_.Value }) -join ", "
            Write-Output "  [$i] TRANSFER: $found -- $first3"
        } else {
            Write-Output "  [$i] $first3"
        }
    }
    [RemoteLB]::CloseHandle($proc) | Out-Null
}
