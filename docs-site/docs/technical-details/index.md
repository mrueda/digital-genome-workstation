# Technical Details

DGW separates the testable biological engine from its desktop shell.

| Area | Responsibility |
| --- | --- |
| `dgw-core` | VCF validation, project persistence, immutable state provenance, effective genome tracks, reference reconstruction, evaluation, cache, and render |
| `dgw-desktop` | Narrow Tauri commands and lifecycle for long-lived evaluation workers |
| React UI | Genome tracks, device racks, persistent edit blocks, focused interaction, evidence presentation, and native dialogs |
| Device layer | Structured editing, analysis, and evidence contracts; built-in devices today, versioned external API later |
| External stack | bcftools/HTSlib 1.24, Ensembl GFF3, bgzip/tabix, registered references, ClinVar and COSMIC |

Start with [Architecture](architecture.md), then review the [Device API and Resource Packs](device-api.md), [Track, State, and Edit Model](state-model.md), [Evaluation Engine](evaluation-engine.md), and [Scoring and Evidence Methods](scoring-methods.md).
