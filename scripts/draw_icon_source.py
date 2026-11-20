"""画「灵感」原始图标 icons/icon-source.png（1024×1024）。需要 Noto Serif CJK 字体；换图标时直接替换 icon-source.png 再跑 make_icons.py 即可。"""
from PIL import Image, ImageDraw, ImageFont
import os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT = sys.argv[1] if len(sys.argv) > 1 else "/usr/share/fonts/opentype/noto/NotoSerifCJK-Black.ttc"
S = 1024


def sc_font(size):
    for i in range(10):
        try:
            f = ImageFont.truetype(FONT, size, index=i)
        except OSError:
            break
        if "SC" in " ".join(f.getname()):
            return f
    return ImageFont.truetype(FONT, size)


img = Image.new("RGB", (S, S))
d = ImageDraw.Draw(img)
top, bot = (255, 214, 64), (245, 160, 0)          # 备忘录那种暖黄色
for y in range(S):
    t = y / S
    d.line([(0, y), (S, y)], fill=tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)))

f = sc_font(330)
text = "灵感"
bb = d.textbbox((0, 0), text, font=f)
w, h = bb[2] - bb[0], bb[3] - bb[1]
x, y = (S - w) / 2 - bb[0], (S - h) / 2 - bb[1] + 30
d.text((x, y), text, font=f, fill=(255, 255, 255))
# 右上角一颗四角星：灵光一闪
cx, cy, R, r = (S + w) / 2 + 6, (S - h) / 2 - 22, 70, 16
pts = []
for k in range(8):
    import math
    a = math.pi / 4 * k - math.pi / 2
    rr = R if k % 2 == 0 else r
    pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
d.polygon(pts, fill=(255, 255, 255))
img.save(os.path.join(ROOT, "icons", "icon-source.png"))
print("saved", w, h)
