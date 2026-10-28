param([int]$ActiveWindowMinutes = 30, [switch]$DryRun)
$ErrorActionPreference = 'Stop'
# Sync project-level memory (~/.qoder-cn/projects/<slug>/memory) into the single source
# (~/.qoder/projects/<slug>/memory) and link that one level, so both clients share project memory
# while session transcripts stay per-client.
# Idempotent. Never overwrites an existing file (conflicts are reported, not resolved).
# Skips slugs with an active session (transcript written within -ActiveWindowMinutes) to avoid
# swapping a directory the running client is writing into.

$h = $env:USERPROFILE
$cnP = Join-Path $h '.qoder-cn\projects'
$srcP = Join-Path $h '.qoder\projects'
$bk = Join-Path $h '.qoder-cn\_premerge-20260918\project-memory'
$now = Get-Date

function Is-Link($p) {
  $i = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
  return ($i -and ($i.Attributes -band [IO.FileAttributes]::ReparsePoint))
}

$srcSlugs = @{}
foreach ($d in Get-ChildItem -LiteralPath $srcP -Directory) { $srcSlugs[$d.Name.ToLower()] = $d.Name }

foreach ($d in Get-ChildItem -LiteralPath $cnP -Directory) {
  $slug = $d.Name
  $mem = Join-Path $d.FullName 'memory'
  if (-not (Test-Path -LiteralPath $mem)) { continue }
  if (Is-Link $mem) { Write-Output "ALREADY-LINK $slug"; continue }
  $live = @(Get-ChildItem -LiteralPath $d.FullName -Filter '*.jsonl' -File -ErrorAction SilentlyContinue |
    Where-Object { ($now - $_.LastWriteTime).TotalMinutes -lt $ActiveWindowMinutes })
  if ($live.Count -gt 0) { Write-Output "SKIP-ACTIVE $slug (session writing now)"; continue }
  $key = $slug.ToLower()
  if (-not $srcSlugs.ContainsKey($key)) { Write-Output "NO-SOURCE-SLUG $slug (left as real dir)"; continue }
  $tgt = Join-Path $srcP (Join-Path $srcSlugs[$key] 'memory')
  if (-not (Test-Path -LiteralPath $tgt)) { New-Item -ItemType Directory -Path $tgt -Force | Out-Null }
  $files = @(Get-ChildItem -LiteralPath $mem -File -ErrorAction SilentlyContinue)
  $copied = 0
  foreach ($f in $files) {
    $dst = Join-Path $tgt $f.Name
    if (Test-Path -LiteralPath $dst) {
      if ((Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash) {
        Write-Output "CONFLICT $slug/$($f.Name) (kept real-source version, CN copy left in place)"
      }
      continue
    }
    if (-not $DryRun) { Copy-Item -LiteralPath $f.FullName -Destination $dst }
    $copied++
  }
  if ($DryRun) { Write-Output "DRY ${slug} - would flow $copied file(s) and link"; continue }
  if ($copied -gt 0) { Write-Output "FLOWED ${slug} - $copied file(s) into real source" }
  New-Item -ItemType Directory -Path $bk -Force | Out-Null
  $slot = Join-Path $bk $slug
  if (Test-Path -LiteralPath $slot) { Write-Output "SKIP $slug (backup slot exists)"; continue }
  Move-Item -LiteralPath $mem -Destination $slot
  New-Item -ItemType Junction -Path $mem -Target $tgt | Out-Null
  Write-Output "LINKED $slug -> $($srcSlugs[$key]) (backup at $slot)"
}
Write-Output 'NOW-VERIFY: node ~/.qoder/scripts/verify-global-setup.js'
