<#
  备用通道：把本机网关通过 SSH 反向隧道暴露到你自己服务器上的 8898（nginx TLS）。
  相比 Cloudflare 快速隧道：不经过第三方、延迟从 1-3 秒降到毫秒级、不受 IPv6/Happy Eyeballs 影响。

  前提（服务器上，各跑一次）：
    bash install-nginx-tls.sh        # 生成 CA + 证书 + 8898 站点
    # 安全组放行 8898（否则服务器访问自己的公网 IP:8898 会超时）
    # 宿主信任本机 CA：
    #   Environment="NODE_EXTRA_CA_CERTS=/opt/qq-agent/tls/ca.crt"

  用法：
    powershell -ExecutionPolicy Bypass -File scripts/run-tunnel-local.ps1 -Host user@1.2.3.4 -Key ~/.ssh/xxx
  然后在服务器上：
    bash set-gateway-url.sh https://1.2.3.4:8898 <网关令牌>
    bash set-tts-url.sh     https://1.2.3.4:8898/v1
#>
param(
  [Parameter(Mandatory=$true)][string]$Host,                  # 例如 root@<你的服务器IP>
  [string]$Key = "$env:USERPROFILE\.ssh\dsh_ed25519_stats",
  [int]$LocalPort = 8899,
  [int]$RemotePort = 8899                                      # 服务器侧的 127.0.0.1:8899，给 nginx 用
)
$ErrorActionPreference = 'Stop'
$ssh = (Get-Command ssh.exe -ErrorAction SilentlyContinue).Source
if (-not $ssh) { throw '找不到 ssh.exe' }

$attempt = 0
while ($true) {
  $attempt += 1
  Write-Host "[$(Get-Date -Format 'HH:mm:ss')] 建立反向隧道（第 $attempt 次）：$Host  $RemotePort -> 127.0.0.1:$LocalPort"
  & $ssh -i $Key -N `
    -o ExitOnForwardFailure=yes `
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 `
    -o ConnectTimeout=15 `
    -R "127.0.0.1:${RemotePort}:127.0.0.1:${LocalPort}" $Host
  $code = $LASTEXITCODE
  if ($code -eq 0) { Write-Host '隧道正常退出，不再重连'; break }
  Write-Host "[$(Get-Date -Format 'HH:mm:ss')] 隧道断开（code=$code），5 秒后重连"
  Start-Sleep -Seconds 5
}
