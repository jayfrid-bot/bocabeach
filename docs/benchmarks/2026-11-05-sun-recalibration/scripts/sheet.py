# Contact sheet: rows = (date, event, cam), 6 frames across the window.
import sys, os, glob
from PIL import Image, ImageDraw
D = sys.argv[1]; out = sys.argv[2]; specs = sys.argv[3:]  # date:event:cam
W, H = 320, 180
rows = []
for s in specs:
    date, ev, cam = s.split(":")
    files = sorted(glob.glob(f"{D}/frames/{date}/{ev}/{cam}/*.jpg"))
    if not files: continue
    pick = [files[int(i * (len(files) - 1) / 5)] for i in range(6)]
    rows.append((s, pick))
sheet = Image.new("RGB", (W * 6, (H + 16) * len(rows)), "black")
d = ImageDraw.Draw(sheet)
for r, (s, pick) in enumerate(rows):
    y = r * (H + 16)
    d.text((4, y + 2), s, fill="white")
    for c, f in enumerate(pick):
        im = Image.open(f).convert("RGB").resize((W, H))
        sheet.paste(im, (c * W, y + 16))
        d.text((c * W + 4, y + 18), os.path.basename(f)[:6], fill="yellow")
sheet.save(out, quality=80)
print(out, len(rows))
