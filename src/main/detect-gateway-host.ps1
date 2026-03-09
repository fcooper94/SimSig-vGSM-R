# detect-gateway-host.ps1
# Detects the gateway host IP from SimSig's window title and TCP connections.
# - Title contains "(server" -> return localhost (we are hosting)
# - Title contains "(client)" -> find server IP from active TCP connections

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class SimSigDetect {
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumCallback cb, IntPtr lParam);
    public delegate bool EnumCallback(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int maxLen);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    public static IntPtr MainHwnd = IntPtr.Zero;
    public static uint SimSigPid = 0;
    private static EnumCallback _mainCb;

    public static void FindSimSig() {
        MainHwnd = IntPtr.Zero;
        SimSigPid = 0;
        _mainCb = (hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            StringBuilder sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            if (sb.ToString().StartsWith("SimSig -")) {
                MainHwnd = hWnd;
                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                SimSigPid = pid;
                return false;
            }
            return true;
        };
        EnumWindows(_mainCb, IntPtr.Zero);
    }

    public static string GetTitle() {
        if (MainHwnd == IntPtr.Zero) return "";
        StringBuilder sb = new StringBuilder(512);
        GetWindowText(MainHwnd, sb, 512);
        return sb.ToString();
    }
}
"@

try {
    [SimSigDetect]::FindSimSig()
    if ([SimSigDetect]::MainHwnd -eq [IntPtr]::Zero) {
        Write-Output '{"error":"SimSig not found"}'
        exit 0
    }

    $title = [SimSigDetect]::GetTitle()
    $simPid = [SimSigDetect]::SimSigPid

    # Server mode: title contains "(server"
    if ($title -match '\(server') {
        Write-Output '{"host":"localhost","type":"server"}'
        exit 0
    }

    # Client mode: title contains "(client)"
    if ($title -match '\(client\)') {
        # Find server IP from TCP connections owned by SimSig
        $connections = Get-NetTCPConnection -OwningProcess $simPid -State Established -ErrorAction SilentlyContinue
        $remote = $connections | Where-Object {
            $_.RemoteAddress -ne '127.0.0.1' -and
            $_.RemoteAddress -ne '::1' -and
            $_.RemoteAddress -ne '0.0.0.0' -and
            $_.RemotePort -notin @(80, 443)
        } | Select-Object -First 1

        if ($remote) {
            $ip = $remote.RemoteAddress
            $ipJson = $ip -replace '\\', '\\' -replace '"', '\"'
            Write-Output "{`"host`":`"$ipJson`",`"type`":`"client`"}"
        } else {
            Write-Output '{"error":"Client mode but no server connection found"}'
        }
        exit 0
    }

    # Neither server nor client — single player or not in a session
    $titleJson = $title -replace '\\', '\\' -replace '"', '\"'
    Write-Output "{`"error`":`"Not in multiplayer session. Title: $titleJson`"}"
} catch {
    $msg = $_.Exception.Message -replace '"', '\"'
    Write-Output "{`"error`":`"$msg`"}"
}
