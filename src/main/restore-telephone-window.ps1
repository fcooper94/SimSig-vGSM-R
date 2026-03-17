Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinRestore {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EC cb, IntPtr l);
    public delegate bool EC(IntPtr h, IntPtr l);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr i, int x, int y, int cx, int cy, uint f);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
"@

$found = $false
[WinRestore]::EnumWindows({
    param($h, $l)
    $s = New-Object System.Text.StringBuilder 256
    [WinRestore]::GetClassName($h, $s, 256)
    if ($s.ToString() -eq "TTelephoneForm") {
        # SWP_NOSIZE (0x01) | SWP_NOZORDER (0x04) — move to visible position, keep size
        [WinRestore]::SetWindowPos($h, [IntPtr]::Zero, 200, 200, 0, 0, 0x0001 -bor 0x0004) | Out-Null
        [WinRestore]::ShowWindow($h, 5) | Out-Null
        Write-Host "TTelephoneForm restored to (200, 200)"
        $script:found = $true
        return $false
    }
    return $true
}, [IntPtr]::Zero) | Out-Null

if (-not $found) {
    Write-Host "TTelephoneForm not found (not open)"
}
