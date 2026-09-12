## S7.1 Gene perturbation and candidate-correction pilot

### Input and resources

The pilot used the public 1000 Genomes HG00103 exome fixture, called as sample SRR1596639 against b37 (1000G-HG00103.SRR1596639.wes.b37.public.vcf.gz). BRCA2 was examined first; TTN was an exploratory follow-up after BRCA2 produced no improving edits. The selected SNV sets contained four positions and seven ALT copies for BRCA2, and 52 positions and 67 ALT copies for TTN. These are the positions represented in this exome VCF, not complete gene sequences or all possible mutation sites. Artificially randomized alleles are not findings about the donor.

Fresh gene projects were created through DGW core import, with exact PASS filtering, sample projection and reference-checked normalization as described in S2. Consequences were evaluated with bcftools 1.24 in local consequence mode, the hs37d5 reference and Ensembl GRCh37 release 87 GFF3. The configured ClinVar resource was clinvar_20250312.vcf.gz. COSMIC did not contribute. Input and resource SHA-256 values, resource paths, the MCP binary fingerprint and environment are retained in manuscript/pilot-results/. The run used two worker threads on the Linux ARM64 development VM; it was not a performance benchmark.

### Randomization and minimization

Seeds 1–10 were fixed before inspecting results and reused for both genes. For each seed, a new copy of the source track received Mutation Generator with amount=100, substitution_pattern=uniform and max_positions=1000. Each existing ALT was replaced by one of the two bases different from both REF and that ALT, retaining copy counts and phase state. This samples constrained perturbations of a fixed set of VCF positions, not random whole genomes.

The resulting track was evaluated by Genome Optimizer with selection=whole_track, mode=saturation, direction=minimize, impact_weight=1, max_positions=1000, max_changes=1000 and worker_threads=2. All three non-reference bases were compared at each selected SNV. Exact ClinVar Pathogenic/Likely pathogenic candidates were ineligible. Equal scores retained the current ALT; only strict improvements were applied. These bounds exceeded both gene selections and therefore did not truncate them. The pilot weight of 1 was explicit, rather than the interface default of 70.

The objective was S = Σₚ Σₕ I(vₚₕ), using the strongest predicted category per ALT copy and the S4 mapping: HIGH=1, MODERATE=0.67, LOW=0.33 and MODIFIER=0.10. REF was not a candidate in this saturation comparison. A second optimizer pass tested whether any further strictly improving edits remained. The MCP runner called the actual preview, apply and background-job operations; it did not implement a separate optimizer. Scores in the manuscript are optimizer totals, not Track Monitor source-relative deltas. Track Monitor profiling was not run in this pilot.

All ten BRCA2 runs scored 3.33 before and after minimization, with zero improving changes. TTN randomized scores ranged from 40.43 to 42.11 and all minimized scores were 34.69; 11–14 positions changed per run. All ten minimized TTN configurations remained distinct, and second passes proposed zero changes. These are ten seeded runs on one selected-sample gene dataset, not ten biological replicates. BRCA2 is retained as a negative result, and TTN is not presented as an independent confirmatory cohort.

### Morph comparison

For each gene, optimized seed 1 was designated the origin and optimized seed 2 the target before examining their differences. Genome Morph used ordering=seeded_random and seed=20260912. Amounts of 0, 25, 50, 75 and 100% each started from a fresh duplicate of the origin. They were not successive cumulative edits. This is one track-pair comparison with one run per amount; variability across morph seeds was not tested.

The TTN endpoints differed at 17 positions. Morph copied 0, 5, 9, 13 and 17 positions, respectively, while every intermediate scored 34.69. The 100% endpoint was checked against the target's effective alleles, copy counts and phase state. The fixed ordering produced nested subsets of copied positions. In this example the differing alleles were per-position score ties, so replacing subsets left the additive total unchanged. Equal endpoint scores alone would not guarantee this for other objectives or endpoints.

### Figure reconstruction and independent checks

Figure 2 was reconstructed by independently annotating all 156 non-reference candidate alleles at the 52 TTN positions with the same reference and predictor resources. The resulting per-allele scores reproduced all 20 archived randomized/minimized track totals within 10⁻⁸. Its 52-by-12 matrix shows directed substitutions, with colour encoding I(after) − I(before) per ALT copy. Numbers count actual choices across the ten runs, not selection probabilities. Blank scored cells mean zero choices; crossed cells involve REF and are outside the saturation comparison. Colours describe predicted consequences, not measured function or ClinVar eligibility. Exact annotations, counts and commands are archived with the 624-cell CSV.

Figure 3 uses the 17 differing TTN positions and the five archived morph states. All 85 displayed allele cells, copied-position counts, nested subsets and scores were checked against saved results. The other 35 positions remain in the total but are omitted from the display. Independently annotated seed-1 edits also retain transcript-level consequences, including predicted stop-gained to synonymous and stop-gained to missense changes. A lower category does not establish restored function.

### Reproduction and interpretation

The executable protocol is documented in manuscript/pilot-results/README.md. create_gene_pilot.rs bootstraps each fresh project; convergence_pilot.py runs the MCP experiment; archive_convergence.py retains results and provenance. The figure scripts read archived effective states, and draw_substitution_matrix.py reruns the candidate predictions. The archive includes fixed seeds, raw results, compressed MCP transcripts, CSV summaries, resource checksums and script/binary fingerprints. The recorded base git revision predates the pilot-script commit; historical fingerprints are retained rather than rewritten. Reproduction requires matching resources and fresh output directories. Compare effective allele states and scores with tolerance 10⁻⁸, not UUIDs, timestamps, polling counts or transcript bytes.

At the tested revision, bulk optimizer excludedPositions also counted positions tied for the best score. Raw excluded/unchanged counters must therefore not be interpreted as separate ClinVar-exclusion and tie counts. Manuscript tables use checked objective totals and actual changed-position counts. This reporting limitation does not alter the saved edits.

One-pass convergence is expected for the separable additive objective and fixed candidate sets used here. The pilot demonstrates reproducible device operations and candidate prioritization, not evolutionary speed, biological fitness, joint variant effects or functional rescue. Regulatory effects, epistasis and phase-dependent combined consequences were not modeled.
