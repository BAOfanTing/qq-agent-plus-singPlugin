#!/bin/bash
# 自检两条通道 + 跑一次真链路（宿主 /api/tts/test）。
#   bash check-lines.sh [网关令牌]
# 会依次检查：本机隧道口(127.0.0.1:8899) → nginx TLS(8898) → 宿主 TTS 真链路。
set -uo pipefail

GW_TOKEN="${1:-}"
CA=/opt/qq-agent/tls/ca.crt
BASE=http://127.0.0.1:3210

echo "▶ 1) ssh 反向隧道（127.0.0.1:8899）"
curl -s -m 10 -o /dev/null -w '   http=%{http_code}\n' http://127.0.0.1:8899/health 2>/dev/null || echo "   连不上（本机隧道没起？）"

echo "▶ 2) nginx TLS（8898）"
curl -s -m 15 --cacert "$CA" -o /dev/null -w '   127.0.0.1:8898 http=%{http_code}\n' https://127.0.0.1:8898/health 2>/dev/null || echo "   连不上"

echo "▶ 3) 当前宿主 TTS 指向"
CONSOLE=$(su - qqagent -c 'cd /opt/qq-agent/app && ./manage.sh token' 2>/dev/null | tail -1)
CONSOLE="${CONSOLE%$'\r'}"
curl -s -m 10 -H "x-console-token: $CONSOLE" -H 'Host: 127.0.0.1:3210' "$BASE/api/config" \
  | python3 -c 'import json,sys;t=(json.load(sys.stdin).get("tts") or {});print("   baseUrl =",t.get("baseUrl"),"| enabled =",t.get("enabled"),"| timeout =",t.get("timeoutMs"))'

echo "▶ 4) 真链路：/api/tts/test「唱：夜曲」"
printf '%s' '{"text":"唱：夜曲"}' > /tmp/tts-body.json
curl -s -m 260 -X POST -H "x-console-token: $CONSOLE" -H 'Host: 127.0.0.1:3210' \
  -H 'content-type: application/json' --data-binary @/tmp/tts-body.json \
  "$BASE/api/tts/test" -o /tmp/tts-out.bin \
  -w '   http=%{http_code} size=%{size_download} total=%{time_total}s\n'

if [[ -s /tmp/tts-out.bin ]]; then
  head -c 120 /tmp/tts-out.bin | grep -q '^{' && echo "   （返回的是错误 JSON，见下）" && head -c 200 /tmp/tts-out.bin && echo
fi
