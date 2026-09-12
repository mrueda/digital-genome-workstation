"""Predict all TTN non-REF SNVs, verify archived totals, and draw substitution deltas."""
import csv
import gzip
import html
import itertools
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent
archive = root / 'pilot-results/TTN'
out = archive / 'substitution-comparison'
out.mkdir(exist_ok=True)
data = json.loads(gzip.decompress((archive / 'results.json.gz').read_bytes()))
bundle = json.loads((archive / 'input-manifest.json').read_text())['manifest']['resourceBundle']
source = {v['key']['position']:v for v in data['original']}
positions = sorted(source)
assert len(source) == len(data['original']) == 52
bases = 'ACGT'
pairs = list(itertools.permutations(bases, 2))
keys = [(p, source[p]['key']['reference'], a) for p in positions for a in bases if a != source[p]['key']['reference']]
lengths = dict(line.split()[:2] for line in Path(bundle['referenceFaiPath']).read_text().splitlines())
vcf = out / 'candidate-alleles.vcf'
with vcf.open('w') as f:
    f.write(f'##fileformat=VCFv4.2\n##contig=<ID=2,length={lengths["2"]}>\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n')
    for i, (pos, ref, alt) in enumerate(keys):
        f.write(f'2\t{pos}\tP{i}\t{ref}\t{alt}\t.\tPASS\t.\n')
cmd = [bundle['bcftoolsPath'], 'csq', '--local-csq', '--ncsq', '64', '--fasta-ref', bundle['referencePath'],
       '--gff-annot', bundle['consequenceAnnotation']['path'], '-Ov', '-o', str(out/'annotated.vcf'), str(vcf)]
result = subprocess.run(cmd, capture_output=True, text=True, check=True)
(out/'command.json').write_text(json.dumps(cmd, indent=2)+'\n')
(out/'stderr.txt').write_text(result.stderr)
# Mirrors evaluation.rs consequence_term_impact; every run total is checked below.
weights = {}
for terms, weight in [
    ('transcript_ablation splice_acceptor splice_donor stop_gained frameshift stop_lost start_lost transcript_amplification', 1.),
    ('inframe_insertion inframe_deletion missense protein_altering', .67),
    ('splice_region incomplete_terminal_codon start_retained stop_retained synonymous', .33)]:
    weights.update(dict.fromkeys(terms.split(), weight))
scores, annotations = {}, {}
for line in (out/'annotated.vcf').read_text().splitlines():
    if line.startswith('#'):
        continue
    f = line.split('\t')
    info = dict(x.split('=',1) for x in f[7].split(';') if '=' in x)
    raw = info.get('BCSQ','')
    terms = [t for entry in raw.split(',') for t in entry.split('|')[0].split('&')]
    key = (int(f[1]), f[4])
    assert key not in scores
    scores[key] = max(weights.get(t.lower(), .1) for t in terms)
    annotations[key] = raw
assert len(scores) == 156
counts = {(p,a,b):0 for p in positions for a,b in pairs}
for run in data['runs']:
    for state, field in [('randomized','scoreBefore'),('minimized','scoreAfter')]:
        total = sum(scores[(v['key']['position'],v['key']['alternate'])] *
                    (int(v['haplotype1Alt']) + int(v['haplotype2Alt']) + v['unphasedAlt']) for v in run[state])
        assert abs(total-run['optimizer']['result'][field]) < 1e-8, (run['seed'], state, total)
    a = {v['key']['position']:v['key']['alternate'] for v in run['randomized']}
    b = {v['key']['position']:v['key']['alternate'] for v in run['minimized']}
    changed = 0
    for p in positions:
        if a[p] != b[p]:
            counts[p,a[p],b[p]] += 1
            changed += 1
            assert scores[p,b[p]] < scores[p,a[p]]
    assert changed == run['optimizer']['result']['changedPositions']

svg = ['<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1530" viewBox="0 0 1080 1530">',
       '<rect width="1080" height="1530" fill="white"/>',
       '<g font-family="DejaVu Sans, Arial, sans-serif" fill="#172b3a">']
def text(x,y,s,size=18,bold=False,anchor='start'):
    svg.append(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{"bold" if bold else "normal"}" text-anchor="{anchor}">{html.escape(str(s))}</text>')
def rect(x,y,w,h,fill):
    svg.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="2" fill="{fill}"/>')
def color(delta):
    if abs(delta) < 1e-8:
        return '#f4f5f6'
    endpoint = (53,170,190) if delta < 0 else (230,143,63)
    t = min(abs(delta)/.67,1)
    return '#'+''.join(f'{round(250+(v-250)*t):02x}' for v in endpoint)
text(30,40,'Base substitutions and their predicted consequences',27,True)
text(30,73,'TTN · 52 positions × 12 directed substitutions · GRCh37 chromosome 2',20)
text(30,105,'Colour: impact after − before, per ALT copy. Numbers: runs choosing that substitution (of 10).',18)
for i,delta in enumerate([-.67,-.34,0,.34,.67]):
    xx = 30+i*118
    rect(xx,124,48,22,color(delta));text(xx+55,141,f'{delta:+.2f}',16)
rect(651,124,24,22,'#dce2e7');text(663,141,'×',18,False,'middle');text(686,141,'REF involved: outside saturation scope',16)
text(30,178,'Position',17,True);text(151,178,'REF',15,True)
x0, step, y0 = 200, 60, 193
for j,(a,b) in enumerate(pairs):
    text(x0+j*step+27,178,f'{a}→{b}',17,True,'middle')
text(997,160,'Changed',16,True,'middle');text(997,179,'runs / 10',16,True,'middle')
export = []
for i,p in enumerate(positions):
    y = y0+i*23
    ref = source[p]['key']['reference']
    text(30,y+16,p,16);text(166,y+16,ref,16,True,'middle')
    for j,(a,b) in enumerate(pairs):
        valid = ref not in (a,b)
        delta = round(scores[p,b]-scores[p,a],2) if valid else None
        count = counts[p,a,b]
        assert valid or count == 0
        xx = x0+j*step
        rect(xx,y,55,20,color(delta) if valid else '#dce2e7')
        if not valid:
            text(xx+27,y+16,'×',15,False,'middle')
        elif count:
            text(xx+27,y+16,count,16,True,'middle')
        export.append({'position_1based':p,'reference':ref,'from':a,'to':b,'status':'scored' if valid else 'REF_outside_scope',
                       'impact_delta_per_copy':delta,'chosen_runs':count,'from_annotation':annotations.get((p,a),''),
                       'to_annotation':annotations.get((p,b),'')})
    text(997,y+16,sum(counts[p,a,b] for a,b in pairs),16,True,'middle')
text(30,1420,'Cyan: lower predicted impact. Orange: higher. Neutral: equal. Blank scored cells: never chosen.',18)
text(30,1452,'Comparisons cover the three non-reference ALTs at each position, not reference reversion.',18)
text(30,1484,'Colours describe consequence scores, not measured function or ClinVar eligibility.',18)
text(30,1514,'All 20 track totals independently reproduced from 156 predicted alleles; exact values are retained as CSV.',17)
svg.append('</g></svg>')
(root/'figures/figure-2-substitution-matrix.svg').write_text('\n'.join(svg)+'\n')
with (archive/'substitution-impact-matrix.csv').open('w',newline='') as f:
    w=csv.DictWriter(f,fieldnames=list(export[0]));w.writeheader();w.writerows(export)
print('Verified 156 allele scores, 20 archived track totals, 624 cells and all chosen counts.')
