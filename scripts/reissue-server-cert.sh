#!/bin/bash
# 用现有的 CA 重新签发服务器证书（幂等）。适用：证书过期、CA 被重建过、换了服务器 IP。
#   bash reissue-server-cert.sh <你的服务器公网IP>
set -e
SERVER_IP="${1:-}"
SERVER_IP="${SERVER_IP%$'\r'}"
[ -n "$SERVER_IP" ] || { echo "用法：bash reissue-server-cert.sh <服务器公网IP>" >&2; exit 1; }

TLS=/opt/qq-agent/tls
cd "$TLS" 2>/dev/null || { echo "缺 $TLS：先跑 install-nginx-tls.sh <IP>" >&2; exit 1; }
[ -f ca.key ] && [ -f ca.crt ] || { echo "缺 CA：先跑 install-nginx-tls.sh <IP>" >&2; exit 1; }

cat > san.cnf <<EOF
subjectAltName = IP:${SERVER_IP}, DNS:localhost, IP:127.0.0.1
extendedKeyUsage = serverAuth
basicConstraints = CA:FALSE
EOF

openssl req -newkey rsa:2048 -sha256 -nodes -keyout server.key -out server.csr \
  -subj "/CN=sing-gateway" 2>/dev/null
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 3650 -sha256 -extfile san.cnf -out server.crt 2>/dev/null
chmod 600 server.key; chmod 644 server.crt ca.crt

echo "=== 校验链 ==="
openssl verify -CAfile ca.crt server.crt
openssl x509 -in server.crt -noout -text | grep -A1 'Subject Alternative Name' || true
nginx -t >/dev/null && systemctl reload nginx && echo "nginx 已重载"
