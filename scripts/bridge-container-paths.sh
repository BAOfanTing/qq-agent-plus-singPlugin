#!/usr/bin/env bash
# 把 QQ Agent 的 plugin-data 桥接进 OneBot 容器（SnowLuma）。
#
# 现象：群里点歌后插件报
#   OneBot upload_group_file 失败: retcode=100 ENOENT ... realpath
#   '/opt/qq-agent/data/plugin-data/sing/media/sing-xxxx.mp3'
#
# 原因：宿主 cap.send.file 传给 OneBot 的是**宿主绝对路径**，而 SnowLuma 跑在容器里，
# 只挂了 /opt/qq-agent/snowluma/{data,client-config,client-data} → 容器内既没有
# /opt/qq-agent/data，也看不到插件写下的文件，realpath 自然 ENOENT。
#
# 这个脚本做两件事（都幂等）：
#   1) 宿主：把 plugin-data 挪进容器可见的 snowluma/data，原位置留软链；
#   2) 容器：在容器内建 /opt/qq-agent/data -> /app/data，让宿主路径能解析。
#
# 用法（在服务器上以 root 跑）：
#   bash bridge-container-paths.sh
#   bash bridge-container-paths.sh --container 别的容器名 --data-dir /opt/qq-agent/data
#
# ⚠️ 容器**重建**（docker rm / compose up --force-recreate）后第 2 步会丢，重跑本脚本即可。
#    第 1 步是宿主机软链，重启不丢。

set -euo pipefail

CONTAINER="qq-agent-snowluma"
DATA_DIR="/opt/qq-agent/data"
MOUNTED_SUBDIR="data"     # 容器里 /app/data 对应的宿主机子目录名

while [[ $# -gt 0 ]]; do
  case "$1" in
    --container) CONTAINER="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请用 root 运行（需要 docker exec 与改 data 目录）" >&2
  exit 1
fi
command -v docker >/dev/null || { echo "没装 docker" >&2; exit 1; }
docker inspect "$CONTAINER" >/dev/null 2>&1 || { echo "容器不存在：$CONTAINER" >&2; exit 1; }

# 容器内 /app/data 对应的宿主机目录（从挂载里读，读不到就用同级的 snowluma/data）
HOST_DATA="$(docker inspect "$CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Source}}{{end}}{{end}}')"
if [[ -z "$HOST_DATA" ]]; then
  HOST_DATA="$(dirname "$DATA_DIR")/snowluma/$MOUNTED_SUBDIR"
  echo "⚠ 没从挂载里找到 /app/data，按惯例用 $HOST_DATA"
fi

SRC="$DATA_DIR/plugin-data"
DST="$HOST_DATA/plugin-data"

echo "▶ 1/2 宿主：$SRC  ->  $DST"
if [[ -L "$SRC" ]]; then
  echo "  已是软链，跳过"
else
  mkdir -p "$DST"
  if [[ -d "$SRC" ]]; then
    cp -a "$SRC/." "$DST/" 2>/dev/null || true
  fi
  chown -R "$(stat -c '%U:%G' "$DATA_DIR")" "$DST" 2>/dev/null || true
  mv "$SRC" "$SRC.pre-bridge.$(date +%s)"
  ln -s "$DST" "$SRC"
  echo "  完成（旧目录已改名为 *.pre-bridge.*，确认无误后可删）"
fi

echo "▶ 2/2 容器：把 $DATA_DIR 指到 /app/$MOUNTED_SUBDIR"
docker exec -u 0 "$CONTAINER" sh -c "mkdir -p /opt/qq-agent && ln -sfn /app/$MOUNTED_SUBDIR $DATA_DIR"
docker exec -u 0 "$CONTAINER" sh -c "ls -ld $DATA_DIR"

echo "▶ 自检：容器里解析一个插件媒体文件"
docker exec "$CONTAINER" sh -c "ls $DATA_DIR/plugin-data/*/media/* 2>/dev/null | head -n 3 || echo '（还没有媒体文件，发一次就知道了）'"

echo "✅ 桥接完成。现在插件发群文件应该能成功；容器重建后重跑本脚本。"
