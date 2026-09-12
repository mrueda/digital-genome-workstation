# Scoring and Evidence Methods

This page describes the calculations used by DGW. It is also the basis for the Supporting Information of a future manuscript. The implementation may change, so results should record the DGW version and resource versions.

## Exact allele evaluation

DGW identifies an allele by assembly, chromosome, 1-based position, REF, and ALT:

$$
v = (g, c, p, r, a)
$$

The input VCF is normalized during import. Imported INFO annotations are ignored. DGW sends each current or proposed allele to the configured Evidence devices. This allows DGW to evaluate an ALT that was not present in the input VCF.

Each allele is evaluated separately. DGW does not combine nearby edits into one transcript or protein sequence for scoring.

## Variant Consequences

DGW runs `bcftools csq --local-csq` against the project's reference FASTA and assembly-matched Ensembl GFF3. `--local-csq` evaluates each VCF record independently. The engine returns one or more `BCSQ` records with these fields:

| Field | Meaning |
| --- | --- |
| `effect` | One or more bcftools consequence terms, such as `missense` |
| `geneName` | Affected gene |
| `featureId` | Transcript identifier |
| `transcriptBiotype` | Transcript biotype |
| `strand` | Transcript strand |
| `aminoAcidChange`, `dnaChange` | bcftools amino-acid and DNA change descriptions |
| `engine`, `engineVersion`, `annotationRelease` | Runtime provenance |
| `impact` | DGW category derived from the strongest returned consequence term |

The allele inspector can display these fields. The current numerical model uses only `impact`.

### Impact value

DGW maps consequence terms to four categories. HIGH contains transcript ablation/amplification, splice acceptor/donor, stop gained/lost, start lost, and frameshift. MODERATE contains missense, in-frame insertion/deletion, and protein-altering consequences. LOW contains splice-region, incomplete-terminal-codon, start/stop-retained, and synonymous consequences. Other reported transcript terms map to MODIFIER.

When `csq` reports no overlapping transcript feature, DGW creates an explicit `no_transcript_feature` MODIFIER record. This keeps all three candidate bases comparable without claiming that a database contained the allele. The four categories map to a number:

$$
I(x) =
\begin{cases}
1.00 & x = \mathrm{HIGH} \\
0.67 & x = \mathrm{MODERATE} \\
0.33 & x = \mathrm{LOW} \\
0.10 & x = \mathrm{MODIFIER}
\end{cases}
$$

An allele can affect several transcripts. DGW uses the largest value among all returned `BCSQ` records:

$$
I(v) = \max_{t \in T(v)} I\!\left(\operatorname{impact}(v,t)\right)
$$

Here, $T(v)$ is the set of bcftools transcript consequences returned for allele $v$. This is a worst-category transcript rule. It does not select a canonical transcript and does not average across transcripts.

If the consequence engine fails or returns an unrecognized impact category, the allele has no comparable score. It is not assigned zero.

## Saturation Scan

For a selected SNV position $p$, Saturation Scan evaluates the three A/C/G/T bases that differ from REF. One of these is the current ALT. For each candidate allele $v_{p,a}$, the current score is:

$$
s(v_{p,a}) = w_I I(v_{p,a})
$$

$w_I$ is the Impact control in Genome Optimizer. Its default interface value is 70. This factor changes the displayed model units but not the ordering of candidates.

Minimize chooses the eligible candidate with the lowest score. Maximize chooses the eligible candidate with the highest score:

$$
a_p^* =
\begin{cases}
\displaystyle\arg\min_{a \in E_p} s(v_{p,a}) & \text{Minimize} \\
\displaystyle\arg\max_{a \in E_p} s(v_{p,a}) & \text{Maximize}
\end{cases}
$$

$E_p$ is the set of eligible candidates at position $p$. The current ALT wins a tie. DGW proposes a change only when another ALT has a strictly better score in the requested direction.

A position is excluded when any of its three candidate ALTs lacks a recognized consequence impact category. This avoids comparing a complete result with missing data.

### ClinVar guard

ClinVar is not part of the numerical score. A candidate with an exact ClinVar classification of `Pathogenic` or `Likely pathogenic` is excluded from selection. A missing ClinVar record means unknown, not benign, and does not lower the score.

The fixed guard currently applies in both directions. The audit reports exclusions separately from ties and unchanged positions.

### Score for a selection

For selected positions $P$, the displayed score is the sum over active allele copies:

$$
S = \sum_{p \in P}\sum_{h \in H_p} s(v_{p,h})
$$

$H_p$ contains the active chromosome-copy placements at position $p$. A heterozygous ALT normally contributes once and a homozygous ALT twice. When a position changes, all active ALT copies at that position change together.

The change reported by the optimizer is:

$$
\Delta S = S_{\mathrm{after}} - S_{\mathrm{before}}
$$

A negative value is lower under Minimize. A positive value is higher under Maximize. The value is an additive model output. It is not a probability, clinical risk, fitness, or disease burden.

## Track Monitor

Track Monitor compares the current track with its source alleles. For each evaluated mutation $m$:

$$
\Delta I_m = I(v_m^{\mathrm{current}}) - I(v_m^{\mathrm{source}})
$$

For a reference restoration, the current variant contribution is zero because no ALT consequence remains at that position. This is a source-relative convention. It does not mean that the reference genome is biologically optimal or free of harmful alleles.

The track total is:

$$
\Delta I_{\mathrm{track}} = \sum_{m \in M} \Delta I_m
$$

The normalized display is the mean per active mutation:

$$
\overline{\Delta I} = \frac{\Delta I_{\mathrm{track}}}{|M|}
$$

These values are shown only when the required Variant Consequences evaluations are complete. Bypassed mutation blocks and a bypassed Variant Consequences device do not contribute.

The optimizer score and Track Monitor use the same consequence category mapping but different scales. Genome Optimizer applies $w_I$; Track Monitor reports the unweighted source-relative change.

## Evidence not used in the score

The following fields do not currently change the Saturation score:

- Variant Consequences effect, gene, transcript, biotype, and change descriptions;
- COSMIC records;
- ClinVar classifications, except for the fixed exclusion described above;
- INFO annotations from the imported VCF.

ClinVar and COSMIC remain available as evidence. Absence from these databases never reduces the score.

## Consequences of the current model

The model has only four consequence levels. Two different alleles often receive the same value. For example, two `MODERATE` missense variants both score 0.67 even if their amino-acid changes differ. This explains why a scan of thousands of positions may propose only a small number of changes.

The model also assumes that allele contributions can be added. It does not model:

- interactions between variants;
- combined effects on one transcript or protein;
- phase-dependent compound effects;
- penetrance, environment, ancestry, or phenotype;
- variants outside the selected VCF positions;
- biological viability or evolutionary fitness.

## Planned refinement

A later scoring version may keep consequence impact as the main tier and use specific consequence terms to separate candidates within a tier. This is not part of the current calculation. Any such change must use a new scoring-method version and preserve the old definition for reproducibility.

## Minimum information to report

A result should include:

- DGW software version and scoring-method version;
- reference assembly and normalized input identity;
- bcftools version, Ensembl GFF3 release, and resource fingerprint;
- ClinVar release and resource fingerprint;
- selected positions and chromosome-copy placements;
- direction, impact weight, and maximum changes;
- candidates evaluated, exclusions, ties, proposed changes, $S_{\mathrm{before}}$, $S_{\mathrm{after}}$, and $\Delta S$;
- the limitations listed above.

Terminal device runs now have immutable records for their declared inputs, resource context, request, result summary, and output edit IDs or staged layer ID. The workstation session separately restores current controls and displayed plans. Bulk results retain aggregate counts and scores rather than every candidate comparison row, so the run ledger is not a complete candidate table.
