#requires -Version 7.0
#requires -PSEdition Core
param(
  [string]$WorkDir = 'D:\tmp\dlp-fixture-selftest',
  [switch]$WithWord
)
$ErrorActionPreference = 'Stop'
$fail = 0
$lines = New-Object System.Collections.Generic.List[string]
function Add-Result($name, $ok, $detail) {
  if ($ok) { $script:lines.Add("PASS|$name") }
  else { $script:lines.Add("FAIL|$name|$detail"); $script:fail++ }
}
function Get-Head([string]$p) {
  if (-not (Test-Path -LiteralPath $p)) { return 'MISSING' }
  $stream = [IO.File]::OpenRead($p)
  try {
    $bytes = [byte[]]::new(4)
    if ($stream.Read($bytes, 0, 4) -ne 4) { throw "Truncated output: $p" }
    return ($bytes | ForEach-Object { $_.ToString('x2') }) -join ' '
  } finally { $stream.Dispose() }
}
$WorkDir = Join-Path $WorkDir ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $WorkDir | Out-Null
Write-Output ('RUNTIME=' + $PSVersionTable.PSVersion + '|DIR=' + $WorkDir)
$office = Join-Path $env:USERPROFILE '.qoder\skills\office-docs\scripts\office.js'
$spec = Join-Path $WorkDir 'spec.json'
$plain = Join-Path $WorkDir 'plain.xlsx'
$enc = Join-Path $WorkDir 'enc.xlsx'

$marker = 'DLP-fixture-A1'
[IO.File]::WriteAllText($spec, '{"sheets":[{"name":"fixture","columns":["cell","note"],"rows":[["' + $marker + '","authorized-write-check"],["42","number"]]}]}', (New-Object System.Text.UTF8Encoding($false)))
node $office write-xlsx $spec -o $plain | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Excel fixture generation failed' }
Add-Result 'script_written_file_is_plain_zip' ((Get-Head $plain) -like '50 4b*') ('head=' + (Get-Head $plain))

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$readBack = ''
try {
  $wb = $excel.Workbooks.Open($plain, 0, $true)
  $wb.SaveAs($enc, 51)
  $wb.Close($false)
  $wb = $excel.Workbooks.Open($enc, 0, $true)
  $readBack = [string]$wb.Worksheets.Item(1).Cells.Item(2, 1).Text
  $wb.Close($false)
} finally {
  $excel.Quit()
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
}

Add-Result 'authorized_write_becomes_cipher' (((Get-Head $enc) -ne 'MISSING') -and ((Get-Head $enc) -notlike '50 4b*')) ('head=' + (Get-Head $enc))
Add-Result 'authorized_read_roundtrip' ($readBack -ceq $marker) ("readBack=[$readBack]")

$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'   # the negative control writes to stderr on purpose
node $office read-xlsx $enc 2>$null | Out-Null
$nodeExit = $LASTEXITCODE
$ErrorActionPreference = $prevEap
Add-Result 'unauthorized_read_denied' ($nodeExit -ne 0) ("node_exit=$nodeExit (expect non-zero: cipher text for non-authorized process)")

if ($WithWord) {
  $specW = Join-Path $WorkDir 'spec-word.json'
  # SaveAs2 accepts ref object; use explicit strings at the COM boundary.
  [string]$wsrc = Join-Path $WorkDir 'plain-word.docx'
  [string]$wdocx = Join-Path $WorkDir 'enc-word.docx'
  [string]$wpdf = Join-Path $WorkDir 'enc-word.pdf'
  [IO.File]::WriteAllText($specW, '{"blocks":[{"type":"heading","level":1,"text":"' + $marker + '"},{"type":"paragraph","text":"word fixture for transparent encryption"}]}', (New-Object System.Text.UTF8Encoding($false)))
  node $office write-docx $specW -o $wsrc | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Word fixture generation failed' }
  Add-Result 'word_source_is_plain_zip' ((Get-Head $wsrc) -eq '50 4b 03 04') ('head=' + (Get-Head $wsrc))

  $beforeWord = @(Get-Process WINWORD -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  $w = New-Object -ComObject Word.Application
  $created = @(Get-Process WINWORD -ErrorAction SilentlyContinue | Where-Object { $beforeWord -notcontains $_.Id })
  if ($created.Count -ne 1) { throw 'Cannot establish ownership of the Word instance; manual inspection required' }
  $wordProcess = $created[0]
  Write-Output ('WORD_PID=' + $wordProcess.Id + '|START=' + $wordProcess.StartTime.ToUniversalTime().ToString('o'))
  $w.Visible = $false
  $w.DisplayAlerts = 0
  $wText = ''
  $sourceText = ''
  $docs = $null
  $d = $null
  $range = $null
  try {
    $docs = $w.Documents
    Write-Output 'STEP=word_open'
    $d = $docs.Open($wsrc, $false, $true)
    $range = $d.Content
    $sourceText = $range.Text
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($range)
    $range = $null
    Write-Output 'STEP=word_saveas'
    $d.SaveAs2($wdocx, 16)
    Write-Output 'STEP=word_pdf_export'
    $d.ExportAsFixedFormat($wpdf, 17)
    $d.Close(0)
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($d)
    $d = $null
    Write-Output 'STEP=word_reopen'
    $d = $docs.Open($wdocx, $false, $true)
    $range = $d.Content
    $wText = $range.Text
  } finally {
    if ($null -ne $range) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($range) }
    if ($null -ne $d) { $d.Close(0); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($d) }
    if ($null -ne $docs) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($docs) }
    $w.Quit()
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($w)
  }
  Add-Result 'word_owned_process_exited' ($wordProcess.WaitForExit(10000)) ('pid=' + $wordProcess.Id)
  Add-Result 'word_saveas_becomes_cipher' (((Get-Head $wdocx) -ne 'MISSING') -and ((Get-Head $wdocx) -notlike '50 4b*')) ('head=' + (Get-Head $wdocx))
  Add-Result 'word_pdf_export_becomes_cipher' (((Get-Head $wpdf) -ne 'MISSING') -and ((Get-Head $wpdf) -notlike '25 50*')) ('head=' + (Get-Head $wpdf))
  Add-Result 'word_authorized_read_roundtrip' (($wText -ceq $sourceText) -and $wText.Contains($marker)) ('len=' + $wText.Length)
}

$lines.Add('SUMMARY|FAILCOUNT=' + $fail + '|dir=' + $WorkDir)
$lines | ForEach-Object { Write-Output $_ }
if ($fail -gt 0) { exit 1 }
