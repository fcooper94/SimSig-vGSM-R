Write-Host "Testing Add-Type compilation..."
try {
    Add-Type -ErrorAction Stop @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class CompileTest {
    [DllImport("user32.dll")]
    public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int processId);

    [DllImport("kernel32.dll")]
    public static extern IntPtr OpenProcess(int dwDesiredAccess, bool bInheritHandle, int dwProcessId);

    [DllImport("kernel32.dll")]
    public static extern bool ReadProcessMemory(IntPtr hProcess, IntPtr lpBaseAddress, byte[] lpBuffer, int nSize, out int lpNumberOfBytesRead);

    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr hObject);

    public const int LB_GETITEMDATA = 0x0199;
    public const int PROCESS_VM_READ = 0x0010;

    public static IntPtr GetItemData(IntPtr hWnd, int index) {
        return IntPtr.Zero;
    }

    public static bool IsTransferredCall(IntPtr hProcess, IntPtr objPtr) {
        if (hProcess == IntPtr.Zero || objPtr == IntPtr.Zero) return false;
        byte[] needle = System.Text.Encoding.ASCII.GetBytes("Transferred");
        byte[] objBytes = new byte[200];
        int bytesRead = 0;
        if (!ReadProcessMemory(hProcess, objPtr, objBytes, objBytes.Length, out bytesRead)) return false;
        for (int off = 0; off + 4 <= bytesRead; off += 4) {
            int ptr = BitConverter.ToInt32(objBytes, off);
            if (ptr < 0x10000 || ptr > 0x7FFF0000) continue;
            byte[] strBuf = new byte[32];
            int strRead = 0;
            if (!ReadProcessMemory(hProcess, new IntPtr(ptr), strBuf, strBuf.Length, out strRead)) continue;
            for (int i = 0; i <= strRead - needle.Length; i++) {
                bool found = true;
                for (int j = 0; j < needle.Length; j++) {
                    if (strBuf[i + j] != needle[j]) { found = false; break; }
                }
                if (found) return true;
            }
        }
        return false;
    }
}
"@
    Write-Host "Compilation SUCCEEDED"
} catch {
    Write-Host "Compilation FAILED: $($_.Exception.Message)"
    if ($_.Exception.InnerException) {
        Write-Host "Inner: $($_.Exception.InnerException.Message)"
    }
}
