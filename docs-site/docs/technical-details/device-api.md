# Device API and Resource Packs

DGW uses **device** as a general workstation concept, not only for tools that edit alleles.

| Device kind | Built-in example | Structured output |
| --- | --- | --- |
| Editing | Mutation Generator, Genome Morph, Genome Optimizer | Proposed normalized edit operations and planning details |
| Evidence | Consequence Predictor | Predicted transcript consequences for one exact allele |
| Evidence | ClinVar, COSMIC | Exact-match database records with explicit status |
| Visualization | Track Compare | Read-only presentation of focused track state and available model results |

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

A **device package** supplies behavior: for example, invoking a consequence engine, planning bounded allele edits, or interpreting an indexed evidence row.

A **resource pack** supplies compatible data and tool resources: reference assembly files, an Ensembl GFF3 release, or versioned ClinVar and COSMIC snapshots. It includes identity, release, checksums, assembly/contig contract, paths or installation references, and license information. A resource pack is not executable device code.

The current `ResourceBundle` is the first local resource-pack contract. It keeps code and large/licensed biological data outside `.dgw` projects while pinning a fingerprint in each project and evaluation cache entry.

Separating these concepts lets one device work with several compatible resource releases and lets a resource pack serve more than one device. It also avoids presenting a database update as a code plug-in update.

## Current implementation status

The built-in implementations already establish much of the contract shape:

- the Mutation Generator, Genome Morph, and Genome Optimizer are non-mutating core planners; the Tauri host validates and applies returned proposals through normal track operations;
- Consequence Predictor batches structured exact-allele requests through `bcftools csq --local-csq` and returns parsed consequence fields;
- ClinVar and COSMIC adapters return structured exact-match evidence states; and
- Track Compare reads bounded focused-track marks and session Track Monitor results without changing the track or an objective; and
- the resource bundle identifies and fingerprints their local resources.

These are built into DGW and exposed through the same host catalog. The app validates versioned built-in and external manifest shapes, structured requests, structured responses, resource bindings, and editing proposals. There is not yet a community registry, install/update workflow, sandboxed external runner, or enabled third-party execution path. Device settings persist in the workstation session; terminal runs have separate immutable records. Background Mutation Generator, Genome Morph, and Genome Optimizer jobs persist request/result envelopes and progress without creating duplicate bulk devices.

Consequence Predictor, ClinVar, and COSMIC can be applied as ordered rack cards on the selected track. Each optional resource-backed card can run independently for the selected allele. Selection automatically requests missing active-device results and shows stable cached results first; unapplied, bypassed, or unavailable devices are excluded from the current evidence view. **Track Profiler** is host orchestration over that same allele-level API. Ordinary blocks and compound layers use the same persistent aggregate background job with batched consequence prediction and database adapters. A fingerprint of active mutations, devices, and resources permits safe reuse across unchanged duplicates; stale or missing selected-track profiles start automatically. The profiler is not yet a separately installable device or a joint-effect protocol. Mutation Generator and both Genome Optimizer modes target explicit selected VCF positions; Saturation requires active Consequence Predictor and host-evaluates three non-REF candidates per canonical SNV. Both devices are available only to editable tracks and must be applied explicitly. Randomizer is currently the Mutation Generator's only mode; its request includes amount, seed, substitution pattern, and transition probability, and its plan reports transition/transversion counts plus explicit exclusions.

The Device Browser groups available devices by function: **Edit**, **Evidence**, **Analyze**, and **Visualize**. Mutation Generator and Genome Morph are Edit; Consequence Predictor, ClinVar, and COSMIC are Evidence; Genome Optimizer is Analyze; and Track Compare is Visualize. There is no separate Score group because the objective-driven operation is an analysis. A visualization reads bounded host state and existing device results but contributes no score and proposes no edits. The per-track Device Rack is different: it contains only applied device instances in order. Group membership is presentation metadata, not an implied biological pipeline, audio-style signal chain, or replacement for the lower-level protocol capability declared by a manifest.

The file-level DGW Starter project template applies Mutation Generator, Genome Morph, all three Evidence devices, Genome Optimizer, and Track Compare in functional order; the Empty project template applies none. Neither is a Device Browser action. Applied Edit and Analyze devices remain inert until their explicit Preview/Apply or Run action, while Track Compare is read-only. Duplicating a track copies its applied device IDs and session bypass state. The workstation session stores applied chains and device controls within the existing project schema.

Scoring has two independent control axes:

- the selected objective explicitly includes or excludes named device outputs; and
- the user can activate or bypass an installed device.

An included, applied, active device contributes according to its configured weight. An included device that is bypassed or not applied has effective weight `0`, but DGW retains its source data and configured weight and distinguishes **Bypassed** from **Not in rack**. An excluded device can still run and display results when applied. Unknown and newly installed devices default to unapplied and excluded from existing objectives, so installation cannot silently change a score. Unavailable and failed devices remain distinguishable from deliberate bypass. Current controls persist in the workstation session; terminal runs retain their declared execution inputs independently.

## Community-device path

External devices should be enabled only after the contract and trust boundary are testable:

1. Publish the implemented Device API v1 schemas, compatibility rules, conformance fixtures, and provenance requirements as a stable SDK.
2. Formalize resource-pack manifests independently of device packages.
3. Route every built-in execution through the protocol boundary used by external devices.
4. Define process isolation, resource access, permissions, cancellation, failure handling, and reproducibility for external code.
5. Add package discovery, installation, upgrades, and removal without granting direct project mutation.

Community devices and resource packs will retain their own software and data licenses. DGW must show those terms and cannot redistribute restricted resources such as COSMIC merely because a compatible evidence device exists.
