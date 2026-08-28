# Device API and Resource Packs

DGW uses **device** as a general workstation concept, not only for tools that edit alleles.

| Device kind | Built-in example | Structured output |
| --- | --- | --- |
| Editing | Allele Randomizer, Genome Optimizer | Proposed normalized edit operations and planning details |
| Analysis | SnpEff | Predicted transcript consequences for one exact allele |
| Evidence | dbNSFP, ClinVar, COSMIC | Exact-match evidence records with explicit status |

Manual editing remains a host interaction rather than an external device. Its changes use the same immutable edit-operation model as proposals accepted from an editing device.

## VST-like is an analogy

The useful VST analogy is a rack of compatible, bypassable processors with visible parameters and recorded output. DGW does not load audio VST binaries, use a VST ABI, process audio buffers, or continuously mix nucleotide values.

Technical compatibility is defined by a versioned **DGW Device API** contract. Devices exchange structured genomic requests and results with the host. The API version—not similarity to a music plug-in—determines compatibility.

## Host-controlled contract

The Device API follows one rule: **a device never mutates a `.dgw` project directly**.

```text
DGW host
  │ structured request
  │ normalized allele/region, effective track input,
  │ parameters, resource descriptors and fingerprints
  ▼
device
  │ structured result
  │ proposed edits, analysis, evidence, warnings,
  │ score components and device provenance
  ▼
DGW host validates, previews, caches, and commits
```

An editing device returns proposals. DGW checks normalization, reference agreement, copy placement, overlap rules, source bounds, and edit limits before the user accepts or the host applies them. Accepted proposals become ordinary immutable `EditOperation` records.

Analysis and evidence devices return structured results and statuses. The host owns cache keys, project persistence, request cancellation, UI presentation, and export provenance. A device does not receive a writable SQLite connection or authority to rewrite project files.

The core now validates a language-neutral manifest and JSON request/response protocol at version `1.0`. A manifest declares:

- stable device ID and device version;
- a supported DGW Device API protocol version;
- device kind and declared input/output schemas;
- required resource types and compatible assemblies;
- scientific limitations; and
- declared execution and permission requirements.

Editing responses contain proposals, never project commands or paths. Analysis and evidence responses contain structured records and explicit states. External-process manifests are validated, including contained entrypoints and declared permissions, but DGW does not execute or install them yet.

## Device code and resource packs are different

A **device package** supplies behavior: for example, invoking SnpEff, planning bounded allele edits, or interpreting an indexed evidence row.

A **resource pack** supplies compatible data and tool resources: reference assembly files, a SnpEff model, or versioned dbNSFP, ClinVar, and COSMIC snapshots. It includes identity, release, checksums, assembly/contig contract, paths or installation references, and license information. A resource pack is not executable device code.

The current `ResourceBundle` is the first local resource-pack contract. It keeps code and large/licensed biological data outside `.dgw` projects while pinning a fingerprint in each project and evaluation cache entry.

Separating these concepts lets one device work with several compatible resource releases and lets a resource pack serve more than one device. It also avoids presenting a database update as a code plug-in update.

## Current implementation status

The built-in implementations already establish much of the contract shape:

- the Allele Randomizer and Genome Optimizer are non-mutating core planners; the Tauri host validates and applies returned proposals through normal track operations;
- SnpEff receives a structured exact-allele request through the evaluation service and returns parsed consequence fields;
- dbNSFP, ClinVar, and COSMIC adapters return structured exact-match evidence states; and
- the resource bundle identifies and fingerprints their local resources.

These are built into DGW and exposed through the same host catalog. The app validates versioned built-in and external manifest shapes, structured requests, structured responses, resource bindings, and editing proposals. There is not yet a community registry, install/update workflow, sandboxed external runner, or enabled third-party execution path. Device settings and full optimizer-run provenance also do not yet persist in the project schema.

SnpEff, dbNSFP, ClinVar, and COSMIC now appear as ordered rack cards on the selected track. Each can run independently for the selected allele. **Run all active devices** uses the cached combined evaluation when all four are enabled; bypassed devices are skipped and their output is excluded from the current evidence view. The Allele Randomizer targets selected VCF positions, while the Genome Optimizer targets the focused region; both appear only on editable tracks.

## Community-device path

External devices should be enabled only after the contract and trust boundary are testable:

1. Publish the implemented Device API v1 schemas, compatibility rules, conformance fixtures, and provenance requirements as a stable SDK.
2. Formalize resource-pack manifests independently of device packages.
3. Route every built-in execution through the protocol boundary used by external devices.
4. Define process isolation, resource access, permissions, cancellation, failure handling, and reproducibility for external code.
5. Add package discovery, installation, upgrades, and removal without granting direct project mutation.

Community devices and resource packs will retain their own software and data licenses. DGW must show those terms and cannot redistribute restricted resources such as COSMIC merely because a compatible evidence device exists.
