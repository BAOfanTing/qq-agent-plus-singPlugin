#!/usr/bin/env bash
# 一键改「网关地址」——隧道换了域名时用（快速隧道每次重启都会变）。
#
# 要改的地方有两处，漏一处就会出现「插件能点歌、但语音条一直 fetch failed」：
#   1) 插件设置里的 gatewayUrl（插件走它）
#   2) 宿主 TTS 的 baseUrl（语音条走它，值是 <域名>/v1）
#
# 用法（在服务器上以 root 跑）：
#   bash set-gateway-url.sh https://new-domain.trycloudflare.com [网关令牌]
# 不给令牌就只改地址。

set -euo pipefail

URL="${1:-}"
TOKEN="${2:-}"
TOKEN="${TOKEN%$'\r'}"

if [[ -z "$URL" ]]; then
  echo "用法：bash set-gateway-url.sh https://你的域名 [网关令牌]" >&2
  exit 1
fi
URL="${URL%$'\r'}"                  # 去掉可能的 CR（Windows 复制粘贴/CRLF 上传常见）
URL="${URL%/}"                        # 去掉结尾斜杠
if [[ ! "$URL" =~ ^https:// ]]; then
  echo "地址必须是 https://（宿主禁止插件访问 http 内网地址）" >&2
  exit 1
fi

CONSOLE=$(su - qqagent -c 'cd /opt/qq-agent/app && ./manage.sh token' 2>/dev/null | tail -1)
H=(-H "x-console-token: $CONSOLE" -H 'Host: 127.0.0.1:3210' -H 'content-type: application/json')
BASE=http://127.0.0.1:3210

echo "▶ 1/3 自检：服务器能不能访问 $URL"
code=000
for i in 1 2 3; do                       # 快速隧道偶发抖动，三次都失败才算真不通
  code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$URL/health" 2>/dev/null || true)
  code="${code:-000}"
  [[ "$code" == "200" ]] && break
  sleep 2
done
if [[ "$code" != "200" ]]; then
  echo "   ⚠ /health 返回 [$code]（隧道没起来 / 网关没开 / 域名写错 / 云侧抖动）" >&2
  echo "   快速隧道是"尽力而为"的：多试几次通常就好；要长期稳定建议换固定域名（见 docs/TUNNEL.md）。" >&2
else
  echo "   ✓ /health 200"
fi

echo "▶ 2/3 插件设置 gatewayUrl"
values=$(python3 - "$URL" "$TOKEN" <<'PY'
import json, sys
url, token = sys.argv[1], sys.argv[2]
v = {"gatewayUrl": url}
if token:
    v["apiToken"] = token
print(json.dumps({"id": "sing", "values": v}, ensure_ascii=False))
PY
)
curl -s -m 20 -X POST "${H[@]}" -d "$values" "$BASE/api/plugins/settings" \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print("   ok=",d.get("ok"),"gatewayUrl=",(d.get("values") or {}).get("gatewayUrl"))'

echo "▶ 3/3 宿主 TTS baseUrl（语音条通道）"
resp=$(curl -s -m 20 -X POST "${H[@]}" -d "{\"tts\":{\"baseUrl\":\"$URL/v1\"}}" "$BASE/api/config" -w '\n%{http_code}')
ok_code=$(printf '%s' "$resp" | tail -n 1)
body="${resp%$'\n'*}"          # 去掉最后一行（状态码），剩下的就是响应体
body="${body:0:300}"
if [[ "$ok_code" != "200" ]]; then
  echo "   ⚠ 写 tts.baseUrl 返回 $ok_code：$body" >&2
  echo "   （重试一次）" >&2
  sleep 2
  curl -s -m 20 -X POST "${H[@]}" -d "{\"tts\":{\"baseUrl\":\"$URL/v1\"}}" "$BASE/api/config" -o /dev/null -w '   重试 http=%{http_code}\n'
fi
curl -s -m 10 "${H[@]}" "$BASE/api/config" \
  | python3 -c 'import json,sys;t=(json.load(sys.stdin).get("tts") or {});print("   回读 tts.baseUrl =",t.get("baseUrl"),"| enabled =",t.get("enabled"),"| timeout =",t.get("timeoutMs"))'

echo "✅ 完成。群里试一句「用语音唱一首雨爱」。"
