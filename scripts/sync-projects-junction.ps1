param([switch]$Revert)
$ErrorActionPreference = 'Stop'
# OPTIONAL: pool the whole projects tree (session transcripts + state) into one directory.
# MUST be run with BOTH Qoder clients closed: the live session keeps writing its own
# transcript under ~/.qoder-cn/projects/<slug>/ and those writes would be lost.
# Per-slug project-memory junctions are already in place, so skipping this is fine.
# Revert:  powershell -File sync-projects-junction.ps1 -Revert
$h = $env:USERPROFILE
$src = Join-Path $h '.qoder\projects'
$cn  = Join-Path $h '.qoder-cn\projects'
$bk  = Join-Path $h '.qoder-cn\_premerge-20260918\projects-full'

function Is-Link($p) {
  $i = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
  return ($i -and ($i.Attributes -band [IO.FileAttributes]::ReparsePoint))
}

if ($Revert) {
  if (-not (Is-Link $cn)) { Write-Output 'NOT-A-LINK (nothing to revert)'; exit 0 }
  cmd /c rmdir "$cn" | Out-Null
  if (Test-Path -LiteralPath $bk) { Move-Item -LiteralPath $bk -Destination $cn; Write-Output "REVERTED from $bk" }
  else { Write-Output 'LINK-REMOVED, no backup found to restore' }
  exit 0
}

if (Is-Link $cn) { Write-Output 'ALREADY-LINK'; exit 0 }
$running = @(Get-Process | Where-Object { $_.Name -like '*Qoder*' -or $_.Name -like '*qoder*' })
if ($running.Count -gt 0) {
  Write-Output ('ABORT: Qoder process still running: ' + (($running | Select-Object -First 1 -ExpandProperty Name)))
  Write-Output 'Close both clients first, or keep the per-slug memory junctions and skip this step.'
  exit 1
}
New-Item -ItemType Directory -Path (Split-Path $bk) -Force | Out-Null
if (Test-Path -LiteralPath $bk) { throw "backup slot already exists: $bk" }
Move-Item -LiteralPath $cn -Destination $bk
Write-Output "MOVED $cn -> $bk"
New-Item -ItemType Junction -Path $cn -Target $src | Out-Null
Write-Output "JUNCTION $cn -> $src"
Write-Output 'DONE - both clients now share one session-history pool (revert with -Revert)'
