#!/usr/bin/env python
"""sing-model/run.py —— 网关调用的换声入口（RVC）。

    python run.py --input in.wav --output out.wav --voice me [--pitch 0] [--no-separate]

流程：
  1) 人声分离（可选，默认开）：把"带伴奏的成品"拆成 人声 / 伴奏 两轨
     —— RVC 只能换人声，整段直接喂会把伴奏一起"换掉"，听起来是糊的
  2) RVC 换声：调用 RVC 自带的 infer/cli.py（官方离线 CLI，参数稳定）
  3) 混回伴奏（有伴奏轨时）：换声后的人声 + 原伴奏
  4) 输出到 --output

任何一步失败都按"没做成"退出（非 0 + 一行原因），不产出半成品。
"""

from __future__ import annotations

import argparse
import glob
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
RVC_DIR = HERE / "rvc"
# 显存上限用的 sitecustomize（见 gpu_cap/sitecustomize.py）
GPU_CAP_DIR = HERE / "gpu_cap"
DEFAULT_GPU_FRACTION = 0.85
ASSETS = RVC_DIR / "assets"
WEIGHTS = ASSETS / "weights"
INDICES = ASSETS / "indices"
PCMSS_WEIGHTS = ASSETS / "pymss_weights"
# 人声/伴奏分离模型（BS-Roformer 368，SDR 12.96）。放在 assets/pymss_weights/ 下，
# 缺失时用：python -m pymss.cli download <名字> --model-dir assets/pymss_weights --source modelscope
SEP_MODEL = "model_bs_roformer_ep_368_sdr_12.9628.ckpt"


def log(msg: str) -> None:
    print(f"[sing-model] {msg}", file=sys.stderr, flush=True)


def fail(msg: str) -> "NoReturn":  # noqa: F821
    print(f"[sing-model] 失败：{msg}", file=sys.stderr, flush=True)
    raise SystemExit(2)


def find_model(voice: str) -> tuple[Path, Path | None]:
    """按音色名找 .pth 与 .index；找不到就把现有文件列出来，省得用户猜。

    支持两种写法：
      --voice hanser            按文件名匹配（任意子目录，递归查找）
      --voice 布洛尼亚/hanser    按相对路径匹配（权重常按角色分子目录放）
    """
    key = str(voice).strip().replace("\\", "/")
    candidates: list[Path] = []

    direct = Path(key)
    if direct.is_absolute() and direct.is_file():
        candidates.append(direct)
    # 递归找：文件名或"子目录/文件名"命中
    for p in WEIGHTS.rglob("*.pth"):
        rel = p.relative_to(WEIGHTS).as_posix()
        stem = p.stem
        if key in {stem, rel, rel[:-4] if rel.endswith(".pth") else rel}:
            candidates.append(p)
    if not candidates:
        # 宽松兜底：包含关系（比如 --voice 周杰伦 命中 zhoujie 不行，但 --voice zhou 可以）
        for p in WEIGHTS.rglob("*.pth"):
            if key and key.lower() in p.stem.lower():
                candidates.append(p)
    if not candidates:
        available = sorted(p.relative_to(WEIGHTS).as_posix() for p in WEIGHTS.rglob("*.pth"))
        fail(
            f"找不到音色「{voice}」的权重。把 .pth 放到 {WEIGHTS}（可以分子目录）"
            + (f"；现有：{', '.join(available)}" if available else "；目录目前是空的")
        )
    pth = sorted(candidates)[0]

    # index 同上：优先同名同目录，其次同名任意目录，再次整棵树下唯一一个 .index
    index: Path | None = None
    same_dir = sorted(pth.parent.glob(f"{pth.stem}*.index"))
    if same_dir:
        index = same_dir[0]
    else:
        named = sorted(p for p in INDICES.rglob(f"{pth.stem}*.index"))
        if not named:
            named = sorted(p for p in pth.parent.glob("*.index"))
        if not named:
            every = sorted(INDICES.rglob("*.index"))
            named = every if len(every) == 1 else []
        index = named[0] if named else None
    return pth, index


def ffmpeg_exe() -> str | None:
    try:
        import imageio_ffmpeg  # noqa: PLC0415

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg")


def ffmpeg_bin_dir() -> str | None:
    """把 ffmpeg 放到一个固定名字（ffmpeg.exe）的目录里，供 RVC 用 PATH 找到。

    RVC 走 ffmpeg-python，它按名字 `ffmpeg` 在 PATH 里找 —— imageio-ffmpeg 给的
    文件名是 ffmpeg-win-x86_64-vX.Y.exe，所以必须改名拷贝一份，否则
    load_audio 会报 WinError 2。
    """
    exe = ffmpeg_exe()
    if not exe:
        return None
    shim = HERE / "bin"
    shim.mkdir(exist_ok=True)
    dst = shim / "ffmpeg.exe"
    try:
        if not dst.exists() or dst.stat().st_size != Path(exe).stat().st_size:
            shutil.copyfile(exe, dst)
    except Exception:
        return str(Path(exe).parent)
    return str(shim)


def run(cmd: list[str], what: str, timeout: int = 1800, gpu_fraction: float | None = None) -> None:
    log(f"{what}：{' '.join(str(c) for c in cmd[:6])} ...")
    env = os.environ.copy()
    # 显存闸：把 gpu_cap 目录塞进 PYTHONPATH，子进程启动时会自动套用上限
    if gpu_fraction is not None and GPU_CAP_DIR.exists():
        env["SING_GPU_MEM_FRACTION"] = str(gpu_fraction)
        env["PYTHONPATH"] = os.pathsep.join([str(GPU_CAP_DIR), env.get("PYTHONPATH", "")]).strip(os.pathsep)
        env.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    extra = [p for p in (ffmpeg_bin_dir(), str(Path(sys.executable).parent / "Scripts")) if p]
    env["PATH"] = os.pathsep.join(extra + [env.get("PATH", "")])
    proc = subprocess.run(cmd, cwd=str(RVC_DIR), timeout=timeout, capture_output=True, text=True, env=env)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-6:]
        fail(f"{what} 失败（退出码 {proc.returncode}）：" + " | ".join(tail))


def separate(src: Path, out_dir: Path, model_name: str | None, gpu_fraction: float | None = None) -> tuple[Path | None, Path | None]:
    """返回 (人声, 伴奏)。分离不可用时抛异常，由调用方决定降级。

    直接调 `python -m pymss.cli infer`（pymss 自己的 CLI），不经过 RVC 的
    tools/pymss_webui 包装：那个包装按 spec 里的 stem 名做校验，实测会和模型实际
    输出的命名（Vocals/Instrumental）对不上，白报"缺少 stem"。
    """
    model = model_name or SEP_MODEL
    sep_dir = out_dir / "sep"
    sep_dir.mkdir(parents=True, exist_ok=True)
    run(
        [sys.executable, "-m", "pymss.cli", "infer", model,
         "--model-dir", str(PCMSS_WEIGHTS),
         "-i", str(src), "-o", str(sep_dir),
         "--device", "auto", "--format", "wav"],
        "人声分离",
        timeout=1800,
        gpu_fraction=gpu_fraction,
    )
    picks: dict[str, Path] = {}
    for path in sep_dir.glob("*.wav"):
        low = path.stem.lower()
        if "vocal" in low:
            picks["vocal"] = path
        elif "instrumental" in low or "inst" in low:
            picks["inst"] = path
    if "vocal" not in picks:
        raise RuntimeError(f"分离没产出人声轨（{sep_dir} 里没有 *Vocals*.wav）")
    return picks["vocal"], picks.get("inst")


def trim(src: Path, seconds: int, out_dir: Path) -> Path:
    """把音源裁到前 N 秒。RVC 换声是按整段算的：4 分钟的歌会跑 4 分钟，
    而群里点歌只要几十秒，所以在换声之前就裁，省下大量 GPU 时间。"""
    if seconds <= 0:
        return src
    exe = ffmpeg_exe()
    if not exe:
        return src
    dst = out_dir / f"trim-{src.stem}.wav"
    run([exe, "-y", "-i", str(src), "-t", str(seconds), "-ac", "1", "-ar", "44100", str(dst)], "截取前 N 秒", timeout=600)
    return dst

def mix(vocal: Path, inst: Path | None, out: Path) -> None:
    exe = ffmpeg_exe()
    if inst is None or exe is None:
        shutil.copyfile(vocal, out)
        if inst is not None and exe is None:
            log("没有 ffmpeg，跳过混伴奏（只输出人声）")
        return
    run(
        [exe, "-y", "-i", str(vocal), "-i", str(inst),
         "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=longest:normalize=0[a]",
         "-map", "[a]", "-ac", "1", "-ar", "40000", str(out)],
        "混伴奏",
        timeout=600,
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="RVC 换声：输入音频 -> 目标音色")
    ap.add_argument("--input", required=True, help="输入音频（wav/m4a/mp3 都行）")
    ap.add_argument("--output", required=True, help="输出音频路径")
    ap.add_argument("--voice", default="me", help="音色名（对应 assets/weights/<名字>.pth）")
    ap.add_argument("--pitch", type=int, default=0, help="变调半音（男→女常 +12，女→男 -12）")
    ap.add_argument("--index-rate", type=float, default=0.75, help="index 相似度混合比例")
    ap.add_argument("--max-seconds", type=int, default=0, help="只唱前 N 秒（0=整段）")
    ap.add_argument("--gpu-fraction", type=float, default=DEFAULT_GPU_FRACTION,
                    help="显存上限占整卡的比例（默认 0.85，也就是最多用 85%%）；设 1 表示不限制")
    ap.add_argument("--no-separate", action="store_true", help="不做人声分离（输入已是干净人声时用）")
    ap.add_argument("--sep-model", default=None, help="指定分离模型标签，默认用 RVC 的第一个")
    ap.add_argument("--keep-instrumental", dest="keep_inst", action="store_true", default=True,
                    help="混回原伴奏（默认开）")
    ap.add_argument("--no-instrumental", dest="keep_inst", action="store_false",
                    help="只要清唱（不混伴奏）")
    args = ap.parse_args()

    src = Path(args.input).resolve()
    if not src.exists():
        fail(f"输入文件不存在：{src}")
    out = Path(args.output).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    pth, index = find_model(args.voice)
    log(f"模型：{pth.name}" + (f" + {index.name}" if index else "（没有 .index，相似度会低一些）"))
    if not (ASSETS / "hubert_base" / "pytorch_model.bin").exists():
        fail(f"缺 hubert 权重：{ASSETS / 'hubert_base'}")
    if not (ASSETS / "rmvpe" / "rmvpe.pt").exists():
        log("没找到 rmvpe.pt，回退到 pm 音高提取（质量略差）")
        f0_method = "pm"
    else:
        f0_method = "rmvpe"

    with tempfile.TemporaryDirectory(prefix="sing-") as tmp:
        tmp_dir = Path(tmp)
        # 先裁再分离：分离也吃 GPU/CPU 时间，4 分钟的歌整段分离纯属浪费
        src_maybe_trimmed = trim(src, args.max_seconds, tmp_dir) if args.max_seconds > 0 else src
        vocal_src = src_maybe_trimmed
        inst_path: Path | None = None

        if not args.no_separate:
            try:
                vocal_src, inst_path = separate(src_maybe_trimmed, tmp_dir, args.sep_model, args.gpu_fraction)
                log(f"分离完成：人声 {vocal_src.name}，伴奏 {'有' if inst_path else '无'}")
            except Exception as exc:  # 分离失败不该让整件事失败
                log(f"分离没成功（{exc}），直接对原音频换声")
                vocal_src, inst_path = src_maybe_trimmed, None

        if args.max_seconds > 0:
            vocal_src = trim(vocal_src, args.max_seconds, tmp_dir)
            if inst_path is not None:
                inst_path = trim(inst_path, args.max_seconds, tmp_dir)

        converted = tmp_dir / "converted.wav"
        # RVC 的 CLI 是包内模块（infer/cli.py 里 import infer.*），必须 `-m infer.cli`
        # 并在 RVC 根目录下运行；直接 `python infer/cli.py` 会报 No module named 'infer'
        cmd = [sys.executable, "-m", "infer.cli",
               "--model", str(pth),
               "--input", str(vocal_src),
               "--output", str(converted),
               "--pitch", str(args.pitch),
               "--f0-method", f0_method,
               "--index-rate", str(args.index_rate),
               "--format", "wav",
               "--overwrite"]
        if index is not None:
            cmd += ["--index", str(index)]
        run(cmd, "RVC 换声", gpu_fraction=args.gpu_fraction)
        if not converted.exists() or converted.stat().st_size == 0:
            fail("RVC 没有产出音频")

        mix(converted, inst_path if args.keep_inst else None, out)

    if not out.exists() or out.stat().st_size == 0:
        fail("最终输出为空")
    log(f"完成：{out}（{out.stat().st_size / 1024:.0f} KB）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
