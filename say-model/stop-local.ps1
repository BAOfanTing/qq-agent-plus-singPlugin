# 停掉本地 Breeze（唱歌前让出显存用）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File say-model\stop-local.ps1
param()
$repo = $PSScriptRoot
$pidFile = Join-Path $repo 'logs\breeze-local.pid'

$stopped = 0
Get-CimInstance Win32_Process -Filter "name='python.exe'" |
    Where-Object { $_.CommandLine -like '*breeze_infer.api*' } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Output "已停止本地 Breeze：pid=$($_.ProcessId)"
        $script:stopped++
    }

if (Test-Path $pidFile) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }
if ($script:stopped -eq 0) { Write-Output '本地 Breeze 本来就没在跑' }
exit 0
