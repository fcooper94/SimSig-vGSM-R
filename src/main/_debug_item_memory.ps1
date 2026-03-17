Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class MemDump {
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

# Find TTelephoneForm -> TListBox
$teleHwnd = [IntPtr]::Zero
[MemDump]::EnumWindows({ param($h,$l); $s=New-Object System.Text.StringBuilder 256; [MemDump]::GetClassName($h,$s,256)|Out-Null; if($s.ToString()-eq"TTelephoneForm"){$script:teleHwnd=$h;return $false};return $true },[IntPtr]::Zero)|Out-Null

if ($teleHwnd -eq [IntPtr]::Zero) { Write-Host "TTelephoneForm not found"; exit }

$lbHwnd = [IntPtr]::Zero
[MemDump]::EnumChildWindows($teleHwnd,{ param($h,$l); $s=New-Object System.Text.StringBuilder 256; [MemDump]::GetClassName($h,$s,256)|Out-Null; if($s.ToString()-eq"TListBox"){$script:lbHwnd=$h;return $false};return $true },[IntPtr]::Zero)|Out-Null

if ($lbHwnd -eq [IntPtr]::Zero) { Write-Host "TListBox not found"; exit }

$count = [MemDump]::SendMessage($lbHwnd, [MemDump]::LB_GETCOUNT, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32()
$procId = 0
[MemDump]::GetWindowThreadProcessId($lbHwnd, [ref]$procId) | Out-Null
$hProc = [MemDump]::OpenProcess([MemDump]::PROCESS_VM_READ, $false, $procId)

for ($i = 0; $i -lt [Math]::Min($count, 2); $i++) {
    $len = [MemDump]::SendMessage($lbHwnd, [MemDump]::LB_GETTEXTLEN, [IntPtr]$i, [IntPtr]::Zero).ToInt32()
    $sb = New-Object System.Text.StringBuilder ($len+1)
    [MemDump]::SendMessage($lbHwnd, [MemDump]::LB_GETTEXT, [IntPtr]$i, $sb) | Out-Null

    $itemData = [MemDump]::SendMessage($lbHwnd, [MemDump]::LB_GETITEMDATA, [IntPtr]$i, [IntPtr]::Zero)
    Write-Host "=== Item $i : '$($sb.ToString())'  itemData=0x$($itemData.ToInt64().ToString('X')) ==="

    # Read 256 bytes from the object
    $buf = New-Object byte[] 256
    $read = 0
    $ok = [MemDump]::ReadProcessMemory($hProc, $itemData, $buf, $buf.Length, [ref]$read)
    Write-Host "ReadProcessMemory ok=$ok, read=$read bytes"

    # Print as hex + ASCII
    for ($row = 0; $row -lt $read; $row += 16) {
        $hex = ""
        $asc = ""
        for ($col = $row; $col -lt [Math]::Min($row+16, $read); $col++) {
            $b = $buf[$col]
            $hex += $b.ToString("X2") + " "
            $asc += if ($b -ge 32 -and $b -le 126) { [char]$b } else { "." }
        }
        Write-Host ("  {0:X4}: {1,-48} {2}" -f $row, $hex, $asc)
    }

    # Also print each 4-byte value as a potential pointer and read 32 bytes there
    Write-Host "  --- Pointer scan ---"
    for ($off = 0; $off -lt $read-3; $off += 4) {
        $ptr = [BitConverter]::ToInt32($buf, $off)
        if ($ptr -lt 0x10000 -or $ptr -gt 0x7FFF0000) { continue }
        $strBuf = New-Object byte[] 64
        $strRead = 0
        [MemDump]::ReadProcessMemory($hProc, [IntPtr]$ptr, $strBuf, $strBuf.Length, [ref]$strRead) | Out-Null
        $asc = [System.Text.Encoding]::ASCII.GetString($strBuf, 0, $strRead) -replace '[^\x20-\x7E]','.'
        Write-Host ("  off={0:X2} ptr=0x{1:X8} -> '{2}'" -f $off, $ptr, $asc.Substring(0, [Math]::Min(40, $asc.Length)))
    }
    Write-Host ""
}

[MemDump]::CloseHandle($hProc) | Out-Null
