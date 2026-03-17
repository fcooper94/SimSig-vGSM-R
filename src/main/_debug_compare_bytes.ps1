Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class CmpBytes {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EC cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EC cb, IntPtr l);
    public delegate bool EC(IntPtr h, IntPtr l);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, StringBuilder l);
    [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
    [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
    [DllImport("kernel32.dll")] public static extern bool ReadProcessMemory(IntPtr proc, IntPtr addr, byte[] buf, int size, out int read);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    public const int LB_GETCOUNT=0x018B; public const int LB_GETTEXT=0x0189; public const int LB_GETTEXTLEN=0x018A; public const int LB_GETITEMDATA=0x0199;
    public const int PROCESS_VM_READ=0x0010;
}
"@

$teleHwnd = [IntPtr]::Zero
[CmpBytes]::EnumWindows({param($h,$l);$s=New-Object System.Text.StringBuilder 256;[CmpBytes]::GetClassName($h,$s,256)|Out-Null;if($s.ToString()-eq"TTelephoneForm"){$script:teleHwnd=$h;return $false};return $true},[IntPtr]::Zero)|Out-Null
if ($teleHwnd -eq [IntPtr]::Zero) { Write-Host "TTelephoneForm not found"; exit }

$lbHwnd = [IntPtr]::Zero
[CmpBytes]::EnumChildWindows($teleHwnd,{param($h,$l);$s=New-Object System.Text.StringBuilder 256;[CmpBytes]::GetClassName($h,$s,256)|Out-Null;if($s.ToString()-eq"TListBox"){$script:lbHwnd=$h;return $false};return $true},[IntPtr]::Zero)|Out-Null
if ($lbHwnd -eq [IntPtr]::Zero) { Write-Host "TListBox not found"; exit }

$count = [CmpBytes]::SendMessage($lbHwnd, [CmpBytes]::LB_GETCOUNT, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32()
$procId = 0
[CmpBytes]::GetWindowThreadProcessId($lbHwnd, [ref]$procId) | Out-Null
$hProc = [CmpBytes]::OpenProcess([CmpBytes]::PROCESS_VM_READ, $false, $procId)

Write-Host "Please tell me which of these are Transferred and which are Unanswered (check the telephone window)"
Write-Host ""

for ($i = 0; $i -lt $count; $i++) {
    $len = [CmpBytes]::SendMessage($lbHwnd, [CmpBytes]::LB_GETTEXTLEN, [IntPtr]$i, [IntPtr]::Zero).ToInt32()
    $sb = New-Object System.Text.StringBuilder ($len+1)
    [CmpBytes]::SendMessage($lbHwnd, [CmpBytes]::LB_GETTEXT, [IntPtr]$i, $sb) | Out-Null
    $itemData = [CmpBytes]::SendMessage($lbHwnd, [CmpBytes]::LB_GETITEMDATA, [IntPtr]$i, [IntPtr]::Zero)

    $buf = New-Object byte[] 64
    $read = 0
    [CmpBytes]::ReadProcessMemory($hProc, $itemData, $buf, $buf.Length, [ref]$read) | Out-Null

    Write-Host "[$i] $($sb.ToString())"
    # Print as rows of 4 bytes with decimal values for easy comparison
    for ($row = 0; $row -lt $read; $row += 4) {
        $hex = ($buf[$row..($row+3)] | ForEach-Object { $_.ToString("X2") }) -join " "
        $dec = ($buf[$row..($row+3)] | ForEach-Object { $_.ToString().PadLeft(3) }) -join " "
        Write-Host ("  off=0x{0:X2}: {1}  ({2})" -f $row, $hex, $dec)
    }
    Write-Host ""
}

[CmpBytes]::CloseHandle($hProc) | Out-Null
