#!/usr/bin/env python
"""打印音频的中位基频（Hz），给网关做"音高归一"用。

用法：
    python f0.py <音频文件>

输出一行纯数字（例如 `354.2`）；测不出来时输出 `0`。
用 librosa 的 pyin（对语音比较稳），只看浊音帧。
"""
from __future__ import annotations

import sys

try:
    import librosa
    import numpy as np
except Exception:  # noqa: BLE001
    print(0)
    raise SystemExit(0)


def main() -> int:
    if len(sys.argv) < 2:
        print(0)
        return 0
    try:
        y, sr = librosa.load(sys.argv[1], sr=16000, mono=True)
        if y.size == 0:
            print(0)
            return 0
        f0, _, _ = librosa.pyin(y, fmin=70, fmax=700, sr=sr, frame_length=1024)
        voiced = f0[~np.isnan(f0)]
        if voiced.size == 0:
            print(0)
            return 0
        print(f"{float(np.median(voiced)):.1f}")
    except Exception:  # noqa: BLE001
        print(0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
