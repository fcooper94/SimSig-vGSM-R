# mute-simsig.ps1 — Mute or unmute SimSig process audio via Windows Core Audio API
# Usage: mute-simsig.ps1 -Action mute|unmute
param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("mute", "unmute")]
    [string]$Action
)

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class AudioManager {
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumerator {}

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator {
        int NotImpl1();
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionManager2 {
        int NotImpl1();
        int NotImpl2();
        int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
    }

    [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionEnumerator {
        int GetCount(out int count);
        int GetSession(int index, out IAudioSessionControl session);
    }

    [Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionControl {
        int NotImpl1(); // QueryInterface handled by COM
    }

    [Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionControl2 {
        int NotImpl1();
        int NotImpl2();
        int NotImpl3();
        int NotImpl4();
        int NotImpl5();
        int NotImpl6();
        int NotImpl7();
        int NotImpl8();
        int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetProcessId(out uint pid);
    }

    [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ISimpleAudioVolume {
        int SetMasterVolume(float level, ref Guid eventContext);
        int GetMasterVolume(out float level);
        int SetMute(bool mute, ref Guid eventContext);
        int GetMute(out bool mute);
    }

    public static bool SetProcessMute(uint targetPid, bool mute) {
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        IMMDevice device;
        enumerator.GetDefaultAudioEndpoint(0, 1, out device);

        var iidSessionManager = typeof(IAudioSessionManager2).GUID;
        object o;
        device.Activate(ref iidSessionManager, 1, IntPtr.Zero, out o);
        var mgr = (IAudioSessionManager2)o;

        IAudioSessionEnumerator sessionEnum;
        mgr.GetSessionEnumerator(out sessionEnum);

        int count;
        sessionEnum.GetCount(out count);

        for (int i = 0; i < count; i++) {
            IAudioSessionControl ctl;
            sessionEnum.GetSession(i, out ctl);

            var ctl2 = ctl as IAudioSessionControl2;
            if (ctl2 == null) continue;

            uint pid;
            ctl2.GetProcessId(out pid);

            if (pid == targetPid) {
                var vol = ctl as ISimpleAudioVolume;
                if (vol != null) {
                    var guid = Guid.Empty;
                    vol.SetMute(mute, ref guid);
                    return true;
                }
            }
        }
        return false;
    }
}
"@

# Find SimSig process
$simsig = Get-Process -Name "SimSigLoader" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $simsig) {
    Write-Output '{"success":false,"error":"SimSig not found"}'
    exit
}

$mute = $Action -eq "mute"
try {
    $result = [AudioManager]::SetProcessMute([uint32]$simsig.Id, $mute)
    if ($result) {
        Write-Output "{`"success`":true,`"action`":`"$Action`",`"pid`":$($simsig.Id)}"
    } else {
        Write-Output '{"success":false,"error":"No audio session found for SimSig"}'
    }
} catch {
    Write-Output "{`"success`":false,`"error`":`"$($_.Exception.Message -replace '"', "'")`"}"
}
