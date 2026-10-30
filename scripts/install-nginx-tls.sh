#!/usr/bin/env bash
# 在服务器上启用「本地专线」：把网关通过 ssh 反向隧道 + nginx TLS 暴露到 <服务器IP>:8898。
#
# 用法（服务器上，root）：
#   bash install-nginx-tls.sh <你的服务器公网IP>
#
# IP 用参数传，不写死在仓库里。
set -euo pipefail

SERVER_IP="${1:-}"
SERVER_IP="${SERVER_IP%$'\r'}"
if [[ -z "$SERVER_IP" ]]; then
  echo "用法：bash install-nginx-tls.sh <你的服务器公网IP>" >&2
  echo "（这个 IP 只用于证书 SAN 与 nginx server_name，不会出现在仓库里）" >&2
  exit 1
fi

TLS=/opt/qq-agent/tls
mkdir -p "$TLS" && cd "$TLS"

# 自建小 CA，再用它签服务器证书：Node 的 NODE_EXTRA_CA_CERTS 要的是"CA 证书"，
# 直接塞自签叶子证书会被拒（缺 CA:true），这点实测过。
if [[ ! -f ca.key || ! -f ca.crt ]]; then
  openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -keyout ca.key -out ca.crt -subj "/CN=qq-agent-sing-local-ca" 2>/dev/null
fi

cat > san.cnf <<EEOF
subjectAltName = IP:${SERVER_IP}, DNS:localhost, IP:127.0.0.1
extendedKeyUsage = serverAuth
basicConstraints = CA:FALSE
EEOF

openssl req -newkey rsa:2048 -sha256 -nodes -keyout server.key -out server.csr \
  -subj "/CN=sing-gateway" 2>/dev/null
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 3650 -sha256 -extfile san.cnf -out server.crt 2>/dev/null
chmod 600 ca.key server.key; chmod 644 ca.crt server.crt

echo "=== 证书链自检 ==="
openssl verify -CAfile ca.crt server.crt
openssl x509 -in server.crt -noout -text | grep -A1 'Subject Alternative Name' || true

echo "=== 写 nginx 站点（8898 TLS → ssh 反向隧道的 127.0.0.1:8899）==="
cat > /etc/nginx/conf.d/sing-gateway.conf <<EEOF
# singPlugin 换声网关的 TLS 反代。
# 链路：你的电脑 --ssh -R--> 本机 127.0.0.1:8899 --> 本文件 --> QQ Agent 宿主
# 自签 CA + Bearer 令牌；宿主侧用 NODE_EXTRA_CA_CERTS 信任 ${TLS}/ca.crt。
server {
    listen 8898 ssl;
    server_name ${SERVER_IP};

    ssl_certificate     ${TLS}/server.crt;
    ssl_certificate_key ${TLS}/server.key;
    ssl_protocols       TLSv1.2 TLSv1.3;

    # 换声要几十秒，别让 nginx 先断
    proxy_read_timeout  300s;
    proxy_send_timeout  300s;
    client_max_body_size 100m;

    location / {
        proxy_pass         http://127.0.0.1:8899;
        proxy_http_version 1.1;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_buffering    off;
    }
}
EEOF

nginx -t && systemctl reload nginx
echo "✅ 完成。三件事别忘了："
echo "   ① 安全组放行 8898；② 本机起隧道（scripts/run-tunnel-local.ps1）；"
echo "   ③ 宿主信任 CA：Environment=\"NODE_EXTRA_CA_CERTS=${TLS}/ca.crt\""
