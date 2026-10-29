"""生成 README 顶部的图标（话筒 + 音符），输出 assets/icon.png（256×256）。\n\n用法：python scripts/make-icon.py\n"""
import os
from PIL import Image, ImageDraw

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out_dir = os.path.join(root, 'assets')
os.makedirs(out_dir, exist_ok=True)

S = 256
SS = 4                      # 超采样，最后缩回来抗锯齿
W = S * SS

img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# ── 圆角矩形底：从紫到青的斜向渐变 ─────────────────────────────
grad = Image.new('RGBA', (W, W))
gd = ImageDraw.Draw(grad)
c1, c2 = (124, 92, 255), (34, 184, 255)
for i in range(W * 2):
    t = i / (W * 2 - 1)
    col = tuple(round(a + (b - a) * t) for a, b in zip(c1, c2)) + (255,)
    gd.line([(i, 0), (0, i)], fill=col, width=1)

radius = int(56 * SS)
mask = Image.new('L', (W, W), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, W - 1], radius=radius, fill=255)
img.paste(grad, (0, 0), mask)

# ── 话筒：胶囊 + 拾音弧 + 支架 ─────────────────────────────────
white = (255, 255, 255, 255)
cx = W // 2
cap_w, cap_h = int(26 * SS), int(52 * SS)
cap_top = int(56 * SS)
d.rounded_rectangle(
    [cx - cap_w // 2, cap_top, cx + cap_w // 2, cap_top + cap_h],
    radius=cap_w // 2, fill=white)

# 拾音弧（用粗弧线画半圆）
arc_r = int(34 * SS)
arc_box = [cx - arc_r, cap_top + cap_h - arc_r, cx + arc_r, cap_top + cap_h + arc_r]
d.arc(arc_box, start=0, end=180, fill=white, width=int(7 * SS))

# 支架
stem_top = cap_top + cap_h + arc_r - int(2 * SS)
d.line([(cx, stem_top), (cx, stem_top + int(18 * SS))], fill=white, width=int(7 * SS))
d.line([(cx - int(18 * SS), stem_top + int(18 * SS)),
        (cx + int(18 * SS), stem_top + int(18 * SS))], fill=white, width=int(7 * SS))

# ── 右上角音符 ────────────────────────────────────────────────
note_x, note_y = int(180 * SS), int(52 * SS)
r_head = int(9 * SS)
d.ellipse([note_x - r_head, note_y - r_head, note_x + r_head, note_y + r_head], fill=white)
d.line([(note_x + r_head - int(2 * SS), note_y),
        (note_x + r_head - int(2 * SS), note_y - int(34 * SS))], fill=white, width=int(6 * SS))
d.polygon([(note_x + r_head - int(2 * SS), note_y - int(34 * SS)),
           (note_x + r_head + int(14 * SS), note_y - int(28 * SS)),
           (note_x + r_head + int(14 * SS), note_y - int(20 * SS)),
           (note_x + r_head - int(2 * SS), note_y - int(26 * SS))], fill=white)

# ── 左下角小声波（两条弧）────────────────────────────────────
for i, radius_wave in enumerate((int(16 * SS), int(26 * SS))):
    box = [int(28 * SS) - radius_wave, int(176 * SS) - radius_wave,
           int(28 * SS) + radius_wave, int(176 * SS) + radius_wave]
    d.arc(box, start=-60, end=60, fill=(255, 255, 255, 210 - i * 45), width=int(6 * SS))

img = img.resize((S, S), Image.LANCZOS)
path = os.path.join(out_dir, 'icon.png')
img.save(path, 'PNG', optimize=True)
print('写出', path, os.path.getsize(path), 'bytes')
