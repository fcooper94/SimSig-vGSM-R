Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class TitleCheck {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EC cb, IntPtr l);
    public delegate bool EC(IntPtr h, IntPtr l);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@

[TitleCheck]::EnumWindows({
    param($h, $l)
    $s = New-Object System.Text.StringBuilder 256
    [TitleCheck]::GetWindowText($h, $s, 256) | Out-Null
    $t = $s.ToString()
    if ($t -like '*SimSig*') {
        Write-Host "Title: $t"
        $codes = $t.ToCharArray() | ForEach-Object { [int]$_ }
        Write-Host "Char codes: $codes"
    }
    return $true
}, [IntPtr]::Zero) | Out-Null
