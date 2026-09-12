"""Plot the ten observed TTN randomization/minimization pairs from archived CSV."""
import csv
import gzip
import html
import json
from pathlib import Path

root = Path(__file__).resolve().parent
rows = list(csv.DictReader((root / 'pilot-results/TTN/randomizer-optimizer.csv').open()))
assert [int(r['seed']) for r in rows] == list(range(1, 11))
svg = ['<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1450" viewBox="0 0 1200 1450">',
       '<rect width="1200" height="1450" fill="white"/>',
       '<g font-family="DejaVu Sans, Arial, sans-serif" fill="#172b3a">']
def text(x, y, s, size=20, weight='normal', anchor='start'):
    svg.append(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" text-anchor="{anchor}">{html.escape(str(s))}</text>')
def line(x1, y1, x2, y2, color, width=1):
    svg.append(f'<path d="M{x1},{y1} L{x2},{y2}" stroke="{color}" stroke-width="{width}" fill="none"/>')
def dot(x, y, color):
    svg.append(f'<circle cx="{x}" cy="{y}" r="7" fill="{color}"/>')
def x(score):
    return 155 + score * 18
text(40, 48, 'A  Lower predicted impact across ten perturbations', 30, 'bold')
text(40, 84, 'TTN · 52 SNV positions · 67 ALT copies · fixed randomization seeds 1–10', 21)
dot(49, 121, '#ad6800'); text(66, 128, 'Randomized', 19)
dot(261, 121, '#167d91'); text(279, 128, 'Minimized', 19)
text(40, 174, 'Seed', 18, 'bold')
text(1065, 155, 'Changed', 18, 'bold', 'middle')
text(1065, 178, 'positions', 18, 'bold', 'middle')
for tick in range(0, 46, 5):
    line(x(tick), 190, x(tick), 649, '#e1e7ec')
    text(x(tick), 673, tick, 17, anchor='middle')
for i, row in enumerate(rows):
    y = 211 + i * 46
    before, after = float(row['score_randomized']), float(row['score_minimized'])
    assert after <= before and int(row['second_pass_changes']) == 0
    line(x(after), y, x(before), y, '#778997', 3)
    dot(x(before), y, '#ad6800'); dot(x(after), y, '#167d91')
    text(64, y + 7, row['seed'], 21, anchor='middle')
    text(x(after) - 13, y + 6, f'{after:.2f}', 17, anchor='end')
    text(x(before) + 13, y + 6, f'{before:.2f}', 17)
    text(1065, y + 7, row['positions_changed'], 21, anchor='middle')
text(560, 708, 'Additive predicted-impact score (model units)', 21, anchor='middle')
text(40, 749, 'All ten minimized configurations remain distinct. A second pass changed no positions.', 20, 'bold')
text(40, 805, 'B  All 14 changed positions in seed 1', 28, 'bold')
text(40, 840, 'GRCh37 chromosome 2 · 1-based positions · genomic-strand alleles', 21)
data = json.loads(gzip.decompress((root / 'pilot-results/TTN/results.json.gz').read_bytes()))
changes = json.loads((root / 'pilot-results/TTN/consequence-check/changed-consequences.json').read_text())
before = {v['key']['position']: v for v in data['runs'][0]['randomized']}
after = {v['key']['position']: v for v in data['runs'][0]['minimized']}
assert len(changes) == int(rows[0]['positions_changed']) == 14
assert {p for p in before if before[p]['key']['alternate'] != after[p]['key']['alternate']} == {r['position'] for r in changes}
svg.append('<rect x="40" y="857" width="1120" height="40" fill="#e8edf2"/>')
for tx, label in [(55, 'Position'), (257, 'REF'), (366, 'ALT before'), (535, 'ALT after'), (740, 'Predicted consequence')]:
    text(tx, 885, label, 20, 'bold')
export = []
for i, row in enumerate(changes):
    y = 910 + i * 33
    pos = row['position']
    assert row['from'] == before[pos]['key']['alternate']
    assert row['to'] == after[pos]['key']['alternate']
    if i % 2:
        svg.append(f'<rect x="40" y="{y-17}" width="1120" height="33" fill="#f4f7f9"/>')
    def consequence(field):
        terms = {v.split('|')[0] for v in row[field].split(',')}
        assert len(terms) == 1, 'Review differing transcript consequence classes explicitly'
        return terms.pop().replace('_', '-')
    c1, c2 = consequence('randomizedConsequences'), consequence('minimizedConsequences')
    text(55, y+7, pos, 22)
    text(279, y+7, before[pos]['key']['reference'], 22, anchor='middle')
    svg.append(f'<rect x="397" y="{y-15}" width="32" height="29" rx="4" fill="#f7e3bd"/>')
    text(413, y+8, row['from'], 23, 'bold', 'middle')
    text(494, y+7, '→', 22, anchor='middle')
    svg.append(f'<rect x="563" y="{y-15}" width="32" height="29" rx="4" fill="#9edfe8"/>')
    text(579, y+8, row['to'], 23, 'bold', 'middle')
    text(740, y+7, f'{c1} → {c2}', 21)
    export.append({'position_1based': pos, 'reference': before[pos]['key']['reference'],
                   'randomized_alt': row['from'], 'minimized_alt': row['to'],
                   'randomized_consequence': c1, 'minimized_consequence': c2})
text(40, 1388, 'Seed 1: 42.11 → 34.69. The 38 unchanged positions are omitted from B but remain in the score.', 21, 'bold')
text(40, 1424, 'Artificial perturbations, not donor findings. Lower predicted impact does not demonstrate restored gene function.', 19)
with (root / 'pilot-results/TTN/minimization-seed1-variants.csv').open('w', newline='') as handle:
    writer = csv.DictWriter(handle, fieldnames=list(export[0]))
    writer.writeheader()
    writer.writerows(export)
print('Verified 10 score pairs and all 14 seed-1 allele/consequence changes.')
svg.append('</g></svg>')
(root / 'figures/figure-2-minimization.svg').write_text('\n'.join(svg) + '\n')
