"""Draw observed TTN morph states, not an illustrative or simulated trajectory."""
import csv
import gzip
import html
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
data = json.loads(gzip.decompress((ROOT / 'pilot-results/TTN/results.json.gz').read_bytes()))
origin = {v['key']['position']: v for v in data['runs'][0]['minimized']}
target = {v['key']['position']: v for v in data['runs'][1]['minimized']}
positions = [p for p in sorted(origin) if origin[p]['key']['alternate'] != target[p]['key']['alternate']]
assert len(positions) == 17
assert len(origin) == len(target) == 52

svg = ['<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="820" viewBox="0 0 1500 820">',
       '<rect width="1500" height="820" fill="#ffffff"/>',
       '<g font-family="DejaVu Sans, Arial, sans-serif" fill="#172b3a">']

def text(x, y, value, size=20, weight='normal', anchor='start', extra=''):
    svg.append(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" '
               f'text-anchor="{anchor}" {extra}>{html.escape(str(value))}</text>')

def rect(x, y, w, h, fill, stroke='none', radius=6):
    svg.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" '
               f'fill="{fill}" stroke="{stroke}"/>')

text(40, 49, 'Different alleles, same predicted-impact score', 32, 'bold')
text(40, 83, 'TTN: morphing optimized seed 1 toward optimized seed 2', 22)
rect(40, 106, 23, 23, '#e8edf2', '#bdc9d3')
text(74, 125, 'Origin allele retained', 19)
rect(334, 106, 23, 23, '#9edfe8', '#317d8b')
text(368, 125, 'Target allele copied', 19)
text(720, 125, 'Letters show the actual ALT at each position.', 19)
text(40, 177, 'The 17 positions where the endpoints differ', 21, 'bold')
text(40, 204, 'GRCh37 chromosome 2 · 1-based positions · columns in genomic order, not to scale', 18)

x0, cellw, step, y0 = 203, 48, 58, 355
for col, pos in enumerate(positions):
    x = x0 + col * step
    label_y = 270 if col % 2 == 0 else 310
    text(x + 24, label_y, pos, 15, anchor='middle')
    svg.append(f'<path d="M{x + 24},{label_y + 7} V347" stroke="#bdc9d3" fill="none"/>')
text(40, 327, 'Morph amount', 19, 'bold')
text(1260, 310, 'Copied', 19, 'bold', 'middle')
text(1260, 334, 'positions', 19, 'bold', 'middle')
text(1400, 310, 'Impact', 19, 'bold', 'middle')
text(1400, 334, 'score', 19, 'bold', 'middle')

rows = []
previous = set()
for row, morph in enumerate(data['morphs']):
    y = y0 + row * 63
    variants = {v['key']['position']: v for v in morph['variants']}
    copied = set()
    text(40, y + 31, f"{morph['amount']}%", 24, 'bold')
    if row == 0:
        text(110, y + 31, 'origin', 17)
    elif row == 4:
        text(112, y + 31, 'target', 17)
    for col, pos in enumerate(positions):
        alt = variants[pos]['key']['alternate']
        a, b = origin[pos]['key']['alternate'], target[pos]['key']['alternate']
        assert alt in (a, b)
        is_target = alt == b
        if is_target:
            copied.add(pos)
        rect(x0 + col * step, y, cellw, 45,
             '#9edfe8' if is_target else '#e8edf2', '#317d8b' if is_target else '#bdc9d3')
        text(x0 + col * step + cellw / 2, y + 31, alt, 25, 'bold', 'middle')
        rows.append({'morph_percent': morph['amount'], 'position_1based': pos,
                     'origin_alt': a, 'target_alt': b, 'effective_alt': alt,
                     'target_copied': is_target})
    assert previous <= copied, 'Expected nested subsets for the fixed ordering seed'
    previous = copied
    assert len(copied) == morph['job']['result']['selectedPositions']
    score = morph['scoreCheck']['result']['scoreBefore']
    assert abs(score - 34.69) < 1e-8
    text(1260, y + 31, f'{len(copied)} / 17', 24, 'bold', 'middle')
    text(1400, y + 31, f'{score:.2f}', 24, 'bold', 'middle')

rect(40, 695, 1420, 92, '#f4f7f9')
text(59, 725, 'At 25%, five columns have switched to the target allele. At 100%, all seventeen have switched.', 20, 'bold')
text(59, 752, 'The other 35 positions are unchanged and omitted here; each score includes all 52 positions (67 ALT copies).', 18)
text(59, 776, 'One run per amount, each from a fresh origin copy. Fixed ordering seed: 20260912. Equal scores do not establish equal function.', 17)
svg.append('</g></svg>')
(ROOT / 'figures/figure-3-morph-positions.svg').write_text('\n'.join(svg) + '\n')
with (ROOT / 'pilot-results/TTN/morph-positions.csv').open('w', newline='') as handle:
    writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
    writer.writeheader()
    writer.writerows(rows)
print('Verified 85 observed cells, nested copied subsets and five scores; wrote SVG and CSV.')
