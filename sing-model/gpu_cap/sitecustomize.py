"""给换声子进程加一道显存闸。

Python 启动时会自动 import 本模块（只要它在 PYTHONPATH 上）—— 于是我们在 torch/CUDA
真正分配之前就能设好上限，不需要改 RVC 的任何代码。

SING_GPU_MEM_FRACTION 未设或非法时什么也不做（保持原来的行为）。
"""
import os

try:
    _fraction = float(os.environ.get("SING_GPU_MEM_FRACTION", "") or 0)
except ValueError:
    _fraction = 0.0

if 0.05 <= _fraction < 1.0:
    try:
        import torch  # noqa: PLC0415

        if torch.cuda.is_available():
            torch.cuda.set_per_process_memory_fraction(_fraction, 0)
            torch.cuda.empty_cache()
            print(f"[gpu-cap] 显存上限设为 {_fraction:.0%}", flush=True)
    except Exception as _error:  # 上限设不上就照常跑，别把任务搞死
        print(f"[gpu-cap] 设置失败（忽略）：{_error}", flush=True)
