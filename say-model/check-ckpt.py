#!/usr/bin/env python
"""检查 Breeze TTS 2 权重是否完整（本地部署前的体检）。

用法：
    E:\\APP\\Anaconda\\envs\\sing\\python.exe say-model\\check-ckpt.py [权重目录]

默认检查 say-model\\weights\\breeze-tts-2。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

# Windows 控制台默认是 GBK，直接 print("✓") 会 UnicodeEncodeError
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
_ASCII = (getattr(sys.stdout, "encoding", "") or "").lower() not in ("utf-8", "utf8")
OK = "[OK]" if _ASCII else "✓"
BAD = "[X]" if _ASCII else "✗"

ROOT = Path(__file__).resolve().parent
DEFAULT_CKPT = ROOT / "weights" / "breeze-tts-2"

# 必需文件（相对权重目录）；值是最小合理字节数（防止拿到半截文件）
REQUIRED = {
    "config.json": 1_000,
    "generation_config.json": 100,
    "model.safetensors.index.json": 10_000,
    "tokenizer.json": 1_000_000,
    "tokenizer_config.json": 10_000,
    "special_tokens_map.json": 100,
}
# 主模型分片：合计应 > 6 GB
SHARDS = ["model-00001-of-00002.safetensors", "model-00002-of-00002.safetensors"]
AUDIO_DIR = "audio_tokenizer"


def human(n: float) -> str:
    return f"{n / 1024 ** 3:.2f} GB" if n > 1024 ** 2 else f"{n / 1024 ** 2:.1f} MB"


def main() -> int:
    ckpt = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_CKPT
    print(f"权重目录：{ckpt}")
    if not ckpt.is_dir():
        print(BAD + " 目录不存在")
        return 1

    problems: list[str] = []
    total = 0

    for name, min_size in REQUIRED.items():
        p = ckpt / name
        if not p.is_file():
            problems.append(f"缺文件 {name}")
            continue
        size = p.stat().st_size
        total += size
        if size < min_size:
            problems.append(f"{name} 太小（{human(size)}，应至少 {human(min_size)}）")
        else:
            print(f"  {OK} {name:<34} {human(size)}")

    shard_total = 0
    for name in SHARDS:
        p = ckpt / name
        if not p.is_file():
            problems.append(f"缺分片 {name}")
            continue
        size = p.stat().st_size
        shard_total += size
        total += size
        print(f"  {OK} {name:<34} {human(size)}")
    if shard_total and shard_total < 5 * 1024 ** 3:
        problems.append(f"主模型分片合计只有 {human(shard_total)}，应在 6 GB 以上（没下完？）")

    audio_dir = ckpt / AUDIO_DIR
    if not audio_dir.is_dir():
        problems.append(f"缺目录 {AUDIO_DIR}/（代码里 load_runtime 明确要求）")
    else:
        audio_total = 0
        for p in sorted(audio_dir.rglob("*")):
            if p.is_file():
                rel = p.relative_to(ckpt)
                audio_total += p.stat().st_size
                if p.name.endswith(".crdownload"):
                    problems.append(f"还在下载：{rel}（{human(p.stat().st_size)}）")
                else:
                    print(f"  {OK} {str(rel):<34} {human(p.stat().st_size)}")
        total += audio_total
        if "model.safetensors" not in {p.name for p in audio_dir.rglob("*") if p.is_file()}:
            problems.append("audio_tokenizer/ 里没有 model.safetensors")
        print(f"  · audio_tokenizer 合计 {human(audio_total)}")

    # index.json 里列的分片都要在
    try:
        index = json.loads((ckpt / "model.safetensors.index.json").read_text(encoding="utf-8"))
        declared = sorted({v for v in (index.get("weight_map") or {}).values()})
        missing = [d for d in declared if not (ckpt / d).is_file()]
        if missing:
            problems.append(f"索引里声明但缺失的分片：{', '.join(missing)}")
        else:
            print(f"  ✓ 索引声明的 {len(declared)} 个分片都在")
    except FileNotFoundError:
        pass
    except Exception as error:  # noqa: BLE001
        problems.append(f"索引读不了：{error}")

    print(f"\n合计 {human(total)}")
    if problems:
        print("\n✗ 还不完整：")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print("\n" + OK + " 权重完整，可以启动本地 Breeze")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
