param([switch]$Revert, [string]$Tag = '20260918')
$ErrorActionPreference = 'Stop'
# ⚠ 历史脚本（2026-09-18 迁移用），**保留仅供参考，别在新机器上照跑**：当前布局与它写的不同——
# `skills` / `scripts` 的链接目标是各自的真源（如 D:\qoder-cn-skills、~/.qoder/scripts），
# 而 `rules` / `memory` **不能建链**（客户端要求路径解析留在配置目录内，建链会被判非法），
# 它们靠 `sync-global-config.sh` / `sync-memory.sh` 保持两侧一致。要看现役布局就查那两个脚本。
# Make CN-side ~/.qoder-cn/{rules,skills,memory,scripts} point at ~/.qoder/<same> via junctions.
# Idempotent: already-linked dirs are reported and skipped. Originals go to
# ~/.qoder-cn/_premerge-<tag>/<name> so nothing is destroyed.
# Un-link:  powershell -File link-cn-dirs.ps1 -Revert   (restores the backup as a real dir)
$h = $env:USERPROFILE
$names = @('rules', 'skills', 'memory', 'scripts')
$base = Join-Path $h '.qoder-cn'
$src = Join-Path $h '.qoder'
$bk = Join-Path $base "_premerge-$Tag"

function Is-Link($p) {
  $i = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
  return ($i -and ($i.Attributes -band [IO.FileAttributes]::ReparsePoint))
}

foreach ($n in $names) {
  $link = Join-Path $base $n
  $tgt = Join-Path $src $n
  if ($Revert) {
    if (-not (Is-Link $link)) { Write-Output "SKIP $n (not a link)"; continue }
    cmd /c rmdir "$link" | Out-Null
    $slot = Join-Path $bk $n
    if (Test-Path -LiteralPath $slot) {
      Move-Item -LiteralPath $slot -Destination $link
      Write-Output "REVERTED $n from $slot"
    } else { Write-Output "UNLINKED $n (no backup to restore)" }
    continue
  }
  if (-not (Test-Path -LiteralPath $tgt)) { Write-Output "NO-TARGET $n"; continue }
  if (Is-Link $link) {
    Write-Output "ALREADY-LINK $n (target correctness asserted by verify-global-setup.js)"
    continue
  }
  if (-not (Test-Path -LiteralPath $bk)) { New-Item -ItemType Directory -Path $bk -Force | Out-Null }
  if (Test-Path -LiteralPath $link) {
    $slot = Join-Path $bk $n
    if (Test-Path -LiteralPath $slot) { Write-Output "SKIP $n (backup slot exists: $slot)"; continue }
    Move-Item -LiteralPath $link -Destination $slot
    Write-Output "BACKED-UP $n -> $slot"
  }
  New-Item -ItemType Junction -Path $link -Target $tgt | Out-Null
  Write-Output "LINKED $n -> $tgt"
}
Write-Output 'NOW-VERIFY: cmd /c dir /AL "%USERPROFILE%\.qoder-cn"  (链接项会带 <JUNCTION> 标记)'
