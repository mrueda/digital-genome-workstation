"""Run DGW devices through MCP. Requires a NEW project from create_gene_pilot.

No genome-editing or consequence-prediction logic is implemented here.
All requests/responses and seeds are retained beside the output tables.
"""
import argparse
import csv
import hashlib
import itertools
import json
import pathlib
import platform
import select
import subprocess
import time

SEEDS = list(range(1, 11))
MORPH_SEED = 20260912


class Client:
    def __init__(self, binary, out):
        self.log = (out / "mcp-transcript.jsonl").open("x")
        self.stderr = (out / "mcp-stderr.log").open("x")
        self.process = subprocess.Popen([str(binary)], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=self.stderr)
        self.serial = 0
        self.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                                "clientInfo": {"name": "dgw-convergence-pilot", "version": "1"}})
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def send(self, value):
        self.log.write(json.dumps({"request": value}) + "\n")
        self.log.flush()
        self.process.stdin.write((json.dumps(value) + "\n").encode())
        self.process.stdin.flush()

    def rpc(self, method, params):
        self.serial += 1
        request_id = self.serial
        self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if not select.select([self.process.stdout], [], [], 1)[0]:
                continue
            line = self.process.stdout.readline()
            if not line:
                raise RuntimeError("MCP server closed stdout; inspect mcp-stderr.log")
            response = json.loads(line)
            self.log.write(json.dumps({"response": response}) + "\n")
            self.log.flush()
            if response.get("id") != request_id:
                continue
            if "error" in response:
                raise RuntimeError(response)
            return response["result"]
        raise TimeoutError(method)

    def call(self, tool_name, **arguments):
        result = self.rpc("tools/call", {"name": tool_name, "arguments": arguments})
        if result.get("isError"):
            raise RuntimeError(f"{tool_name}: {result}")
        if "structuredContent" in result:
            return result["structuredContent"]
        return json.loads(next(c["text"] for c in result["content"] if c["type"] == "text"))

    def job(self, name, **arguments):
        job = self.call(name, **arguments)["job"]
        deadline = time.monotonic() + 600
        while job["status"] not in ("completed", "failed", "cancelled"):
            if time.monotonic() > deadline:
                raise TimeoutError(job)
            time.sleep(0.25)
            job = self.call("get_job", job_id=job["id"])["job"]
        if job["status"] != "completed":
            raise RuntimeError(job)
        return job

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=10)
        self.log.close()
        self.stderr.close()


def table(out, name, rows):
    with (out / name).open("x", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("project", type=pathlib.Path)
    parser.add_argument("output", type=pathlib.Path)
    parser.add_argument("--binary", type=pathlib.Path, default=pathlib.Path("target/release/dgw-mcp"))
    args = parser.parse_args()
    args.output.mkdir()  # Never overwrite a previous pilot.
    gene = json.loads((args.project.parent / "input-manifest.json").read_text())["gene"]["symbol"]
    metadata = {"seeds": SEEDS, "morphSeed": MORPH_SEED, "workerThreads": 2,
                "binarySha256": hashlib.sha256(args.binary.read_bytes()).hexdigest(),
                "platform": platform.platform(), "python": platform.python_version(),
                "gitCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()}
    (args.output / "settings.json").write_text(json.dumps(metadata, indent=2) + "\n")
    client = Client(args.binary.resolve(), args.output)
    try:
        client.call("open_project", project_path=str(args.project.resolve()))
        tracks = client.call("list_tracks")["tracks"]
        source = next(t for t in tracks if t["readOnly"])
        if len(tracks) > 2:
            raise RuntimeError("Use a newly created project, not an existing experiment")

        def duplicate(track, name):
            return client.call("duplicate_track", track_id=track["id"], name=name)["track"]

        def state(track):
            variants, offset = [], 0
            while True:
                page = client.call("list_variants", track_id=track["id"], offset=offset, limit=200)["page"]
                chunk = page["variants"]
                variants.extend(chunk)
                if len(chunk) < 200:
                    return variants
                offset += len(chunk)

        def optimizer(track):
            return client.job("start_genome_optimizer_preview", track_id=track["id"],
                              expected_head_state_id=track["headStateId"],
                              selection={"kind": "whole_track"}, mode="saturation", direction="minimize",
                              max_changes=1000, max_positions=1000, impact_weight=1, worker_threads=2)

        def apply(device, track, job):
            return client.call(f"apply_{device}_preview", track_id=track["id"],
                               expected_head_state_id=track["headStateId"], job_id=job["id"])["track"]

        def signature(variants):
            # Preserve exact alleles, dosage and phase; ignore generated provenance IDs.
            return sorted((v["key"]["contig"], v["key"]["position"], v["key"]["reference"],
                           v["key"]["alternate"], v["haplotype1Alt"], v["haplotype2Alt"],
                           v["unphasedAlt"], v.get("unphasedSlot")) for v in variants)

        original = state(source)
        results, rows, optimized = [], [], []
        for seed in SEEDS:
            track = duplicate(source, f"{gene} random seed {seed}")
            random_job = client.job("start_mutation_generator_preview", track_id=track["id"],
                                    expected_head_state_id=track["headStateId"], selection={"kind": "whole_track"},
                                    amount=100, seed=seed, substitution_pattern="uniform", max_positions=1000)
            track = apply("mutation_generator", track, random_job)
            random_state = state(track)
            candidate = duplicate(track, f"{gene} minimized seed {seed}")
            job = optimizer(candidate)
            candidate = apply("genome_optimizer", candidate, job)
            final_state = state(candidate)
            repeat = optimizer(candidate)
            assert repeat["result"]["changedPositions"] == 0, "second pass is not a fixed point"
            assert abs(repeat["result"]["scoreBefore"] - job["result"]["scoreAfter"]) < 1e-8
            p = job["result"]
            rows.append({"seed": seed, "selected_alleles": p["consideredPositions"],
                         "score_randomized": p["scoreBefore"], "score_minimized": p["scoreAfter"],
                         "positions_changed": p["changedPositions"], "excluded_positions": p["excludedPositions"],
                         "unchanged_or_tied": p["unchangedOrTiedPositions"],
                         "second_pass_changes": repeat["result"]["changedPositions"]})
            results.append({"seed": seed, "randomizer": random_job, "optimizer": job,
                            "repeat": repeat, "randomized": random_state, "minimized": final_state})
            optimized.append(candidate)
            print(json.dumps(rows[-1]), flush=True)

        morphs, morph_rows = [], []
        for amount in [0, 25, 50, 75, 100]:
            track = duplicate(optimized[0], f"{gene} morph 1 to 2 amount {amount}")
            target = optimized[1]
            extra = {"target_track_id": target["id"], "expected_target_head_state_id": target["headStateId"]}
            job = client.job("start_genome_morph_preview", track_id=track["id"],
                             expected_head_state_id=track["headStateId"], **extra,
                             amount=amount, seed=MORPH_SEED, ordering="seeded_random")
            track = client.call("apply_genome_morph_preview", track_id=track["id"],
                                expected_head_state_id=track["headStateId"], job_id=job["id"], **extra)["track"]
            variants = state(track)
            check = optimizer(track)  # Non-mutating score read plus fixed-point check.
            if amount == 100:
                assert signature(variants) == signature(results[1]["minimized"]), "Morph missed target"
            morphs.append({"amount": amount, "job": job, "scoreCheck": check, "variants": variants})
            morph_rows.append({"amount_percent": amount, "seed": MORPH_SEED,
                               "differing_positions": job["result"]["differingPositions"],
                               "copied_positions": job["result"]["selectedPositions"],
                               "score": check["result"]["scoreBefore"],
                               "remaining_improving_positions": check["result"]["changedPositions"]})
            print(json.dumps(morph_rows[-1]), flush=True)
        payload = {"original": original, "runs": results, "morphs": morphs}
        (args.output / "results.json").write_text(json.dumps(payload, indent=2) + "\n")
        table(args.output, "randomizer-optimizer.csv", rows)
        table(args.output, "morph.csv", morph_rows)
        diversity = {}
        for label in ["randomized", "minimized"]:
            states = [signature(r[label]) for r in results]
            assert all(len(s) == len(states[0]) for s in states)
            distances = [sum(a != b for a, b in zip(x, y)) for x, y in itertools.combinations(states, 2)]
            diversity[label] = {"unique_states": len({tuple(s) for s in states}),
                                "pairwise_differing_records": distances,
                                "mean_pairwise_differences": sum(distances) / len(distances)}
        (args.output / "diversity.json").write_text(json.dumps(diversity, indent=2) + "\n")
        print(json.dumps(diversity), flush=True)
    finally:
        client.close()


if __name__ == "__main__":
    main()
