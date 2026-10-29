param(
  [Parameter(Mandatory=$true)][string]$Url,
  [Parameter(Mandatory=$true)][string]$Out,
  [int64]$ChunkBytes = 64MB
)

# Chunked sequential download.
# 为什么不用 curl -C -：目标地址可能 302 到不认 Range 的 CDN，那一跳会返回 200 整包，
# curl 于是把已下的部分覆盖掉（实测文件大小会倒退）。按块下载 + 逐块校验没有这个问题。
$ErrorActionPreference = 'Stop'
$curl = 'C:\Windows\System32\curl.exe'

$head = & $curl -sIL $Url 2>$null
$lenVals = $head | Select-String -Pattern '^content-length:\s*(\d+)' -CaseSensitive:$false |
           ForEach-Object { [int64]$_.Matches[0].Groups[1].Value }
if (-not $lenVals) { throw "no content-length: $Url" }
$len = ($lenVals | Select-Object -Last 1)

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$prefix = "${Out}.chunk"
$total = [int64][math]::Ceiling($len / $ChunkBytes)
Write-Output ("total {0:N0} MB in {1} chunks of {2:N0} MB" -f ($len/1MB), $total, ($ChunkBytes/1MB))

$sw = [Diagnostics.Stopwatch]::StartNew()
for ($i = 0; $i -lt $total; $i++) {
  $start = [int64]($i * $ChunkBytes)
  $end = [int64][math]::Min($len - 1, $start + $ChunkBytes - 1)
  $expect = $end - $start + 1
  $part = "${prefix}$i"
  if ((Test-Path $part) -and ((Get-Item $part).Length -eq $expect)) { continue }

  $ok = $false
  for ($try = 1; $try -le 6 -and -not $ok; $try++) {
    & $curl -sS -L --retry 3 --retry-delay 3 --connect-timeout 20 --max-time 900 `
        -r "$start-$end" -o $part $Url 2>$null
    if ((Test-Path $part) -and ((Get-Item $part).Length -eq $expect)) { $ok = $true }
    else { if (Test-Path $part) { Remove-Item $part -Force }; Start-Sleep -Seconds 3 }
  }
  if (-not $ok) { throw "chunk $i failed after retries" }
  $done = Get-ChildItem "$prefix*" | Measure-Object Length -Sum
  Write-Output ("chunk {0}/{1}  {2:N0}/{3:N0} MB  {4:N2} MB/s" -f ($i+1), $total, ($done.Sum/1MB), ($len/1MB), ($done.Sum/1MB/$sw.Elapsed.TotalSeconds))
}

$outStream = [System.IO.File]::Create($Out)
try {
  for ($i = 0; $i -lt $total; $i++) {
    $bytes = [System.IO.File]::ReadAllBytes("${prefix}$i")
    $outStream.Write($bytes, 0, $bytes.Length)
  }
} finally { $outStream.Close() }
Remove-Item "$prefix*" -Force -ErrorAction SilentlyContinue

$final = (Get-Item $Out).Length
if ($final -ne $len) { throw "merged size mismatch: $final != $len" }
Write-Output ("done {0:N0} MB in {1:N0}s" -f ($final/1MB), $sw.Elapsed.TotalSeconds)
