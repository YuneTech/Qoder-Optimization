param(
  [Parameter(Mandatory = $true)][string]$Src,
  [Parameter(Mandatory = $true)][string]$Out
)
# Cell-by-cell comparison: original (may be DLP cipher text) vs rebuilt copy. Exit 1 on any failed assertion.
$ErrorActionPreference = 'Stop'
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$lines = New-Object System.Collections.Generic.List[string]
$fail = 0
function Add-Result($name, $ok, $detail) {
  if ($ok) { $script:lines.Add("PASS|$name") }
  else { $script:lines.Add("FAIL|$name|$detail"); $script:fail++ }
}
try {
  $wbS = $excel.Workbooks.Open($Src, 0, $true)
  $wbO = $excel.Workbooks.Open($Out, 0, $true)
  Add-Result 'sheetCount' ($wbS.Worksheets.Count -eq $wbO.Worksheets.Count) ("src=$($wbS.Worksheets.Count) out=$($wbO.Worksheets.Count)")
  for ($i = 1; $i -le [Math]::Min($wbS.Worksheets.Count, $wbO.Worksheets.Count); $i++) {
    $wsS = $wbS.Worksheets.Item($i); $wsO = $wbO.Worksheets.Item($i)
    Add-Result "sheetName$i" ($wsS.Name -eq $wsO.Name) ("src=$($wsS.Name) out=$($wsO.Name)")
    $urS = $wsS.UsedRange; $urO = $wsO.UsedRange
    Add-Result "usedRange$i" (($urS.Rows.Count -eq $urO.Rows.Count) -and ($urS.Columns.Count -eq $urO.Columns.Count)) ("src=$($urS.Address()) out=$($urO.Address())")
    $rows = [Math]::Min($urS.Rows.Count, $urO.Rows.Count)
    $cols = [Math]::Min($urS.Columns.Count, $urO.Columns.Count)
    $valDiff = 0; $textDiff = 0; $fontDiff = 0; $fillDiff = 0; $borderDiff = 0; $mergeDiff = 0; $sizeDiff = 0
    $samples = New-Object System.Collections.Generic.List[string]
    $mergesS = New-Object System.Collections.Generic.List[string]
    $mergesO = New-Object System.Collections.Generic.List[string]
    for ($r = 1; $r -le $rows; $r++) {
      for ($c = 1; $c -le $cols; $c++) {
        $cs = $urS.Cells.Item($r, $c); $co = $urO.Cells.Item($r, $c)
        $vs = $cs.Value2; $vo = $co.Value2
        $same = $false
        if ($null -eq $vs -and $null -eq $vo) { $same = $true }
        elseif (($vs -is [double] -or $vs -is [int]) -and ($vo -is [double] -or $vo -is [int])) { $same = ([Math]::Abs([double]$vs - [double]$vo) -lt 1e-9) }
        else { $same = ([string]$vs -eq [string]$vo) }
        if (-not $same) { $valDiff++; if ($samples.Count -lt 5) { $samples.Add("$($cs.Address()) val src=[$vs] out=[$vo]") } }
        if (([string]$cs.Text) -ne ([string]$co.Text)) { $textDiff++; if ($samples.Count -lt 5) { $samples.Add("$($cs.Address()) text src=[$($cs.Text)] out=[$($co.Text)]") } }
        if (([string]$cs.Font.Name -ne [string]$co.Font.Name) -or ([double]$cs.Font.Size -ne [double]$co.Font.Size) -or ([bool]$cs.Font.Bold -ne [bool]$co.Font.Bold)) { $fontDiff++ }
        if ([int]$cs.Interior.Color -ne [int]$co.Interior.Color) { $fillDiff++ }
        $bs = @($cs.Borders.Item(7).LineStyle, $cs.Borders.Item(10).LineStyle, $cs.Borders.Item(8).LineStyle, $cs.Borders.Item(9).LineStyle)
        $bo = @($co.Borders.Item(7).LineStyle, $co.Borders.Item(10).LineStyle, $co.Borders.Item(8).LineStyle, $co.Borders.Item(9).LineStyle)
        for ($k = 0; $k -lt 4; $k++) { if ([int]$bs[$k] -ne [int]$bo[$k]) { $borderDiff++; break } }
        $ms = [string]$cs.MergeArea.Address(); $mo = [string]$co.MergeArea.Address()
        if ($ms -match ':') { $mergesS.Add($ms) }
        if ($mo -match ':') { $mergesO.Add($mo) }
      }
    }
    for ($c = 1; $c -le $cols; $c++) { if ([Math]::Abs([double]$urS.Columns.Item($c).ColumnWidth - [double]$urO.Columns.Item($c).ColumnWidth) -gt 0.5) { $sizeDiff++ } }
    for ($r = 1; $r -le $rows; $r++) { if ([Math]::Abs([double]$urS.Rows.Item($r).RowHeight - [double]$urO.Rows.Item($r).RowHeight) -gt 0.2) { $sizeDiff++ } }
    if ((($mergesS | Sort-Object -Unique) -join ',') -ne (($mergesO | Sort-Object -Unique) -join ',')) { $mergeDiff = 1 }
    Add-Result "values$i" ($valDiff -eq 0) ("diff=$valDiff " + ($samples -join ' ; '))
    Add-Result "displayText$i" ($textDiff -eq 0) ("diff=$textDiff " + ($samples -join ' ; '))
    Add-Result "fonts$i" ($fontDiff -eq 0) "diff=$fontDiff"
    Add-Result "fills$i" ($fillDiff -eq 0) "diff=$fillDiff"
    Add-Result "borders$i" ($borderDiff -eq 0) "diff=$borderDiff"
    Add-Result "merges$i" ($mergeDiff -eq 0) "merge sets differ"
    Add-Result "gridSize$i" ($sizeDiff -eq 0) "diff=$sizeDiff"
  }
  $wbS.Close($false); $wbO.Close($false)
} finally {
  $excel.Quit()
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
}
$lines.Add('SUMMARY|FAILCOUNT=' + $fail)
($lines -join "`n") | ForEach-Object { Write-Output $_ }
if ($fail -gt 0) { exit 1 }
