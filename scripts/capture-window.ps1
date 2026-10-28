# Capture a top-level window (by HWND) to a PNG file.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File capture-window.ps1 -Hwnd 1644040 -Out D:\path\shot.png
#        ... -Region 16,8,420,260 -Scale 0.5          window-relative crop + independent size knob
#        ... -Background                              PrintWindow instead of screen grab: no foreground, no cursor move
# Why: some apps (WeChat DevTools, Cocos editor) expose no screenshot API; the only evidence
# that a front-end change really ran is a pixel capture of its window.
# The MCP driver's own capture has no region/scale parameters, so image volume is controlled here.
param(
    [Parameter(Mandatory = $true)][int]$Hwnd,
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$Region,
    [double]$Scale = 1.0,
    [switch]$Background
)

if ($Scale -lt 0.1 -or $Scale -gt 1.0) { Write-Error "Scale must be between 0.1 and 1.0 (got $Scale)"; exit 2 }
$reg = @()
if ($Region) {
    # Accept "x,y,w,h" as one string: from bash / cmd a comma list arrives unsplit,
    # and [int[]] binding then yields one element instead of four.
    $reg = @($Region -split '[,;]' | ForEach-Object { ([int]$_) })
    if ($reg.Count -ne 4) { Write-Error "Region needs 4 integers: x,y,w,h (got $($reg.Count) from '$Region')"; exit 2 }
    if ($reg[2] -le 0 -or $reg[3] -le 0) { Write-Error "Region w/h must be positive (got $($reg[2])x$($reg[3]))"; exit 2 }
}

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct RECTW { public int Left; public int Top; public int Right; public int Bottom; }
public static class WinCap {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECTW r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
}
"@

# Without this, a DPI-unaware host reports logical rects while CopyFromScreen grabs
# physical pixels - the crop lands offset from the window on any scaled display.
[void][WinCap]::SetProcessDPIAware()

$h = [IntPtr]$Hwnd

$r = New-Object RECTW
if (-not [WinCap]::GetWindowRect($h, [ref]$r)) { Write-Error "GetWindowRect failed for hwnd $Hwnd"; exit 2 }

$w = $r.Right - $r.Left
$hgt = $r.Bottom - $r.Top
if ($w -le 0 -or $hgt -le 0) { Write-Error "window has no area: ${w}x${hgt}"; exit 2 }

$bmp = New-Object System.Drawing.Bitmap($w, $hgt)
$g = [System.Drawing.Graphics]::FromImage($bmp)

if ($Background) {
    # PrintWindow renders into our own DC: the window stays where it is, no foreground swap,
    # no cursor move, and occluded windows still come out complete. Minimized windows render blank.
    $style = [WinCap]::GetWindowLong($h, -16)
    if (($style -band 0x20000000) -ne 0) { Write-Error "window is minimized; PrintWindow would save a blank image"; $g.Dispose(); $bmp.Dispose(); exit 3 }
    $hdc = $g.GetHdc()
    # 0x2 = PW_RENDERFULLCONTENT, needed for DirectComposition / Chromium-based windows
    $ok = [WinCap]::PrintWindow($h, $hdc, 2)
    $g.ReleaseHdc($hdc)
    if (-not $ok) { Write-Error "PrintWindow failed for hwnd $Hwnd"; $g.Dispose(); $bmp.Dispose(); exit 4 }
} else {
    [void][WinCap]::ShowWindowAsync($h, 9)   # SW_RESTORE if minimized
    [void][WinCap]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 600
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $hgt)))
}
$g.Dispose()

# crop first, then scale - scaling a cropped image is what actually cuts the encoded bytes
if ($reg.Count -eq 4) {
    if ($reg[0] -lt 0 -or $reg[1] -lt 0 -or ($reg[0] + $reg[2]) -gt $bmp.Width -or ($reg[1] + $reg[3]) -gt $bmp.Height) {
        Write-Error ("region {0},{1} {2}x{3} outside window {4}x{5}" -f $reg[0], $reg[1], $reg[2], $reg[3], $bmp.Width, $bmp.Height)
        $bmp.Dispose(); exit 2
    }
    $crop = New-Object System.Drawing.Bitmap($reg[2], $reg[3])
    $cg = [System.Drawing.Graphics]::FromImage($crop)
    $cg.DrawImage($bmp, (New-Object System.Drawing.Rectangle(0, 0, $reg[2], $reg[3])),
        (New-Object System.Drawing.Rectangle($reg[0], $reg[1], $reg[2], $reg[3])),
        [System.Drawing.GraphicsUnit]::Pixel)
    $cg.Dispose(); $bmp.Dispose(); $bmp = $crop
}

if ($Scale -lt 1.0) {
    $nw = [int][Math]::Round($bmp.Width * $Scale)
    $nh = [int][Math]::Round($bmp.Height * $Scale)
    if ($nw -lt 1 -or $nh -lt 1) { Write-Error "scale would collapse the image to 0px"; $bmp.Dispose(); exit 2 }
    $scaled = New-Object System.Drawing.Bitmap($nw, $nh)
    $sg = [System.Drawing.Graphics]::FromImage($scaled)
    $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubicSmudge
    $sg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $sg.DrawImage($bmp, 0, 0, $nw, $nh)
    $sg.Dispose(); $bmp.Dispose(); $bmp = $scaled
}

$outDir = Split-Path -Parent $Out
if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$fw = $bmp.Width; $fh = $bmp.Height
$bmp.Dispose()

$bytes = (Get-Item $Out).Length
$mode = if ($Background) { 'printwindow' } else { 'screen' }
$cropTxt = if ($reg.Count -eq 4) { " region=$($reg -join ',')" } else { '' }
Write-Output ("saved {0} {1}x{2} {3} bytes mode={4}{5} scale={6}" -f $Out, $fw, $fh, $bytes, $mode, $cropTxt, $Scale)
