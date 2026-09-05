"""Compare DGW's current tools with a packaged toolchain on the public exome fixture."""
import argparse
import hashlib
import json
from pathlib import Path
import statistics
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument('package_bin', type=Path)
parser.add_argument('--repeats', type=int, default=3)
parser.add_argument('--bundle', type=Path, help='Resource descriptor with absolute paths')
parser.add_argument('--fixture', type=Path, help='Public single-sample VCF to compare')
args = parser.parse_args()
if args.repeats < 1:
    parser.error('--repeats must be positive')
root = Path(__file__).resolve().parents[1]
bundle = json.loads((args.bundle or root / 'config/local-hs37d5.development.json').read_text())
fixture = args.fixture or root / 'fixtures/1000G-HG00103.SRR1596639.wes.b37.public.vcf.gz'
tools = {'current': Path(bundle['bcftoolsPath']).parent, 'package': args.package_bin.resolve()}

def run(command):
    start = time.perf_counter()
    result = subprocess.run(list(map(str, command)), capture_output=True, timeout=600)
    if result.returncode:
        raise RuntimeError(f'{command[0]} failed ({result.returncode}): '
                           f'{result.stderr.decode(errors="replace")}')
    return time.perf_counter() - start, result.stdout

results = {name: {'normalize': [], 'csq': [], 'compress': []} for name in tools}
fingerprints = {}
with tempfile.TemporaryDirectory(prefix='dgw-tool-benchmark-') as temporary:
    temp = Path(temporary)
    passed = temp / 'pass.vcf'
    run([tools['current'] / 'bcftools', 'view', '-f', 'PASS', '-Ov', '-o', passed, fixture])
    for repeat in range(args.repeats):
        for name in (list(tools) if repeat % 2 == 0 else list(reversed(tools))):
            binary = tools[name] / 'bcftools'
            norm = temp / f'{name}.norm.vcf.gz'
            elapsed, _ = run([binary, 'norm', '-c', 'e', '-m', '-both', '-f', bundle['referencePath'], '-Oz', '-o', norm, passed])
            results[name]['normalize'].append(elapsed)
            elapsed, _ = run([tools[name] / 'bgzip', '-c', passed])
            results[name]['compress'].append(elapsed)
            effects = temp / f'{name}.effects.vcf.gz'
            elapsed, _ = run([binary, 'csq', '--local-csq', '-f', bundle['referencePath'], '-g', bundle['consequenceAnnotation']['path'], '-Oz', '-o', effects, norm])
            results[name]['csq'].append(elapsed)
            _, rows = run([binary, 'query', '-f', '%CHROM\t%POS\t%REF\t%ALT[\t%GT]\t%BCSQ\n', effects])
            fingerprints.setdefault(name, set()).add(hashlib.sha256(rows).hexdigest())
            print(json.dumps({'repeat': repeat + 1, 'toolchain': name, 'seconds': {k: v[-1] for k, v in results[name].items()}}), flush=True)
    if fingerprints['current'] != fingerprints['package'] or len(fingerprints['current']) != 1:
        raise RuntimeError(f'Alleles, genotypes or consequences differ: {fingerprints}')
    print(json.dumps({'medianSeconds': {name: {step: statistics.median(times) for step, times in steps.items()} for name, steps in results.items()}, 'identicalAllelesGenotypesAndConsequences': True, 'repeats': args.repeats, 'fixture': str(fixture), 'toolDirectories': {name: str(path) for name, path in tools.items()}, 'resultSha256': next(iter(fingerprints['current']))}, indent=2))
