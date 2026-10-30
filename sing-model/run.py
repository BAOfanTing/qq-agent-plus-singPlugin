#!/usr/bin/env python
"""sing-model/run.py —— 网关调用的换声入口（RVC）。

    python run.py --input in.wav --output out.wav --voice me [--pitch 0] [--no-separate]

流程：
  1) 人声分离（可选，默认开）：把"带伴奏的成品"拆成 人声 / 伴奏 两轨
     —— RVC 只能换人声，整段直接喂会把伴奏一起"换掉"，听起来是糊的
  2) RVC 换声：调用 RVC 自带的 infer/cli.py（官方离线 CLI，参数稳定）
  3) 混回伴奏（有伴奏轨时）：换声后的人声 + 原伴奏
  4) 输出到 --output

长音频（整首 / 超过"一段 + 20 秒"）会自动切成 --segment-seconds 长的段，
逐段换声再拼回去：每段都在显存安全区，片段独立超时、失败只重跑那一段。

任何一步失败都按"没做成"退出（非 0 + 一行原因），不产出半成品。
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
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



def _kill_tree(pid: int) -> None:
    """把某个进程连同它的子进程一起杀掉。

    ⚠️ Windows 上 child.kill() 只杀父进程：run.py 被杀掉后，
    它派生的 `python -m infer.cli` 会变成孤儿继续霸占 GPU
    （2026-10-29 实测：一个 200 秒任务在后台空转 9 个多小时、显存 9.8G 100%）。
    """
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)],
                           capture_output=True, timeout=30)
        else:
            os.killpg(os.getpgid(pid), signal.SIGKILL)
    except Exception:
        pass


def run(cmd: list[str], what: str, timeout: int = 1800, gpu_fraction: float | None = None,
        soft: bool = False, on_line=None) -> None:
    """跑一条子命令。

    soft=True 时失败抛 RuntimeError（分段重试要用），否则直接退出。
    on_line 给定时逐行回调（用来把 infer.cli 的每段完成信息转成进度）。
    """
    log(f"{what}：{' '.join(str(c) for c in cmd[:6])} ...")
    env = os.environ.copy()
    # 显存闸：把 gpu_cap 目录塞进 PYTHONPATH，子进程启动时会自动套用上限
    if gpu_fraction is not None and GPU_CAP_DIR.exists():
        env["SING_GPU_MEM_FRACTION"] = str(gpu_fraction)
        env["PYTHONPATH"] = os.pathsep.join([str(GPU_CAP_DIR), env.get("PYTHONPATH", "")]).strip(os.pathsep)
        env.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

    # cwd 必须留在 RVC 目录：`-m infer.cli` 要靠它找到 infer 包
    # （重写 run() 时漏了这条，RVC 秒退，2026-10-30 实测）
    kwargs = {"stdout": subprocess.PIPE, "stderr": subprocess.STDOUT, "env": env, "text": True,
              "encoding": "utf-8", "errors": "replace", "cwd": str(RVC_DIR)}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True

    child = subprocess.Popen(cmd, **kwargs)

    def _explode(message: str) -> None:
        if soft:
            raise RuntimeError(message)
        fail(message)

    try:
        if on_line is None:
            out, _ = child.communicate(timeout=timeout)
        else:
            deadline = time.monotonic() + timeout
            chunks: list[str] = []
            assert child.stdout is not None
            while True:
                line = child.stdout.readline()
                if not line:
                    break
                chunks.append(line)
                try:
                    on_line(line.rstrip("\r\n"))
                except Exception:      # 回调出错不能影响子进程
                    pass
                if time.monotonic() > deadline:
                    raise subprocess.TimeoutExpired(cmd, timeout)
            child.wait(timeout=max(1.0, deadline - time.monotonic()))
            out = "".join(chunks)
    except subprocess.TimeoutExpired:
        _kill_tree(child.pid)          # 连孙进程一起收掉，别留孤儿霸占显卡
        child.kill()
        child.communicate()
        _explode(f"{what}超时（{timeout // 60} 分钟），已终止（含子进程）")
    else:
        if child.returncode != 0:
            tail = " ".join((out or "").strip().splitlines()[-3:])
            _explode(f"{what}失败（退出码 {child.returncode}）：{tail[:400]}")
    log(f"{what}完成")

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


def duration_seconds(path: Path) -> float:
    """用 ffmpeg -i 输出里的 Duration 行取时长；拿不到就返回 0（调用方按"不知道"处理）。"""
    exe = ffmpeg_exe()
    if not exe:
        return 0.0
    try:
        proc = subprocess.run([exe, "-hide_banner", "-i", str(path)],
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=120)
    except Exception:
        return 0.0
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", (proc.stderr or "") + (proc.stdout or ""))
    if not match:
        return 0.0
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def slice_audio(src: Path, out_dir: Path, segment_seconds: int) -> list[Path]:
    """按固定长度切片。

    用 ffmpeg 的 segment muxer 一次切完（不是逐段 -ss，那样要解码 N 遍且边界不准）。
    reset_timestamps 让每段都从 0 开始，RVC 对每段的处理才能等价。
    """
    exe = ffmpeg_exe()
    if not exe:
        raise RuntimeError("没有 ffmpeg，无法切片")
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("seg-*.wav"):
        old.unlink(missing_ok=True)
    run([exe, "-y", "-i", str(src),
         "-f", "segment", "-segment_time", str(int(segment_seconds)),
         "-reset_timestamps", "1", "-ac", "1", "-ar", "44100",
         str(out_dir / "seg-%03d.wav")],
        "切分人声", timeout=900)
    files = sorted(out_dir.glob("seg-*.wav"))
    if not files:
        raise RuntimeError("切片没有产出任何文件")
    return files


def concat_audio(parts: list[Path], out: Path, sample_rate: int = 40000) -> None:
    """把换声后的分段拼回一整条。

    用 filter 重编码而不是 concat 拷贝：每段都来自独立的 infer.cli 进程，
    参数虽然一致，但拷贝模式对个别容器差异很敏感，重编码一次最稳。
    """
    if not parts:
        raise RuntimeError("没有可拼接的分段")
    if len(parts) == 1:
        shutil.copyfile(parts[0], out)
        return
    exe = ffmpeg_exe()
    if not exe:
        raise RuntimeError("没有 ffmpeg，无法拼接")
    cmd = [exe, "-y"]
    for part in parts:
        cmd += ["-i", str(part)]
    graph = "".join(f"[{i}:a]" for i in range(len(parts))) + f"concat=n={len(parts)}:v=0:a=1[a]"
    cmd += ["-filter_complex", graph, "-map", "[a]", "-ac", "1", "-ar", str(sample_rate), str(out)]
    run(cmd, f"拼接 {len(parts)} 段", timeout=1800)


def convert_vocal(vocal: Path, out: Path, *, pth: Path, index: Path | None, pitch: int,
                  f0_method: str, index_rate: float, gpu_fraction: float | None,
                  what: str = "RVC 换声", soft: bool = False) -> None:
    """对一条人声做换声。

    RVC 的 CLI 是包内模块（infer/cli.py 里 import infer.*），必须 `-m infer.cli`
    且在 RVC 根目录下运行（cwd 由 run() 负责）。
    soft=True 时失败抛 RuntimeError，方便分段逐段重试。
    """
    cmd = [sys.executable, "-m", "infer.cli",
           "--model", str(pth),
           "--input", str(vocal),
           "--output", str(out),
           "--pitch", str(pitch),
           "--f0-method", f0_method,
           "--index-rate", str(index_rate),
           "--format", "wav",
           "--overwrite"]
    if index is not None:
        cmd += ["--index", str(index)]
    run(cmd, what, gpu_fraction=gpu_fraction, soft=soft)
    if not out.exists() or out.stat().st_size == 0:
        message = f"{what}没有产出音频"
        if soft:
            raise RuntimeError(message)
        fail(message)


def convert_segments_batch(segments: list[Path], work_dir: Path, *, total: int, retries: int,
                          on_progress=None, **common) -> list[Path]:
    """一次加载模型、逐段换声。

    关键点：`infer.cli` 支持 **目录批处理**（collect_jobs），它内部只 get_vc() 一次，
    然后在同一个进程里循环处理每个文件。之前我们每段起一个进程，等于每段重付一次
    模型加载（约 8 秒）—— 段越小越亏，20 秒一段比 75 秒一段慢一倍多。
    批处理整体失败时退回逐段调用，并且只补跑缺产物的那几段。
    """
    conv_dir = work_dir / "conv"
    conv_dir.mkdir(parents=True, exist_ok=True)

    cmd = [sys.executable, "-m", "infer.cli",
           "--model", str(common["pth"]),
           "--input", str(segments[0].parent),
           "--output", str(conv_dir),
           "--pitch", str(common["pitch"]),
           "--f0-method", common["f0_method"],
           "--index-rate", str(common["index_rate"]),
           "--format", "wav",
           "--overwrite"]
    if common["index"] is not None:
        cmd += ["--index", str(common["index"])]

    seen = 0

    def _on_line(line: str) -> None:
        nonlocal seen
        # infer.cli 每处理完一个文件会 print 输出路径；数到 .wav 就算一段完成
        if line.strip().lower().endswith(".wav"):
            seen = min(seen + 1, total)
            log(f"[seg] {seen}/{total} 完成")
            if on_progress is not None:
                try:
                    on_progress(seen)
                except Exception:
                    pass

    try:
        run(cmd, f"换声 {total} 段（模型只加载一次）",
            gpu_fraction=common["gpu_fraction"], soft=True, on_line=_on_line)
    except Exception as exc:
        log(f"批量换声没成（{str(exc)[:140]}），改回逐段处理")

    produced = {path.stem: path for path in conv_dir.glob("*.wav")}
    parts: list[Path] = []
    for i, seg in enumerate(segments, 1):
        if seg.stem in produced:
            parts.append(produced[seg.stem])
            continue
        log(f"[seg] {i}/{total} 没有产物，单独补跑")
        done = False
        for attempt in range(retries + 1):
            try:
                single = conv_dir / seg.name
                convert_vocal(seg, single, what=f"换声 {i}/{total}", soft=True, **common)
                parts.append(single)
                done = True
                break
            except Exception as exc:
                if attempt < retries:
                    log(f"[seg] {i}/{total} 失败（{str(exc)[:120]}），重试一次")
                else:
                    log(f"[seg] {i}/{total} 重试后仍失败：{str(exc)[:160]}")
        if not done:
            fail(f"第 {i}/{total} 段换声失败：整单放弃（不产出半成品）")
    return parts


# ── 常驻模式 ──────────────────────────────────────────────────────
# 网关用 `run.py --serve` 起一个长驻进程，通过 stdin/stdout 的 NDJSON 通信：
#   请求  {"id":1,"input":"..","output":"..","voice":"hanser","pitch":0,
#          "maxSeconds":0,"segmentSeconds":30,"indexRate":0.75,"noSeparate":false}
#   进度  {"id":1,"event":"seg","done":2,"total":8}
#   结果  {"id":1,"ok":true,"seconds":12.3,"bytes":123456} / {"id":1,"ok":false,"error":".."}
#
# 为什么值得：模型加载一次要 8-12 秒。每次请求都重启进程的话，
# 说一句话 14 秒里有 12 秒是在重复加载 —— 常驻后每句只花 2-3 秒。
# 同一份 VC 实例按音色缓存，切音色才重新 get_vc()。

_RVC_CTX = {"vc": None, "voice": None, "config": None}


def _rvc_call(req: dict, seg_files: list[Path], out_dir: Path, emit) -> list[Path]:
    """用进程内 VC 逐段换声，返回产物列表（顺序与 seg_files 一致）。"""
    sys.path.insert(0, str(RVC_DIR))
    os.chdir(RVC_DIR)                      # RVC 内部有相对路径依赖
    os.environ.setdefault("rmvpe_root", str(ASSETS / "rmvpe"))
    import soundfile as sf
    import torch

    pth, index = find_model(req.get("voice") or "me")
    voice_key = str(pth)
    gpu_fraction = req.get("gpuFraction")
    if gpu_fraction and 0 < float(gpu_fraction) < 1 and _RVC_CTX["vc"] is None:
        torch.cuda.set_per_process_memory_fraction(float(gpu_fraction), 0)

    if _RVC_CTX["vc"] is None or _RVC_CTX["voice"] != voice_key:
        from configs.config import Config
        from infer.vc.modules import VC

        original_argv = sys.argv[:]
        sys.argv = [sys.argv[0]]
        try:
            config = Config()
        finally:
            sys.argv = original_argv
        vc = VC(config)
        # get_vc 只认「相对 weight_root 的文件名」：cli.py 也是先设这个环境变量再传裸文件名
        os.environ["weight_root"] = str(pth.parent)
        vc.get_vc(pth.name)
        _RVC_CTX.update({"vc": vc, "voice": voice_key, "config": config})
        log(f"[serve] 模型已加载：{pth.name}" + (f" + {index.name}" if index else ""))

    vc = _RVC_CTX["vc"]
    index_path = str(index) if index is not None else ""
    index_rate = float(req.get("indexRate") or 0.75)
    f0_method = "rmvpe" if (ASSETS / "rmvpe" / "rmvpe.pt").exists() else "pm"
    speaker_id = 0

    produced: list[Path] = []
    total = len(seg_files)
    for i, seg in enumerate(seg_files, 1):
        status, result = vc.vc_single(
            speaker_id, str(seg), int(req.get("pitch") or 0), f0_method,
            index_path, index_rate, 0, 1.0, 0.33)
        if not result or result[0] is None or result[1] is None:
            raise RuntimeError(f"第 {i}/{total} 段换声没有产出：{status}")
        target = out_dir / f"conv-{i:03d}.wav"
        sf.write(str(target), result[1], result[0])
        produced.append(target)
        if emit:
            emit({"event": "seg", "done": i, "total": total})
        log(f"[seg] {i}/{total} 完成（常驻）")
    return produced


def handle_request(req: dict, emit) -> dict:
    """跑一条完整的换声请求（供 --serve 用）。失败抛异常，由调用方回 ok:false。"""
    src = Path(req["input"]).resolve()
    out = Path(req["output"]).resolve()
    if not src.exists():
        raise RuntimeError(f"输入文件不存在：{src}")
    out.parent.mkdir(parents=True, exist_ok=True)

    max_seconds = int(req.get("maxSeconds") or 0)
    segment_seconds = int(req.get("segmentSeconds") or 0)

    with tempfile.TemporaryDirectory(prefix="sing-serve-") as tmp:
        tmp_dir = Path(tmp)
        src_use = trim(src, max_seconds, tmp_dir) if max_seconds > 0 else src
        vocal_src = src_use
        inst_path: Path | None = None

        if not req.get("noSeparate"):
            try:
                vocal_src, inst_path = separate(src_use, tmp_dir, req.get("sepModel"),
                                                req.get("gpuFraction"))
                log(f"分离完成：人声 {vocal_src.name}，伴奏 {'有' if inst_path else '无'}")
            except Exception as exc:
                log(f"分离没成功（{exc}），直接对原音频换声")
                vocal_src, inst_path = src_use, None

        if max_seconds > 0:
            vocal_src = trim(vocal_src, max_seconds, tmp_dir)
            if inst_path is not None:
                inst_path = trim(inst_path, max_seconds, tmp_dir)

        vocal_len = duration_seconds(vocal_src)
        threshold = segment_seconds + 5
        need_segments = segment_seconds > 0 and (
            max_seconds == 0 or vocal_len <= 0 or vocal_len > threshold)

        if need_segments:
            segs = slice_audio(vocal_src, tmp_dir / "seg", segment_seconds)
            log(f"[seg] 人声 {vocal_len:.0f} 秒 → {len(segs)} 段（常驻进程，模型不重载）")
        else:
            segs = [vocal_src]

        conv_dir = tmp_dir / "conv"
        conv_dir.mkdir(parents=True, exist_ok=True)
        parts = _rvc_call(req, segs, conv_dir, emit)
        converted = tmp_dir / "converted.wav"
        concat_audio(parts, converted)
        mix(converted, inst_path if req.get("keepInst", True) else None, out)

    if not out.exists() or out.stat().st_size == 0:
        raise RuntimeError("最终输出为空")
    return {"seconds": round(duration_seconds(out) or 0, 2), "bytes": out.stat().st_size}


def serve() -> int:
    """常驻模式主循环：读 stdin 的 NDJSON，结果写 stdout。"""
    log("[serve] 常驻换声进程已启动（模型按音色缓存，空闲由网关关掉）")

    def emit(payload: dict) -> None:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as exc:
            emit({"id": None, "ok": False, "error": f"请求不是合法 JSON：{exc}"})
            continue
        if req.get("cmd") == "ping":
            emit({"id": req.get("id"), "ok": True, "pong": True})
            continue
        if req.get("cmd") == "shutdown":
            emit({"id": req.get("id"), "ok": True})
            return 0
        rid = req.get("id")
        try:
            result = handle_request(req, lambda payload: emit({"id": rid, **payload}))
            emit({"id": rid, "ok": True, **result})
        except Exception as exc:
            log(f"[serve] 请求失败：{exc}")
            emit({"id": rid, "ok": False, "error": str(exc)[:400]})
        finally:
            # 每个请求结束后把显存还回去：分离模型是另一个进程，
            # 它的显存会释放，但常驻进程的 torch 缓存不会自动还（实测空转后仍占 9G）。
            try:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="RVC 换声：输入音频 -> 目标音色")
    ap.add_argument("--input", help="输入音频（wav/m4a/mp3 都行）")
    ap.add_argument("--output", help="输出音频路径")
    ap.add_argument("--voice", default="me", help="音色名（对应 assets/weights/<名字>.pth）")
    ap.add_argument("--pitch", type=int, default=0, help="变调半音（男→女常 +12，女→男 -12）")
    ap.add_argument("--index-rate", type=float, default=0.75, help="index 相似度混合比例")
    ap.add_argument("--max-seconds", type=int, default=0, help="只唱前 N 秒（0=整段）")
    ap.add_argument("--serve", action="store_true",
                    help="常驻模式：从 stdin 读 NDJSON 请求，模型只加载一次")
    ap.add_argument("--segment-seconds", type=int, default=75,
                    help="长音频按这个长度切段分别换声（默认 75 秒；0=不分段）")
    ap.add_argument("--segment-retries", type=int, default=1,
                    help="单段换声失败后的重试次数（默认 1）")
    ap.add_argument("--gpu-fraction", type=float, default=DEFAULT_GPU_FRACTION,
                    help="显存上限占整卡的比例（默认 0.85，也就是最多用 85%%）；设 1 表示不限制")
    ap.add_argument("--no-separate", action="store_true", help="不做人声分离（输入已是干净人声时用）")
    ap.add_argument("--sep-model", default=None, help="指定分离模型标签，默认用 RVC 的第一个")
    ap.add_argument("--keep-instrumental", dest="keep_inst", action="store_true", default=True,
                    help="混回原伴奏（默认开）")
    ap.add_argument("--no-instrumental", dest="keep_inst", action="store_false",
                    help="只要清唱（不混伴奏）")
    args = ap.parse_args()

    if args.serve:
        return serve()

    if not args.input or not args.output:
        fail("普通模式要 --input 与 --output；常驻模式请加 --serve")

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
        # 10G 卡上的硬约束：90 秒成品峰值约 8.5G（受闸）；再长就要 9.4G 以上，
        # 0.9 的闸会让 RVC 直接 OOM（conv_forward 报错，2026-10-30 实测 120 秒必现）。
        # 所以：超过 95 秒（或整首）自动放开闸，并在日志里说清楚。
        gpu_fraction = args.gpu_fraction
        segmenting = args.segment_seconds > 0
        # 分段时每段只有几十秒，显存峰值回到安全区 → 闸可以照常开着（既快又不占满显卡）。
        # 只有"不分段 + 长音频"才必须放开，否则 RVC 会 OOM。
        # 只有"关掉分段 + 长音频"才需要放开闸；默认分段下永远走 else 分支。
        long_audio = (args.max_seconds == 0 or args.max_seconds > 95) and not segmenting
        if gpu_fraction is not None and gpu_fraction < 1.0 and long_audio:
            label = "整首" if args.max_seconds == 0 else f"{args.max_seconds} 秒"
            log(f"长音频且已关掉分段（{label}）：自动放开显存上限（{gpu_fraction:.2f} → 不限制），否则会 OOM")
            gpu_fraction = None

        src_maybe_trimmed = trim(src, args.max_seconds, tmp_dir) if args.max_seconds > 0 else src
        vocal_src = src_maybe_trimmed
        inst_path: Path | None = None

        if not args.no_separate:
            try:
                vocal_src, inst_path = separate(src_maybe_trimmed, tmp_dir, args.sep_model, gpu_fraction)
                log(f"分离完成：人声 {vocal_src.name}，伴奏 {'有' if inst_path else '无'}")
            except Exception as exc:  # 分离失败不该让整件事失败
                log(f"分离没成功（{exc}），直接对原音频换声")
                vocal_src, inst_path = src_maybe_trimmed, None

        if args.max_seconds > 0:
            vocal_src = trim(vocal_src, args.max_seconds, tmp_dir)
            if inst_path is not None:
                inst_path = trim(inst_path, args.max_seconds, tmp_dir)

        converted = tmp_dir / "converted.wav"
        common = dict(pth=pth, index=index, pitch=args.pitch, f0_method=f0_method,
                      index_rate=args.index_rate, gpu_fraction=gpu_fraction)

        vocal_len = duration_seconds(vocal_src)
        # 分段规则：显式整首、量不出时长、或比"一段 + 5 秒"还长 → 切。
        # 因为模型只加载一次（见 convert_segments_batch），切段的固定开销已经很小；
        # 但段太碎会让拼接点变多，留 5 秒余量避免最后切出个几秒的尾巴。
        threshold = args.segment_seconds + 5
        need_segments = args.segment_seconds > 0 and (
            args.max_seconds == 0 or vocal_len <= 0 or vocal_len > threshold)

        if need_segments:
            segments = slice_audio(vocal_src, tmp_dir / "seg", args.segment_seconds)
            total = len(segments)
            log(f"[seg] 人声 {vocal_len:.0f} 秒 → {total} 段（每段约 {args.segment_seconds} 秒），模型只加载一次")
            parts = convert_segments_batch(segments, tmp_dir, total=total,
                                           retries=args.segment_retries, **common)
            concat_audio(parts, converted)
            log(f"[seg] {total} 段拼接完成")
        else:
            convert_vocal(vocal_src, converted, **common)

        mix(converted, inst_path if args.keep_inst else None, out)

    if not out.exists() or out.stat().st_size == 0:
        fail("最终输出为空")
    log(f"完成：{out}（{out.stat().st_size / 1024:.0f} KB）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
