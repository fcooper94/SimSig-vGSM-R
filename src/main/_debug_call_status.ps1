Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class CallDebug {
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

    public const int LB_GETCOUNT = 0x018B;
    public const int LB_GETTEXT = 0x0189;
    public const int LB_GETTEXTLEN = 0x018A;
    public const int LB_GETITEMDATA = 0x0199;
    public const int PROCESS_VM_READ = 0x0010;

    public static string GetCallStatus(IntPtr hProcess, IntPtr objPtr) {
        if (hProcess == IntPtr.Zero || objPtr == IntPtr.Zero) return null;
        byte[] needle = Encoding.ASCII.GetBytes("Transferred");
        byte[] objBytes = new byte[200];
        int bytesRead = 0;
        if (!ReadProcessMemory(hProcess, objPtr, objBytes, objBytes.Length, out bytesRead)) return null;
        for (int off = 0; off + 4 <= bytesRead; off += 4) {
            int ptr = BitConverter.ToInt32(objBytes, off);
            if (ptr < 0x10000 || ptr > 0x7FFF0000) continue;
            byte[] strBuf = new byte[64];
            int strRead = 0;
            if (!ReadProcessMemory(hProcess, new IntPtr(ptr), strBuf, strBuf.Length, out strRead)) continue;
            for (int i = 0; i <= strRead - needle.Length; i++) {
                bool found = true;
                for (int j = 0; j < needle.Length; j++) {
                    if (strBuf[i+j] != needle[j]) { found = false; break; }
                }
                if (found) {
                    int end = i;
                    while (end < strRead && strBuf[end] != 0) end++;
                    return Encoding.ASCII.GetString(strBuf, i, end - i);
                }
            }
        }
        return null;
    }
}
"@

# Find TTelephoneForm
$teleHwnd = [IntPtr]::Zero
[CallDebug]::EnumWindows({
    param($h, $l)
    $s = New-Object System.Text.StringBuilder 256
    [CallDebug]::GetClassName($h, $s, 256) | Out-Null
    if ($s.ToString() -eq "TTelephoneForm") { $script:teleHwnd = $h; return $false }
    return $true
}, [IntPtr]::Zero) | Out-Null

if ($teleHwnd -eq [IntPtr]::Zero) { Write-Host "TTelephoneForm not found"; exit }

# Find TListBox child
$lbHwnd = [IntPtr]::Zero
[CallDebug]::EnumChildWindows($teleHwnd, {
    param($h, $l)
    $s = New-Object System.Text.StringBuilder 256
    [CallDebug]::GetClassName($h, $s, 256) | Out-Null
    if ($s.ToString() -eq "TListBox") { $script:lbHwnd = $h; return $false }
    return $true
}, [IntPtr]::Zero) | Out-Null

if ($lbHwnd -eq [IntPtr]::Zero) { Write-Host "TListBox not found"; exit }

$count = [CallDebug]::SendMessage($lbHwnd, [CallDebug]::LB_GETCOUNT, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32()
Write-Host "Listbox count: $count"

$procId = 0
[CallDebug]::GetWindowThreadProcessId($lbHwnd, [ref]$procId) | Out-Null
$hProc = [CallDebug]::OpenProcess([CallDebug]::PROCESS_VM_READ, $false, $procId)

for ($i = 0; $i -lt $count; $i++) {
    $len = [CallDebug]::SendMessage($lbHwnd, [CallDebug]::LB_GETTEXTLEN, [IntPtr]$i, [IntPtr]::Zero).ToInt32()
    $sb = New-Object System.Text.StringBuilder ($len + 1)
    [CallDebug]::SendMessage($lbHwnd, [CallDebug]::LB_GETTEXT, [IntPtr]$i, $sb) | Out-Null
    $text = $sb.ToString()

    $itemData = [CallDebug]::SendMessage($lbHwnd, [CallDebug]::LB_GETITEMDATA, [IntPtr]$i, [IntPtr]::Zero)
    $status = [CallDebug]::GetCallStatus($hProc, $itemData)

    Write-Host "[$i] LB_GETTEXT='$text'  itemData=$itemData  status='$status'"
}

if ($hProc -ne [IntPtr]::Zero) { [CallDebug]::CloseHandle($hProc) | Out-Null }
