# Нарезка art/ui-sheet.png (сетка 8x8) на спрайты art/ui-*.png.
# Шахматный фон в листе «запечён» в пиксели, поэтому прозрачность восстанавливаем заливкой от краёв и дыр.
# Нужен Pillow: python3 -m venv .venv && .venv/bin/pip install pillow && .venv/bin/python slice-ui.py
from PIL import Image, ImageChops, ImageFilter
from collections import deque

NAMES = [
  'btn btn-glow btn-press btn-off btn-danger btn-danger-press btn-round btn-round-press',
  'frame-iron frame-parch frame-brass plate card card-sel card-lock slot',
  'tab-on tab-off tab-hover tog-off tog-on slider check check-on',
  'tube tube-red tube-green tube-amber gauge needle thermo segbar',
  'i-coin i-coal i-cargo i-crew i-rep i-ship i-compass i-time',
  'i-pirate i-storm i-cannon i-void i-broke i-repair i-warn i-star',
  'up down flat buy sell close badge pin',
  'div-l div-m div-r corner rivet gear gear-s steam',
]
im = Image.open('art/ui-sheet.png').convert('RGB')
W, H = im.size
px = im.load()

def checker(x, y):
  r, g, b = px[x, y]
  return abs(r - g) <= 4 and abs(g - b) <= 4 and r >= 185

# фон: серо-белые пиксели, связанные с краем листа или с большой дырой (область > 400 px)
seen = bytearray(W * H)
bg = bytearray(W * H)
for sy in range(H):
  for sx in range(W):
    i = sy * W + sx
    if seen[i] or not checker(sx, sy): continue
    comp, q = [], deque([(sx, sy)])
    seen[i] = 1
    edge = False
    while q:
      x, y = q.popleft(); comp.append(y * W + x)
      if x in (0, W - 1) or y in (0, H - 1): edge = True
      for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        nx, ny = x + dx, y + dy
        if 0 <= nx < W and 0 <= ny < H and not seen[ny * W + nx] and checker(nx, ny):
          seen[ny * W + nx] = 1; q.append((nx, ny))
    if edge or len(comp) > 400:
      for j in comp: bg[j] = 1

mask = Image.new('L', (W, H), 255)
mp = mask.load()
for y in range(H):
  for x in range(W):
    if bg[y * W + x]: mp[x, y] = 0
# убираем светлую кайму от шахматки: сжимаем маску на 1 px и слегка размываем край
mask = mask.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.6))
rgba = im.copy(); rgba.putalpha(mask)

# спрайты = связные области переднего плана (с зазором 1 px, чтобы части одного элемента слиплись);
# область относим к ячейке сетки по её центру, мелочь (< 300 px) отбрасываем
fg = mask.point(lambda v: 255 if v > 40 else 0)
grow = fg.filter(ImageFilter.MaxFilter(3))
gp = grow.load(); fp = fg.load()
lab = [[0] * W for _ in range(H)]
comps = []
for sy in range(H):
  for sx in range(W):
    if gp[sx, sy] and not lab[sy][sx]:
      n = len(comps) + 1
      q = deque([(sx, sy)]); lab[sy][sx] = n
      x0 = x1 = sx; y0 = y1 = sy; area = 0
      while q:
        x, y = q.popleft(); area += 1
        x0 = min(x0, x); x1 = max(x1, x); y0 = min(y0, y); y1 = max(y1, y)
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
          nx, ny = x + dx, y + dy
          if 0 <= nx < W and 0 <= ny < H and gp[nx, ny] and not lab[ny][nx]:
            lab[ny][nx] = n; q.append((nx, ny))
      comps.append([n, x0, y0, x1, y1, area])
cw = W / 8
cells = {}
for n, x0, y0, x1, y1, area in comps:
  if area < 300: continue
  c, r = int((x0 + x1) / 2 // cw), int((y0 + y1) / 2 // cw)
  cells.setdefault((r, c), []).append((n, x0, y0, x1, y1))
for r, row in enumerate(NAMES):
  for c, name in enumerate(row.split()):
    parts = cells.get((r, c))
    if not parts: print('пусто:', name); continue
    ids = {p[0] for p in parts}
    x0 = min(p[1] for p in parts); y0 = min(p[2] for p in parts)
    x1 = max(p[3] for p in parts) + 1; y1 = max(p[4] for p in parts) + 1
    box = (x0, y0, x1, y1)
    cell = rgba.crop(box)
    # прозрачным делаем всё, что не относится к областям этой ячейки (куски соседей)
    keep = Image.new('L', cell.size, 0); kp = keep.load()
    for y in range(y0, y1):
      for x in range(x0, x1):
        if lab[y][x] in ids: kp[x - x0, y - y0] = 255
    a = ImageChops.multiply(cell.getchannel('A'), keep)
    cell.putalpha(a)
    cell.save('art/ui-%s.png' % name, optimize=True)
print('готово')
