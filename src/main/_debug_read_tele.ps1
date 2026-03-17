Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class LBR {
    [DllImport("user32.dll",CharSet=CharSet.Auto)] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
    [DllImport("user32.dll",CharSet=CharSet.Auto)] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, StringBuilder l);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, int m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCb cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumCb cb, IntPtr l);
    public delegate bool EnumCb(IntPtr h, IntPtr l);
    [DllImport("user32.dll",CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll",CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    public const int LB_GETCOUNT = 0x018B;
    public const int LB_GETTEXT = 0x0189;
    public const int LB_GETTEXTLEN = 0x018A;
}
"@

# Step 1: Find SimSig and close any existing TTelephoneForm
$simsig = [IntPtr]::Zero
$oldTele = [IntPtr]::Zero
$findCb = [LBR+EnumCb]{
    param($h, $l)
    $cls = New-Object System.Text.StringBuilder 256
    [LBR]::GetClassName($h, $cls, 256) | Out-Null
    $txt = New-Object System.Text.StringBuilder 256
    [LBR]::GetWindowText($h, $txt, 256) | Out-Null
    if ($txt.ToString().StartsWith("SimSig -")) { $script:simsig = $h }
    if ($cls.ToString() -eq "TTelephoneForm") { $script:oldTele = $h }
    return $true
}
[LBR]::EnumWindows($findCb, [IntPtr]::Zero)
Write-Output "SimSig=$simsig  OldTele=$oldTele"

if ($simsig -eq [IntPtr]::Zero) { Write-Output "SimSig not found"; exit }

# Close old telephone window if it exists
if ($oldTele -ne [IntPtr]::Zero) {
    Write-Output "Closing old TTelephoneForm..."
    [LBR]::PostMessage($oldTele, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    Start-Sleep -Milliseconds 500
}

# Step 2: Send F6 to open fresh telephone window
Write-Output "Sending F6..."
[LBR]::PostMessage($simsig, 0x0100, [IntPtr]0x75, [IntPtr]::Zero) | Out-Null
Start-Sleep -Milliseconds 50
[LBR]::PostMessage($simsig, 0x0101, [IntPtr]0x75, [IntPtr]::Zero) | Out-Null
Start-Sleep -Milliseconds 1000

# Step 3: Find the new TTelephoneForm
$tele = [IntPtr]::Zero
$findCb2 = [LBR+EnumCb]{
    param($h, $l)
    $cls = New-Object System.Text.StringBuilder 256
    [LBR]::GetClassName($h, $cls, 256) | Out-Null
    if ($cls.ToString() -eq "TTelephoneForm") { $script:tele = $h; return $false }
    return $true
}
[LBR]::EnumWindows($findCb2, [IntPtr]::Zero)

if ($tele -eq [IntPtr]::Zero) { Write-Output "TTelephoneForm not found after F6"; exit }
$vis = [LBR]::IsWindowVisible($tele)
Write-Output "New TTelephoneForm=$tele visible=$vis"

# Step 4: Find TListBox and read
$lb = [IntPtr]::Zero
$childCb = [LBR+EnumCb]{
    param($h, $l)
    $cls = New-Object System.Text.StringBuilder 256
    [LBR]::GetClassName($h, $cls, 256) | Out-Null
    if ($cls.ToString() -eq "TListBox") { $script:lb = $h; return $false }
    return $true
}
[LBR]::EnumChildWindows($tele, $childCb, [IntPtr]::Zero)

$count = [int][LBR]::SendMessage($lb, [LBR]::LB_GETCOUNT, [IntPtr]::Zero, [IntPtr]::Zero)
Write-Output "TListBox=$lb  LB_GETCOUNT=$count"

for ($i = 0; $i -lt $count -and $i -lt 20; $i++) {
    $len = [int][LBR]::SendMessage($lb, [LBR]::LB_GETTEXTLEN, [IntPtr]$i, [IntPtr]::Zero)
    $sb = New-Object System.Text.StringBuilder 512
    [LBR]::SendMessage($lb, [LBR]::LB_GETTEXT, [IntPtr]$i, $sb) | Out-Null
    Write-Output "  [$i] len=$len text=[$($sb.ToString())]"
}
