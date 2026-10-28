param(
  [Parameter(Mandatory = $true)][string]$Src,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$sheets = New-Object System.Collections.Generic.List[object]
function Get-ArrVal($obj, $rr, $cc) {
  if ($obj -is [System.Array]) { return $obj.GetValue($rr, $cc) }
  return $obj
}
try {
  $wb = $excel.Workbooks.Open($Src, 0, $true)
  foreach ($ws in $wb.Worksheets) {
    $ur = $ws.UsedRange
    $rows = $ur.Rows.Count
    $cols = $ur.Columns.Count
    $vals = $ur.Value2
    $forms = $ur.Formula
    $matrix = New-Object System.Collections.Generic.List[object]
    for ($r = 1; $r -le $rows; $r++) {
      $rowArr = New-Object System.Collections.Generic.List[object]
      for ($c = 1; $c -le $cols; $c++) {
        $cell = $ur.Cells.Item($r, $c)
        $font = $cell.Font
        $rowArr.Add([ordered]@{
          value = (Get-ArrVal $vals $r $c)
          formula = (Get-ArrVal $forms $r $c)
          text = [string]$cell.Text
          numFmt = [string]$cell.NumberFormat
          fontName = [string]$font.Name
          fontSize = [double]$font.Size
          bold = [bool]$font.Bold
          fontColor = [int]$font.Color
          fillColor = [int]$cell.Interior.Color
          fillPattern = [int]$cell.Interior.Pattern
          hAlign = [int]$cell.HorizontalAlignment
          vAlign = [int]$cell.VerticalAlignment
          wrap = [bool]$cell.WrapText
          merged = [string]$cell.MergeArea.Address()
          rowHeight = [double]$cell.RowHeight
          colWidth = [double]$cell.ColumnWidth
          indent = [int]$cell.IndentLevel
          borders = [ordered]@{
            l = [int]$cell.Borders.Item(7).LineStyle
            r = [int]$cell.Borders.Item(10).LineStyle
            t = [int]$cell.Borders.Item(8).LineStyle
            b = [int]$cell.Borders.Item(9).LineStyle
            w = [double]$cell.Borders.Item(7).Weight
          }
        })
      }
      $matrix.Add($rowArr)
    }
    $sheets.Add([ordered]@{
      name = $ws.Name
      rows = $rows
      cols = $cols
      firstRow = $ur.Row
      firstCol = $ur.Column
      matrix = $matrix
    })
  }
  $wb.Close($false)
} finally {
  $excel.Quit()
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
}
$json = $sheets | ConvertTo-Json -Depth 8 -Compress
[IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Output ('DUMP_OK sheets=' + $sheets.Count + ' bytes=' + (Get-Item $Out).Length)
