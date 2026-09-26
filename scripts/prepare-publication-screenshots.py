"""Crop native 2x captures; no resampling or replacement of application content.

Usage: python3 scripts/prepare-publication-screenshots.py CAPTURE_DIRECTORY
See manuscript/figures/README.md for the synthetic example and capture settings.
"""
from pathlib import Path
import sys
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[1]
source = Path(sys.argv[1])
target = root / "docs-site/static/img/devices"
target.mkdir(parents=True, exist_ok=True)

def crop(name, box, destination):
    image = Image.open(source / f"{name}-raw.png").convert("RGB")
    assert 0 <= box[0] < box[2] <= image.width and 0 <= box[1] < box[3] <= image.height
    image = image.crop(box)
    image.save(destination, optimize=True)
    return image

for name, top, bottom in [
    ("generator", 154, 1635), ("morph", 154, 1690),
    ("predictor", 128, 2030), ("optimizer", 128, 1940),
    ("compare", 128, 1670), ("genome", 128, 1370),
    ("compare-consequences", 128, 1910),
]:
    crop(name, (0, top, 2800, bottom), target / f"{name}.png")

crop("roll", (452, 1360, 1740, 1980), target / "allele-roll.png")
crop("workspace", (2548, 314, 3100, 1450), target / "monitor.png")
crop("workspace", (3100, 128, 3760, 1502), target / "evidence.png")
figures = root / "manuscript/figures"
base = crop("workspace", (0, 0, 3760, 1742), figures / "figure-1-workspace-base.png")
base.save(target / "workspace.png", optimize=True)
canvas = Image.new("RGB", (3760, 1822), "white")
canvas.paste(base, (0, 0))
draw = ImageDraw.Draw(canvas)
font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 33)
legend_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 30)
labels = [
    ("A", 397, 171, "#39acc0", "Source variants"),
    ("B", 831, 516, "#eeaa57", "Genome tracks"),
    ("C", 3026, 350, "#dfbd53", "Track Monitor"),
    ("D", 3685, 235, "#77c29a", "Evidence"),
    ("E", 2290, 1137, "#b49adc", "Device Rack"),
    ("F", 1395, 174, "#85bed5", "Genome Transport"),
]
svg = ['<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="3760" height="1822" viewBox="0 0 3760 1822">', '<rect width="3760" height="1822" fill="white"/>', '<image width="3760" height="1742" xlink:href="figure-1-workspace-base.png"/>']
for index, (letter, x, y, color, description) in enumerate(labels):
    draw.ellipse((x-27,y-27,x+27,y+27), fill=color, outline="white", width=4)
    draw.text((x,y), letter, font=font, fill="#19282e", anchor="mm")
    lx = 36 + index * 620
    draw.text((lx, 1780), f"{letter}  {description}", font=legend_font, fill="#19282e", anchor="lm")
    svg.append(f'<circle cx="{x}" cy="{y}" r="27" fill="{color}" stroke="white" stroke-width="4"/><text x="{x}" y="{y+11}" text-anchor="middle" font-family="DejaVu Sans" font-size="33" font-weight="bold" fill="#19282e">{letter}</text>')
    svg.append(f'<text x="{lx}" y="1791" font-family="DejaVu Sans" font-size="30" fill="#19282e">{letter}  {description}</text>')
svg.append('</svg>')
canvas.save(figures / "figure-1-workspace.png", optimize=True)
(figures / "figure-1-workspace.svg").write_text("\n".join(svg) + "\n")
print("Prepared native-resolution documentation captures and Figure 1")
