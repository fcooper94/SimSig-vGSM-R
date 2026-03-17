Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class TeleChildren {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EC cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EC cb, IntPtr l);
    public delegate bool EC(IntPtr h, IntPtr l);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
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
[TeleChildren]::EnumWindows({
    param($h,$l); $s=New-Object System.Text.StringBuilder 256
    [TeleChildren]::GetClassName($h,$s,256)|Out-Null
    if($s.ToString()-eq"TTelephoneForm"){$script:teleHwnd=$h;return $false}
    return $true
},[IntPtr]::Zero)|Out-Null

if ($teleHwnd -eq [IntPtr]::Zero) { Write-Host "TTelephoneForm not found"; exit }
Write-Host "TTelephoneForm hwnd=$teleHwnd"

# Enumerate all child windows
Write-Host "`n--- Child windows ---"
[TeleChildren]::EnumChildWindows($teleHwnd, {
    param($h,$l)
    $cls=New-Object System.Text.StringBuilder 256
    $txt=New-Object System.Text.StringBuilder 256
    [TeleChildren]::GetClassName($h,$cls,256)|Out-Null
    [TeleChildren]::GetWindowText($h,$txt,256)|Out-Null
    # For listbox-like controls, get item count
    $count = [TeleChildren]::SendMessage($h, [TeleChildren]::LB_GETCOUNT, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32()
    Write-Host ("  hwnd={0}  class={1}  text='{2}'  lbcount={3}" -f $h, $cls.ToString(), $txt.ToString(), $count)
    return $true
}, [IntPtr]::Zero)|Out-Null

# Now scan listbox item memory for "JO" (0x4A 0x4F)
$lbHwnd = [IntPtr]::Zero
[TeleChildren]::EnumChildWindows($teleHwnd,{
    param($h,$l); $s=New-Object System.Text.StringBuilder 256
    [TeleChildren]::GetClassName($h,$s,256)|Out-Null
    if($s.ToString()-eq"TListBox"){$script:lbHwnd=$h;return $false}
    return $true
},[IntPtr]::Zero)|Out-Null

if ($lbHwnd -eq [IntPtr]::Zero) { Write-Host "TListBox not found"; exit }

$count = [TeleChildren]::SendMessage($lbHwnd, [TeleChildren]::LB_GETCOUNT, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32()
$procId = 0
[TeleChildren]::GetWindowThreadProcessId($lbHwnd, [ref]$procId) | Out-Null
$hProc = [TeleChildren]::OpenProcess([TeleChildren]::PROCESS_VM_READ, $false, $procId)

Write-Host "`n--- Scanning item memory for 'JO' (0x4A 0x4F) ---"
for ($i = 0; $i -lt $count; $i++) {
    $len = [TeleChildren]::SendMessage($lbHwnd, [TeleChildren]::LB_GETTEXTLEN, [IntPtr]$i, [IntPtr]::Zero).ToInt32()
    $sb = New-Object System.Text.StringBuilder ($len+1)
    [TeleChildren]::SendMessage($lbHwnd, [TeleChildren]::LB_GETTEXT, [IntPtr]$i, $sb) | Out-Null
    $text = $sb.ToString()
    $itemData = [TeleChildren]::SendMessage($lbHwnd, [TeleChildren]::LB_GETITEMDATA, [IntPtr]$i, [IntPtr]::Zero)
    Write-Host "Item $i : '$text'  itemData=0x$($itemData.ToInt64().ToString('X'))"

    # Read 512 bytes from object
    $buf = New-Object byte[] 512
    $read = 0
    [TeleChildren]::ReadProcessMemory($hProc, $itemData, $buf, $buf.Length, [ref]$read) | Out-Null

    # Scan raw bytes for "JO" (4A 4F)
    for ($b = 0; $b -lt $read-1; $b++) {
        if ($buf[$b] -eq 0x4A -and $buf[$b+1] -eq 0x4F) {
            Write-Host "  FOUND 'JO' at raw offset 0x$($b.ToString('X')) in object bytes"
        }
    }

    # Scan each 4-byte pointer target (read 256 bytes from each)
    for ($off = 0; $off -lt $read-3; $off += 4) {
        $ptr = [BitConverter]::ToInt32($buf, $off)
        if ($ptr -lt 0x10000 -or $ptr -gt 0x7FFF0000) { continue }
        $strBuf = New-Object byte[] 256
        $strRead = 0
        [TeleChildren]::ReadProcessMemory($hProc, [IntPtr]$ptr, $strBuf, $strBuf.Length, [ref]$strRead) | Out-Null
        for ($b2 = 0; $b2 -lt $strRead-1; $b2++) {
            if ($strBuf[$b2] -eq 0x4A -and $strBuf[$b2+1] -eq 0x4F) {
                $ctx = [System.Text.Encoding]::ASCII.GetString($strBuf, [Math]::Max(0,$b2-4), [Math]::Min(20, $strRead-[Math]::Max(0,$b2-4))) -replace '[^\x20-\x7E]','.'
                Write-Host "  FOUND 'JO' at ptr=0x$($ptr.ToString('X'))+0x$($b2.ToString('X')) (obj+0x$($off.ToString('X'))) context='$ctx'"
            }
        }
    }
    Write-Host ""
}

[TeleChildren]::CloseHandle($hProc) | Out-Null
