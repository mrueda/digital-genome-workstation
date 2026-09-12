"""Draw actual changed positions for all ten archived TTN minimization runs."""
import csv
import gzip
import html
import json
from pathlib import Path

root = Path(__file__).resolve().parent
archive = root / 'pilot-results/TTN'
data = json.loads(gzip.decompress((archive / 'results.json.gz').read_bytes()))
positions = sorted(v['key']['position'] for v in data['original'])
assert len(set(positions)) == len(positions) == 52
svg = ['<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="870" viewBox="0 0 1600 870">',
       '<rect width="1600" height="870" fill="white"/>',
       '<g font-family="DejaVu Sans, Arial, sans-serif" fill="#172b3a">']
def text(x, y, value, size=20, bold=False, anchor='start'):
    svg.append(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{"bold" if bold else "normal"}" text-anchor="{anchor}">{html.escape(str(value))}</text>')
def rect(x, y, w, h, fill, stroke='none'):
    svg.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="2" fill="{fill}" stroke="{stroke}"/>')
text(38, 48, 'Which positions change during minimization?', 32, True)
text(38, 84, 'TTN · all 10 seeds × all 52 SNV positions · 67 ALT copies per track', 23)
rect(40, 109, 23, 23, '#168ca1'); text(75, 129, 'ALT changed', 20)
rect(286, 109, 23, 23, '#e8edf2', '#bdc9d3'); text(322, 129, 'ALT unchanged', 20)
text(635, 129, 'Colour marks a sequence change, not its magnitude or biological benefit.', 20)
text(38, 177, 'Positions are ordered by genomic coordinate; numbered labels map to the coordinate key below.', 20)
x0, step, y0 = 98, 23, 244
text(35, 227, 'Seed', 18, True)
for i in range(52):
    text(x0 + i*step + 10, 224, i+1, 12, anchor='middle')
text(1364, 205, 'Score', 19, True, 'middle'); text(1364, 227, 'before → after', 17, False, 'middle')
text(1528, 205, 'Changed', 19, True, 'middle'); text(1528, 227, 'positions', 17, False, 'middle')
export = []
for r, run in enumerate(data['runs']):
    assert run['seed'] == r+1
    before = {v['key']['position']:v for v in run['randomized']}
    after = {v['key']['position']:v for v in run['minimized']}
    assert sorted(before) == sorted(after) == positions
    changed = 0
    y = y0 + r*36
    text(53, y+22, run['seed'], 22, True, 'middle')
    for col, pos in enumerate(positions):
        a, b = before[pos], after[pos]
        assert a['key']['reference'] == b['key']['reference']
        for field in ['haplotype1Alt', 'haplotype2Alt', 'unphasedAlt', 'unphasedSlot']:
            assert a.get(field) == b.get(field)
        diff = a['key']['alternate'] != b['key']['alternate']
        changed += diff
        rect(x0+col*step, y, 20, 27, '#168ca1' if diff else '#e8edf2', '#168ca1' if diff else '#ccd5dc')
        export.append({'seed':run['seed'], 'column':col+1, 'contig':'2', 'position_1based':pos,
                       'reference':a['key']['reference'], 'randomized_alt':a['key']['alternate'],
                       'minimized_alt':b['key']['alternate'], 'changed':diff})
    result = run['optimizer']['result']
    assert changed == result['changedPositions']
    text(1364, y+22, f"{result['scoreBefore']:.2f} → {result['scoreAfter']:.2f}", 19, False, 'middle')
    text(1528, y+22, changed, 22, True, 'middle')
text(38, 640, 'Coordinate key: GRCh37 chromosome 2, 1-based. Columns are evenly spaced, not genomic distances.', 18, True)
for i, pos in enumerate(positions):
    col, row = i % 13, i // 13
    text(38 + col*119, 673 + row*29, f'{i+1}: {pos}', 14)
text(38, 807, 'Every row reaches 34.69 model units, but all ten final allele configurations remain distinct.', 22, True)
text(38, 840, 'One minimization per randomized seed. Artificial perturbations, not donor findings or evidence of functional rescue.', 20)
svg.append('</g></svg>')
(root / 'figures/figure-2-minimization-matrix.svg').write_text('\n'.join(svg)+'\n')
with (archive / 'minimization-allele-matrix.csv').open('w', newline='') as handle:
    writer=csv.DictWriter(handle, fieldnames=list(export[0]));writer.writeheader();writer.writerows(export)
print('Verified all 520 allele pairs, unchanged genotype/phase fields, and ten changed-position counts.')
