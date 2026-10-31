# 把当前 Cloudflare 隧道地址同步到服务器（插件 gatewayUrl + 宿主 tts.baseUrl）
#
# Cloudflare 快速隧道每次重启都会换地址，这个脚本省得你手动抄：
#   1. 从 logs\cloudflared.log 里读出最新的 https://xxx.trycloudflare.com
#   2. 通过 ssh 在服务器上跑 set-gateway-url.sh（插件地址）和 set-tts-url.sh（语音条通道）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\sync-host-url.ps1 -SshHost root@<你的服务器IP>
#   powershell -ExecutionPolicy Bypass -File scripts\sync-host-url.ps1 -SshHost root@<IP> -Url https://xxx.trycloudflare.com
param(
    [Parameter(Mandatory = $true)][string]$SshHost,
    [string]$Key = "$env:USERPROFILE\.ssh\dsh_ed25519_stats",
    [string]$Url = '',
    [string]$Token = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

# 1. 拿地址
if (-not $Url) {
    $log = Join-Path $repo 'logs\cloudflared.log'
    if (-not (Test-Path $log)) {
        throw "找不到 $log —— 先用 scripts\start-all.ps1 起隧道，或用 -Url 直接指定"
    }
    $Url = (Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches |
        ForEach-Object { $_.Matches } | ForEach-Object { $_.Value } |
        Select-Object -Unique | Select-Object -Last 1)
    if (-not $Url) { throw "日志里没有隧道地址，隧道可能没起来（看 $log）" }
}
Write-Host "隧道地址：$Url" -ForegroundColor Cyan

# 2. 拿令牌（从 gateway\config.json）
if (-not $Token) {
    $cfg = Join-Path $repo 'gateway\config.json'
    if (-not (Test-Path $cfg)) { throw "找不到 $cfg —— 先跑 scripts\start-all.ps1 生成配置" }
    $Token = (Get-Content $cfg -Raw -Encoding utf8 | ConvertFrom-Json).token
}
if (-not $Token) { throw 'gateway\config.json 里的 token 是空的，先在配置里设一个' }

# 3. 到服务器上改
$ssh = (Get-Command ssh.exe -ErrorAction SilentlyContinue).Source
if (-not $ssh) { throw '找不到 ssh.exe' }

$cmd = "bash /opt/qq-agent/set-gateway-url.sh $Url $Token && bash /opt/qq-agent/set-tts-url.sh $Url/v1"
Write-Host "▶ 同步到 $SshHost" -ForegroundColor Cyan
& $ssh -i $Key -o ConnectTimeout=15 -o BatchMode=yes $SshHost $cmd
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ 同步失败（退出码 $LASTEXITCODE）。检查 ssh 免密、服务器上的 set-*.sh 是否存在" -ForegroundColor Red
    exit 1
}
Write-Host '✓ 已同步：插件 gatewayUrl + 宿主 tts.baseUrl 都指向新隧道' -ForegroundColor Green
Write-Host '  接着在控制台 → 插件 → 点歌唱歌，点一次「检测登录」确认显示「说话后端在线」' -ForegroundColor Cyan
