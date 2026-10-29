#!/bin/bash
# 把宿主「语音回复(TTS)」的 baseUrl 指到指定地址，并跑一次真链路自检（控制台「试听」用的同一个接口）。
#   bash set-tts-url.sh https://127.0.0.1:8898/v1      # 本机反向隧道（推荐，稳定）
#   bash set-tts-url.sh https://xxx.trycloudflare.com/v1  # Cloudflare 备用
set -uo pipefail

URL="${1:-}"
URL="${URL%$'\r'}"
if [[ -z "$URL" ]]; then
  echo "用法：bash set-tts-url.sh <baseUrl>" >&2
  exit 1
fi

CONSOLE=$(su - qqagent -c 'cd /opt/qq-agent/app && ./manage.sh token' 2>/dev/null | tail -1)
CONSOLE="${CONSOLE%$'\r'}"
BASE=http://127.0.0.1:3210

echo "▶ 1/3 探测 $URL/audio/speech 的可达性（用宿主那条链路之外的 curl）"
code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' --cacert /opt/qq-agent/tls/ca.crt "$URL/audio/speech" 2>/dev/null || true)
# 没带 body 的 POST/GET 都可能是 400/405，只要不是 000 就说明"连得上"
echo "   http=[${code:-000}]（4xx 也算通，000 才是连不上）"

echo "▶ 2/3 写入 tts.baseUrl"
curl -s -m 20 -X POST -H "x-console-token: $CONSOLE" -H 'Host: 127.0.0.1:3210' \
  -H 'content-type: application/json' -d "{\"tts\":{\"baseUrl\":\"$URL\"}}" \
  "$BASE/api/config" -o /dev/null -w '   http=%{http_code}\n'

echo "▶ 3/3 真链路自检：POST /api/tts/test 输入「唱：雨爱」"
printf '%s' '{"text":"唱：雨爱"}' > /tmp/tts-body.json
curl -s -m 240 -X POST -H "x-console-token: $CONSOLE" -H 'Host: 127.0.0.1:3210' \
  -H 'content-type: application/json' --data-binary @/tmp/tts-body.json \
  "$BASE/api/tts/test" -o /tmp/tts-out.bin \
  -w '   http=%{http_code} type=%{content_type} size=%{size_download} total=%{time_total}s\n'

echo "▶ 回读配置"
curl -s -m 10 -H "x-console-token: $CONSOLE" -H 'Host: 127.0.0.1:3210' "$BASE/api/config" \
  | python3 -c 'import json,sys;t=(json.load(sys.stdin).get("tts") or {});print("   baseUrl =",t.get("baseUrl"),"| enabled =",t.get("enabled"),"| timeout =",t.get("timeoutMs"))'
