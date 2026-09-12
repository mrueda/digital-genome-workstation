"""Archive generated pilot outputs and compact tables; never overwrite a run."""
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import statistics
import sys

destination = Path(sys.argv[1])
destination.mkdir()
summary = []
for directory in sys.argv[2:]:
    root = Path(directory)
    manifest = json.loads((root / "input-manifest.json").read_text())
    gene = manifest["gene"]["symbol"]
    output = destination / gene
    output.mkdir()
    candidates = [root / "results", root / "results-v2"]
    results = next((p for p in candidates if (p / "results.json").is_file()), None)
    if results is None:
        raise FileNotFoundError(f"No completed pilot results in {root}")
    shutil.copy2(root / "input-manifest.json", output)
    for name in ["settings.json", "randomizer-optimizer.csv", "morph.csv", "diversity.json"]:
        shutil.copy2(results / name, output)
    for name in ["results.json", "mcp-transcript.jsonl"]:
        with (output / (name + ".gz")).open("xb") as handle:
            handle.write(gzip.compress((results / name).read_bytes(), mtime=0))
    payload = json.loads((results / "results.json").read_text())
    runs = [r["optimizer"]["result"] for r in payload["runs"]]
    diversity = json.loads((results / "diversity.json").read_text())
    before = [r["scoreBefore"] for r in runs]
    changes = [r["changedPositions"] for r in runs]
    summary.append({"gene": gene, "positions": len(payload["original"]),
                    "randomized_score_range": f"{min(before):.2f}–{max(before):.2f}",
                    "randomized_mean": round(statistics.mean(before), 3),
                    "minimized_score": round(runs[0]["scoreAfter"], 2),
                    "changed_positions_range": f"{min(changes)}–{max(changes)}",
                    "unique_randomized": diversity["randomized"]["unique_states"],
                    "unique_minimized": diversity["minimized"]["unique_states"],
                    "mean_pairwise_before": round(diversity["randomized"]["mean_pairwise_differences"], 3),
                    "mean_pairwise_after": round(diversity["minimized"]["mean_pairwise_differences"], 3)})

(destination / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
# Hash every resource actually needed for this experiment, excluding unused COSMIC.
bundle = manifest["manifest"]["resourceBundle"]
paths = [bundle[k] for k in ["referencePath", "referenceFaiPath", "referenceGziPath", "bcftoolsPath", "bgzipPath", "tabixPath"]]
paths += [bundle["clinvar"][k] for k in ["path", "indexPath"]]
paths += [bundle["consequenceAnnotation"]["path"], bundle["geneAnnotation"]["path"], bundle["geneAnnotation"]["indexPath"]]
hashes = {}
for raw in paths:
    path = Path(raw)
    with path.open("rb") as handle:
        sha = hashlib.file_digest(handle, "sha256").hexdigest()
    hashes[str(path)] = {"sha256": sha, "bytes": path.stat().st_size}
(destination / "resource-checksums.json").write_text(json.dumps(hashes, indent=2) + "\n")
files = [Path(__file__), Path(__file__).with_name("convergence_pilot.py"),
         Path(__file__).with_name("inspect_pilot_consequences.py"),
         Path("crates/dgw-core/examples/create_gene_pilot.rs")]
hashes = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
(destination / "script-checksums.json").write_text(json.dumps(hashes, indent=2) + "\n")
print(json.dumps(summary, indent=2))
