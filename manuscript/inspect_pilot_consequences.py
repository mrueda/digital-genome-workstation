"""Independently annotate seed-1 pilot states with the same pinned bcftools/GFF3."""
import gzip
import json
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1])
out = Path(sys.argv[2])
out.mkdir()
bundle = json.loads((root / "input-manifest.json").read_text())["manifest"]["resourceBundle"]
payload = json.loads(gzip.decompress((root / "results.json.gz").read_bytes()))
states = {"source": payload["original"], "randomized": payload["runs"][0]["randomized"],
          "minimized": payload["runs"][0]["minimized"]}
def key(v):
    k = v["key"]
    return (k["contig"], k["position"], k["reference"], k["alternate"])
keys = sorted({key(v) for state in states.values() for v in state})
lengths = {x.split()[0]: x.split()[1] for x in Path(bundle["referenceFaiPath"]).read_text().splitlines()}
with (out / "alleles.vcf").open("x") as handle:
    handle.write("##fileformat=VCFv4.2\n")
    for contig in sorted({k[0] for k in keys}):
        handle.write(f"##contig=<ID={contig},length={lengths[contig]}>\n")
    handle.write("#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n")
    for i, (contig, position, ref, alt) in enumerate(keys):
        handle.write(f"{contig}\t{position}\tP{i}\t{ref}\t{alt}\t.\tPASS\t.\n")
command = [bundle["bcftoolsPath"], "csq", "--local-csq", "--ncsq", "64", "--fasta-ref", bundle["referencePath"],
           "--gff-annot", bundle["consequenceAnnotation"]["path"], "-Ov", "-o", str(out / "annotated.vcf"), str(out / "alleles.vcf")]
result = subprocess.run(command, capture_output=True, text=True, check=True)
(out / "command.json").write_text(json.dumps(command, indent=2) + "\n")
(out / "stderr.txt").write_text(result.stderr)
annotations = {}
for line in (out / "annotated.vcf").read_text().splitlines():
    if line.startswith("#"):
        continue
    fields = line.split("\t")
    info = dict(x.split("=", 1) for x in fields[7].split(";") if "=" in x)
    annotations[(fields[0], int(fields[1]), fields[3], fields[4])] = info.get("BCSQ", "")
rows = []
for a, b in zip(states["randomized"], states["minimized"]):
    assert key(a)[:3] == key(b)[:3]
    if key(a) != key(b):
        rows.append({"position": a["key"]["position"], "from": a["key"]["alternate"], "to": b["key"]["alternate"],
                     "randomizedConsequences": annotations[key(a)], "minimizedConsequences": annotations[key(b)]})
(out / "changed-consequences.json").write_text(json.dumps(rows, indent=2) + "\n")
for row in rows:
    print(row["position"], row["from"], row["to"],
          sorted({x.split("|")[0] for x in row["randomizedConsequences"].split(",")}),
          sorted({x.split("|")[0] for x in row["minimizedConsequences"].split(",")}))
