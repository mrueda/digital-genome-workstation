import { useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api } from "./api";
import { ApplicationMenu, SettingsDialog } from "./ApplicationChrome";
import {
  TrackDeviceWorkspace,
  type AlleleRandomizerDevice,
  type AlleleRandomizerSettings,
  type GenomeOptimizerDevice,
  type GenomeOptimizerSettings,
  type GenomeTrackEditBlock,
  type GenomeTrackModel,
  type OptimizerObjective,
  type OptimizerWeightControl,
  type RackDeviceView,
  type TrackMeterModel
} from "./TrackDeviceWorkspace";
import type {
  DeviceManifest,
  EditKind,
  EffectiveVariant,
  EvaluationResult,
  EvidenceResult,
  FocusContext,
  FocusView,
  GenomeTrack,
  GenomeTrackLane,
  Haplotype,
  OptimizerRequest,
  ProjectSnapshot,
  RandomizerPlan,
  RandomizerRequest,
  ResourceBundle,
  VcfInspection,
  WorkspaceSnapshot
} from "./types";
import { filterSamples, haplotypeLabel, parentDirectory, projectSlug, sequenceChunks, sequenceDisplayParts, shortId, variantLabel, variantPhaseLabel } from "./utils";
import { snpeffImpactSignal } from "./trackMeter";
import {
  DEFAULT_USER_SETTINGS,
  USER_SETTINGS_STORAGE_KEY,
  parseUserSettings,
  type UserSettings
} from "./userSettings";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const optimizerObjectives: OptimizerObjective[] = [
  {
    id: "alternateAlleleBurden",
    label: "Alternate-allele burden",
    description: "Counts selected-sample alternate alleles in this focused region. This is a technical score, not a health prediction."
  },
  {
    id: "predictedImpactBurden",
    label: "Predicted-impact burden",
    description: "Adds independent per-allele impact and source-evidence weights. It does not calculate a combined biological effect."
  }
];

const optimizerWeights: OptimizerWeightControl[] = [
  { id: "impact", label: "Impact", description: "Weight of the imported ANN impact category.", min: 0, max: 100, step: 5 },
  { id: "clinvar", label: "ClinVar", description: "Weight of ClinVar-like source annotations when present.", min: 0, max: 100, step: 5 },
  { id: "sourceEvidence", label: "Source", description: "Weight for retaining the original sample allele evidence.", min: 0, max: 100, step: 5 }
];

const DEVICE_IDS = {
  snpeff: "org.dgw.builtin.snpeff",
  dbnsfp: "org.dgw.builtin.dbnsfp",
  clinvar: "org.dgw.builtin.clinvar",
  cosmic: "org.dgw.builtin.cosmic",
  randomizer: "org.dgw.builtin.allele-randomizer",
  optimizer: "org.dgw.builtin.genome-optimizer"
} as const;

function alleleId(variant: EffectiveVariant) {
  const key = variant.key;
  return `${key.assembly}:${key.contig}:${key.position}:${key.reference}:${key.alternate}`;
}

const alleleDeviceIds = [DEVICE_IDS.snpeff, DEVICE_IDS.dbnsfp, DEVICE_IDS.clinvar, DEVICE_IDS.cosmic];

type DeviceEvidenceMap = Record<string, EvidenceResult>;

interface MeterEditEvaluation {
  sourceEvidence: DeviceEvidenceMap;
  currentEvidence: DeviceEvidenceMap;
  currentIsReference: boolean;
  evaluatedDeviceIds: string[];
}

type ExportKind = "trackVcf" | "focusFasta";

interface ExportRequest {
  id: number;
  kind: ExportKind;
}

function sameVariant(left: EffectiveVariant["key"], right: EffectiveVariant["key"]) {
  return left.assembly === right.assembly
    && left.contig === right.contig
    && left.position === right.position
    && left.reference === right.reference
    && left.alternate === right.alternate;
}

function evidenceSummary(evidence?: EvidenceResult) {
  if (!evidence) return "Not run for this allele";
  if (evidence.status === "found") {
    return `${evidence.records.length.toLocaleString()} exact ${evidence.records.length === 1 ? "result" : "results"}`;
  }
  if (evidence.status === "noExactMatch") return "No exact normalized allele match";
  return evidence.message ?? evidence.status.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
}

function evaluationEvidence(result: EvaluationResult): DeviceEvidenceMap {
  return {
    [DEVICE_IDS.snpeff]: result.snpeff,
    [DEVICE_IDS.dbnsfp]: result.dbnsfp,
    [DEVICE_IDS.clinvar]: result.clinvar,
    [DEVICE_IDS.cosmic]: result.cosmic
  };
}

function defaultOptimizer(trackId: string): GenomeOptimizerDevice {
  return {
    id: DEVICE_IDS.optimizer,
    name: "Genome Optimizer",
    bypassed: false,
    status: "ready",
    settings: {
      objectiveId: "alternateAlleleBurden",
      direction: "minimize",
      weights: { impact: 70, clinvar: 60, sourceEvidence: 20 },
      maxEdits: 5
    },
    message: "Bounded to discrete alleles already present in the selected sample.",
    rackOrder: 50,
    target: "focusedRegion",
    resource: "Selected sample and frozen source annotations",
    limitation: "Nearby allele scores remain independent; this device does not infer a combined biological effect."
  };
}

function defaultRandomizer(): AlleleRandomizerDevice {
  return {
    id: DEVICE_IDS.randomizer,
    name: "Allele Randomizer",
    bypassed: false,
    status: "ready",
    settings: { amount: 100, seed: 42 },
    message: "Select visible VCF alleles, preview the changes, then apply them as reversible blocks.",
    rackOrder: 5,
    limitation: "Randomization is not a biological prediction. Version 1 changes canonical SNVs only and each result must be evaluated independently."
  };
}

function editBlock(lane: GenomeTrackLane, editId: string): GenomeTrackEditBlock | undefined {
  const operation = lane.edits.find((candidate) => candidate.id === editId);
  if (!operation) return undefined;
  const source = operation.edit.kind === "restoreReference" ? operation.edit.sourceKey : operation.edit.key;
  const reference = operation.edit.kind === "restoreReference" ? source.alternate : source.reference;
  const alternate = operation.edit.kind === "restoreReference" ? source.reference : source.alternate;
  return {
    id: operation.id,
    position: source.position,
    reference,
    alternate,
    enabled: !lane.track.bypassedEditIds.includes(operation.id),
    copy: operation.haplotype === "unphased" ? "unknown" : operation.haplotype,
    label: `${reference}→${alternate}`,
    consequence: operation.note
  };
}

function variantForTrackEdit(lane: GenomeTrackLane, editId: string): EffectiveVariant | undefined {
  const effective = lane.variants.find((item) => item.editIds.includes(editId));
  if (effective) return effective;
  const operation = lane.edits.find((item) => item.id === editId);
  if (!operation) return undefined;
  const key = operation.edit.kind === "restoreReference" ? operation.edit.sourceKey : operation.edit.key;
  return {
    key,
    haplotype1Alt: operation.haplotype === "one",
    haplotype2Alt: operation.haplotype === "two",
    unphasedAlt: operation.haplotype === "unphased",
    origin: "edited",
    editIds: [editId],
    sourceInfo: {}
  };
}

function Onboarding({ onOpened }: { onOpened: (path: string, snapshot: ProjectSnapshot) => void }) {
  const [bundle, setBundle] = useState<ResourceBundle>();
  const [bundleText, setBundleText] = useState("");
  const [inspection, setInspection] = useState<VcfInspection>();
  const [sourcePath, setSourcePath] = useState("");
  const [sample, setSample] = useState("");
  const [sampleSearch, setSampleSearch] = useState("");
  const [name, setName] = useState("Genome project");
  const [projectPath, setProjectPath] = useState("");
  const [status, setStatus] = useState("Loading the resource configuration…");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [inputWarnings, setInputWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.suggestedBundle()
      .then((value) => {
        setBundle(value);
        setBundleText(JSON.stringify(value, null, 2));
        setStatus("Register the existing b37 annotation stack, then choose a VCF.");
      })
      .catch((error) => setStatus(`DGW must run inside the Tauri desktop shell: ${messageOf(error)}`));
  }, []);

  const filteredSamples = useMemo(() => {
    return filterSamples(inspection?.samples ?? [], sampleSearch);
  }, [inspection, sampleSearch]);

  async function validateResources() {
    setBusy(true);
    try {
      const parsed = JSON.parse(bundleText) as ResourceBundle;
      const resourceWarnings = await api.validateBundle(parsed);
      setBundle(parsed);
      setWarnings(resourceWarnings);
      setStatus(resourceWarnings.length ? "Bundle works, with warnings." : "Resource bundle is ready.");
    } catch (error) {
      setStatus(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function chooseVcf() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Variant Call Format", extensions: ["vcf", "gz"] }]
    });
    if (typeof selected !== "string") return;
    setBusy(true);
    setStatus("Inspecting VCF header and records…");
    try {
      await inspectSelectedVcf(selected);
    } catch (error) {
      setStatus(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function inspectSelectedVcf(
    selected: string,
    options?: { preferredSample?: string; projectName?: string; projectPath?: string; example?: boolean }
  ) {
    const result = await api.inspectVcf(selected);
    const selectedSample = options?.preferredSample && result.samples.includes(options.preferredSample)
      ? options.preferredSample
      : result.samples[0] ?? "";
    const nextName = options?.projectName ?? name;

    setSourcePath(selected);
    setInspection(result);
    setSample(selectedSample);
    setSampleSearch("");
    setName(nextName);
    setProjectPath(options?.projectPath ?? `${parentDirectory(selected)}/${projectSlug(nextName)}.dgw`);
    const nextInputWarnings = [];
    if (!result.biallelic) {
      nextInputWarnings.push("This VCF contains multiallelic records. Split and normalize them before creating a DGW project.");
    }
    if (result.skippedUnsupportedRecordCount > 0) {
      nextInputWarnings.push(
        `${result.skippedUnsupportedRecordCount.toLocaleString()} symbolic, CNV, MNV, or large-allele ${result.skippedUnsupportedRecordCount === 1 ? "record" : "records"} will be skipped. DGW v0.1 imports only sequence-resolved SNVs and 1–49 bp indels.`
      );
    }
    setInputWarnings(nextInputWarnings);
    setStatus(
      `${options?.example ? "Example ready · " : ""}${result.supportedRecordCount.toLocaleString()} supported small-variant records of ${result.recordCount.toLocaleString()} total · ${result.samples.length.toLocaleString()} ${result.samples.length === 1 ? "sample" : "samples"} · ${result.hasAnn ? "ANN present" : "ANN missing"}`
    );
  }

  async function loadExample() {
    setBusy(true);
    setStatus("Loading the synthetic clustered-variant example…");
    try {
      const example = await api.exampleFixture();
      await inspectSelectedVcf(example.path, {
        preferredSample: example.sample,
        projectName: example.projectName,
        projectPath: example.projectPath,
        example: true
      });
    } catch (error) {
      setStatus(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function chooseProjectParent() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") {
      setProjectPath(`${selected}/${projectSlug(name)}.dgw`);
    }
  }

  async function create() {
    if (!bundle || !sourcePath || !sample || !projectPath) return;
    setBusy(true);
    setStatus("Fingerprinting the VCF and freezing the selected sample…");
    try {
      const snapshot = await api.createProject({
        projectPath,
        name,
        sourceVcfPath: sourcePath,
        selectedSample: sample,
        resourceBundle: bundle
      });
      onOpened(projectPath, snapshot);
    } catch (error) {
      setStatus(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function openExisting() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    setBusy(true);
    try {
      onOpened(selected, await api.openProject(selected));
    } catch (error) {
      setStatus(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="onboarding-shell">
      <section className="brand-panel">
        <div className="brand-mark"><img src="/dgw-logo.png" alt="Digital Genome Workstation" /></div>
        <p className="eyebrow">Digital Genome Workstation</p>
        <h1>Build and compare editable genome tracks.</h1>
        <p className="lede">
          Load one person from a VCF, duplicate the source genome into independent tracks, and test allele changes
          without changing the original sample. Each change stays visible until you bypass or consolidate it.
        </p>
        <div className="workspace-map" aria-label="DGW workspace areas">
          <span><b>Variants</b><small>choose an allele</small></span>
          <span><b>Tracks</b><small>duplicate genome scenarios</small></span>
          <span><b>Edit blocks</b><small>keep changes visible</small></span>
          <span><b>Devices</b><small>generate bounded candidates</small></span>
          <span><b>Sequence</b><small>inspect REF and both copies</small></span>
          <span><b>Evidence</b><small>assess one allele at a time</small></span>
        </div>
      </section>

      <section className="setup-panel">
        <div className="setup-heading">
          <div><p className="eyebrow">Start a project</p><h2>Load a genome</h2></div>
          <button className="button ghost" onClick={openExisting} disabled={busy}>Open .dgw</button>
        </div>

        <details className="resource-editor">
          <summary><span>Resource bundle</span><small>{bundle?.id ?? "not loaded"}</small></summary>
          <textarea value={bundleText} onChange={(event) => setBundleText(event.target.value)} spellCheck={false} />
          <button className="button secondary" onClick={validateResources} disabled={busy || !bundleText}>Validate paths</button>
        </details>

        <div className="setup-step">
          <span className="step-number">1</span>
          <div className="grow">
            <label>Annotated VCF with biallelic SNVs/indels</label>
            <div className="file-choice-row">
              <button className="file-picker" onClick={chooseVcf} disabled={busy}>
                <span>{sourcePath || "Choose .vcf or .vcf.gz"}</span><b>Browse</b>
              </button>
              <button className="button secondary load-example" onClick={loadExample} disabled={busy}>Load example</button>
            </div>
            <small className="fixture-note">7 nearby synthetic variants · fictional sample DGW_DEMO</small>
          </div>
        </div>

        {inspection && (
          <div className="setup-step">
            <span className="step-number">2</span>
            <div className="grow">
              <label>Selected genome</label>
              <input placeholder="Filter samples" value={sampleSearch} onChange={(event) => setSampleSearch(event.target.value)} />
              <select value={sample} onChange={(event) => setSample(event.target.value)} size={Math.min(6, Math.max(2, filteredSamples.length))}>
                {filteredSamples.map((item) => <option key={item}>{item}</option>)}
              </select>
            </div>
          </div>
        )}

        <div className="setup-step">
          <span className="step-number">3</span>
          <div className="grow two-column">
            <label>Project name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label>Project package
              <span className="input-with-action"><input value={projectPath} onChange={(event) => setProjectPath(event.target.value)} /><button onClick={chooseProjectParent}>…</button></span>
            </label>
          </div>
        </div>

        <div className="status-line"><span className={busy ? "pulse" : "status-dot"} />{status}</div>
        {inputWarnings.map((warning) => <p className="warning" key={warning}>{warning}</p>)}
        {warnings.map((warning) => <p className="warning" key={warning}>{warning}</p>)}
        <button className="button primary wide" onClick={create} disabled={busy || !bundle || !inspection || !inspection.biallelic || inspection.supportedRecordCount === 0 || !sample || !projectPath}>
          {busy ? "Working…" : "Open genome workspace"}
        </button>
      </section>
    </main>
  );
}

function SequenceRow({
  label,
  sequence,
  tone,
  context,
  variants,
  track,
  selected
}: {
  label: string;
  sequence?: string;
  tone: string;
  context: FocusContext;
  variants: EffectiveVariant[];
  track: "reference" | "one" | "two";
  selected?: EffectiveVariant;
}) {
  const parts = sequenceDisplayParts(sequence, context.start, context.end, variants, track, selected?.key);
  return (
    <div className="sequence-row">
      <span className={`sequence-label ${tone}`} title={track === "reference" ? "Forward-strand reference, 5′ to 3′" : "One homologous chromosome; parental origin is unknown"}>{label}</span>
      <code>{parts.flatMap((part, partIndex) => sequenceChunks(part.text).map((chunk, chunkIndex) => (
        <span key={`${partIndex}-${chunkIndex}`} className={`sequence-fragment ${part.role}${part.selected ? " selected" : ""}`}>{chunk}</span>
      )))}</code>
    </div>
  );
}

function VariantChangeLens({
  variant,
  referenceSequence,
  context,
  snpeffEvidence
}: {
  variant?: EffectiveVariant;
  referenceSequence?: string;
  context: FocusContext;
  snpeffEvidence?: EvidenceResult;
}) {
  if (!variant) {
    return <div className="change-lens empty"><span>Select a variant to see its base-level change.</span></div>;
  }

  const offset = variant.key.position - context.start;
  const left = referenceSequence?.slice(Math.max(0, offset - 9), Math.max(0, offset)) ?? "";
  const rightStart = Math.max(0, offset + variant.key.reference.length);
  const right = referenceSequence?.slice(rightStart, rightStart + 9) ?? "";
  const kind = variant.key.reference.length === variant.key.alternate.length
    ? variant.key.reference.length === 1 ? "SNV" : "substitution"
    : variant.key.reference.length < variant.key.alternate.length ? "insertion" : "deletion";
  const evaluatedRows = snpeffEvidence?.records ?? [];
  const importedRows = (variant.sourceInfo.ANN?.split(",") ?? []).map((annotation) => {
    const fields = annotation.split("|");
    return { effect: fields[1], geneName: fields[3], hgvsC: fields[9], hgvsP: fields[10] };
  });
  const usesCurrentEvaluation = evaluatedRows.length > 0;
  const annotationRows = usesCurrentEvaluation ? evaluatedRows : importedRows;
  const unique = (key: "effect" | "geneName" | "hgvsP") => [
    ...new Set(annotationRows.map((record) => record[key]).filter(Boolean))
  ];
  const consequence = unique("effect").join(" + ");
  const consequenceDetails = [
    unique("geneName").join(" / "),
    unique("hgvsP").slice(0, 3).join(" / "),
    annotationRows.length > 1 ? `${annotationRows.length} transcripts` : ""
  ].filter(Boolean);

  return (
    <div className="change-lens">
      <div className="change-lens-heading">
        <span>Selected change</span>
        <small>{variant.key.contig}:{variant.key.position.toLocaleString()} · {kind} · {variantPhaseLabel(variant)}</small>
      </div>
      <div className="allele-comparison">
        <div><label>Reference</label><code><span>{left}</span><mark className="before">{variant.key.reference}</mark><span>{right}</span></code></div>
        <span className="change-arrow">→</span>
        <div><label>This version</label><code><span>{left}</span><mark className="after">{variant.key.alternate}</mark><span>{right}</span></code></div>
      </div>
      <div className="consequence-preview">
        <span>{usesCurrentEvaluation ? "Current prediction" : importedRows.length > 0 ? "Input annotation" : "Predicted consequence"}</span>
        <b>{consequence || "Not evaluated yet"}</b>
        {consequenceDetails.length > 0 && <small>{consequenceDetails.join(" · ")}</small>}
      </div>
    </div>
  );
}

function EvidenceCard({ evidence }: { evidence: EvidenceResult }) {
  const important = evidence.records[0];
  const highlights = important
    ? ["effect", "impact", "geneName", "featureId", "hgvsC", "hgvsP", "CADD_phred", "REVEL_score", "SIFT_score", "Polyphen2_HDIV_score", "CLNSIG", "CLNREVSTAT", "GENEINFO", "ONC", "SCI", "id", "CNT"]
        .flatMap((key) => important[key] ? [[key, important[key]] as const] : [])
    : [];
  return (
    <article className="evidence-card">
      <header><h4>{evidence.source}</h4><span className={`status ${evidence.status}`}>{evidence.status.replace(/[A-Z]/g, (value) => ` ${value.toLowerCase()}`)}</span></header>
      {evidence.message && <p className="warning">{evidence.message}</p>}
      {highlights.length > 0 && <dl>{highlights.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>}
      {important?.raw && <details><summary>Raw matched record</summary><code className="raw-record">{important.raw}</code></details>}
      {evidence.status === "noExactMatch" && <p className="muted">No exact normalized allele was found. This is not evidence of benignity.</p>}
    </article>
  );
}

function EditPanel({
  variant,
  onApply,
  busy,
  editable,
  trackName,
  onDuplicateProtectedTrack
}: {
  variant?: EffectiveVariant;
  onApply: (haplotype: Haplotype, edit: EditKind, note: string) => Promise<void>;
  busy: boolean;
  editable: boolean;
  trackName: string;
  onDuplicateProtectedTrack?: () => void;
}) {
  const [mode, setMode] = useState<"restore" | "replace">("replace");
  const [haplotype, setHaplotype] = useState<Haplotype>("two");
  const [alternate, setAlternate] = useState("T");
  const [note, setNote] = useState("");
  const [saveFeedback, setSaveFeedback] = useState<{ tone: "working" | "saved" | "error"; message: string }>();
  const normalizedAlternate = alternate.trim().toUpperCase();
  const alternateIsValid = /^[ACGTN]+$/.test(normalizedAlternate);
  const alternateIsChanged = Boolean(variant && normalizedAlternate !== variant.key.alternate);
  const alternateIsReference = Boolean(variant && normalizedAlternate === variant.key.reference);
  const placementOptions: Array<{ value: Haplotype; label: string }> = variant?.unphasedAlt
    ? [{ value: "unphased", label: "Chromosome copy unknown (unphased 0/1)" }]
    : [
        ...(variant?.haplotype1Alt ? [{ value: "one" as const, label: "Chromosome copy A" }] : []),
        ...(variant?.haplotype2Alt ? [{ value: "two" as const, label: "Chromosome copy B" }] : [])
      ];
  const modeDescription = {
    restore: "Use the reference allele instead of the selected variant.",
    replace: "Replace the selected variant with another allele.",
  }[mode];

  useEffect(() => {
    if (!variant) return;
    setAlternate(variant.key.alternate);
    setHaplotype(variant.unphasedAlt ? "unphased" : variant.haplotype2Alt ? "two" : "one");
    setSaveFeedback(undefined);
  }, [variant]);

  function chooseMode(nextMode: "restore" | "replace") {
    setMode(nextMode);
    if (variant) {
      setHaplotype(variant.unphasedAlt ? "unphased" : variant.haplotype2Alt ? "two" : "one");
    }
  }

  async function submit() {
    if (!variant) return;
    setSaveFeedback({ tone: "working", message: "Saving mutation state…" });
    try {
      if (mode === "restore") {
        await onApply(haplotype, { kind: "restoreReference", sourceKey: variant.key }, note);
      } else {
        const key = {
          ...variant.key,
          alternate: normalizedAlternate
        };
        await onApply(
          haplotype,
          { kind: "setAllele", key, sourceKey: variant.key },
          note
        );
      }
      setSaveFeedback({ tone: "saved", message: "Mutation state saved." });
    } catch (error) {
      setSaveFeedback({ tone: "error", message: messageOf(error) });
    }
  }

  return (
    <section className="edit-panel">
      <div className="section-title"><span>Mutation editor</span><small>selected VCF allele</small></div>
      <p className="panel-intro">Change the selected input-VCF position on <b>{trackName}</b>. The mutation becomes a visible, reversible block on that track.</p>
      {!editable && <div className="source-track-notice">
        <span>The source genome is protected. Create an editable copy before adding a mutation.</span>
        {onDuplicateProtectedTrack && <button type="button" className="button secondary wide" onClick={onDuplicateProtectedTrack} disabled={busy}>Duplicate track and mutate</button>}
      </div>}
      <div className="segmented">
        <button className={mode === "restore" ? "active" : ""} onClick={() => chooseMode("restore")} disabled={!variant || !editable}>Use reference</button>
        <button className={mode === "replace" ? "active" : ""} onClick={() => chooseMode("replace")} disabled={!variant || !editable}>Change ALT</button>
      </div>
      <p className="mode-description">{modeDescription}</p>
      {variant?.unphasedAlt && <div className="phase-lock-notice">
        <b>Chromosome copy unknown · input genotype 0/1</b>
        <span>DGW follows the existing ALT without assigning it to chromosome copy A or B. Changing ALT stays unphased; using reference removes the variant from this track.</span>
      </div>}
      <div className="edit-grid">
        <label>Apply to<select value={haplotype} onChange={(event) => setHaplotype(event.target.value as Haplotype)} disabled={placementOptions.length <= 1}>{placementOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
        {variant && <div className="locked-position"><span>VCF position</span><code>{variant.key.contig}:{variant.key.position.toLocaleString()} {variant.key.reference}→{variant.key.alternate}</code></div>}
        {mode === "replace" && <>
          <label>ALT<input className="allele-input" value={alternate} onChange={(event) => setAlternate(event.target.value)} /></label>
        </>}
      </div>
      {mode === "replace" && variant && !alternateIsChanged && <p className="mutation-validation">Enter an ALT different from the current <code>{variant.key.alternate}</code>.</p>}
      {mode === "replace" && variant && alternateIsReference && <p className="mutation-validation error"><code>{variant.key.reference}</code> is the REF allele. Choose <b>Use reference</b> above instead of Change ALT.</p>}
      {mode === "replace" && alternate && !alternateIsValid && <p className="mutation-validation error">ALT may contain only A, C, G, T, or N.</p>}
      <p className="placement-help">Only a position present in the input VCF can be edited. DGW can target a named copy only when the selected ALT is phased onto that copy. A regular VCF cannot prove that unreported positions were confidently called reference.</p>
      <label>Note <span className="optional">optional</span><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Why are you testing this change?" /></label>
      {saveFeedback && <p className={`mutation-save-feedback ${saveFeedback.tone}`} role={saveFeedback.tone === "error" ? "alert" : "status"}>{saveFeedback.message}</p>}
      <button className="button primary wide" onClick={submit} disabled={busy || !editable || !variant || (mode === "replace" && (!alternateIsValid || !alternateIsChanged || alternateIsReference))}>{busy ? "Saving…" : "Add mutation block to track"}</button>
    </section>
  );
}

function AlleleEditorPane({
  variant,
  focus,
  context,
  snpeffEvidence,
  track,
  busy,
  onApply,
  onDuplicateTrack,
  onShowDevices
}: {
  variant?: EffectiveVariant;
  focus?: FocusView;
  context: FocusContext;
  snpeffEvidence?: EvidenceResult;
  track: GenomeTrack;
  busy: boolean;
  onApply: (haplotype: Haplotype, edit: EditKind, note: string) => Promise<void>;
  onDuplicateTrack: () => void;
  onShowDevices: () => void;
}) {
  const compoundCopyGroups = [
    { label: "chromosome copy A", count: focus?.variants.filter((item) => item.haplotype1Alt).length ?? 0 },
    { label: "chromosome copy B", count: focus?.variants.filter((item) => item.haplotype2Alt).length ?? 0 }
  ].filter((group) => group.count > 1);

  return <section className="dgw-allele-detail" aria-label="Selected allele editor">
    <header className="dgw-detail-header">
      <div><span>Allele editor</span><small>{variant ? `${variant.key.contig}:${variant.key.position.toLocaleString()} ${variant.key.reference}→${variant.key.alternate}` : "Select an allele block"}</small></div>
      <button type="button" onClick={onShowDevices}>Show devices</button>
    </header>
    <div className="dgw-allele-detail-body">
      <div className="dgw-focused-sequence">
        <VariantChangeLens variant={variant} referenceSequence={focus?.referenceSequence} context={context} snpeffEvidence={snpeffEvidence} />
        <div className="coordinate-ruler"><span>{context.contig}:{context.start.toLocaleString()}</span><i /><span>{context.end.toLocaleString()}</span></div>
        <SequenceRow label="REF" sequence={focus?.referenceSequence} tone="reference" context={context} variants={focus?.variants ?? []} track="reference" selected={variant} />
        <SequenceRow label="CHR COPY A" sequence={focus?.haplotype1Sequence} tone="hap-one" context={context} variants={focus?.variants ?? []} track="one" selected={variant} />
        <SequenceRow label="CHR COPY B" sequence={focus?.haplotype2Sequence} tone="hap-two" context={context} variants={focus?.variants ?? []} track="two" selected={variant} />
        {focus?.variants.some((item) => item.unphasedAlt) && <p className="phase-notice"><b>U</b> The ALT belongs to one chromosome copy, but genotype 0/1 does not identify A or B.</p>}
        {compoundCopyGroups.length > 0 && <p className="compound-notice"><b>Combined effect not calculated</b> {compoundCopyGroups.map((group) => `${group.count} variants on ${group.label}`).join(" · ")}.</p>}
      </div>
      <EditPanel
        variant={variant}
        onApply={onApply}
        busy={busy}
        editable={!track.readOnly}
        trackName={track.name}
        onDuplicateProtectedTrack={track.readOnly ? onDuplicateTrack : undefined}
      />
    </div>
  </section>;
}

function Workstation({
  projectPath,
  snapshot,
  setSnapshot,
  settings,
  exportRequest
}: {
  projectPath: string;
  snapshot: ProjectSnapshot;
  setSnapshot: (snapshot: ProjectSnapshot) => void;
  settings: UserSettings;
  exportRequest?: ExportRequest;
}) {
  const initial = snapshot.workspace.focus ?? (snapshot.variants[0] ? {
    contig: snapshot.variants[0].key.contig,
    start: Math.max(1, snapshot.variants[0].key.position - 35),
    end: snapshot.variants[0].key.position + 35
  } : { contig: "1", start: 1, end: 80 });
  const [context, setContext] = useState<FocusContext>(initial);
  const [focus, setFocus] = useState<FocusView>();
  const [selected, setSelected] = useState<EffectiveVariant>();
  const [selectedAlleleIds, setSelectedAlleleIds] = useState<string[]>([]);
  const [evaluation, setEvaluation] = useState<EvaluationResult>();
  const [deviceManifests, setDeviceManifests] = useState<DeviceManifest[]>([]);
  const [deviceEvaluations, setDeviceEvaluations] = useState<Record<string, EvidenceResult>>({});
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>(DEVICE_IDS.snpeff);
  const [runningDeviceId, setRunningDeviceId] = useState<string>();
  const [bypassedDevicesByTrack, setBypassedDevicesByTrack] = useState<Record<string, string[]>>({});
  const [trackDeck, setTrackDeck] = useState<GenomeTrackLane[]>([]);
  const [selectedEditId, setSelectedEditId] = useState<string>();
  const [hiddenTrackIds, setHiddenTrackIds] = useState<string[]>([]);
  const [optimizers, setOptimizers] = useState<Record<string, GenomeOptimizerDevice>>({});
  const [randomizers, setRandomizers] = useState<Record<string, AlleleRandomizerDevice>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("Ready");
  const [detailMode, setDetailMode] = useState<"devices" | "allele">("devices");
  const [meterEvaluations, setMeterEvaluations] = useState<Record<string, Record<string, MeterEditEvaluation>>>({});
  const evaluationGeneration = useRef(0);
  const focusRefreshGeneration = useRef(0);
  const viewportRefreshTimer = useRef<number | undefined>(undefined);
  const handledExportRequest = useRef(0);
  const visibleVariants = focus?.variants ?? snapshot.variants;
  const activeTrack = focus?.activeTrack ?? snapshot.activeTrack;
  const activeBypassedDevices = bypassedDevicesByTrack[activeTrack.id] ?? [];
  const activeBypassedDeviceSet = useMemo(
    () => new Set(activeBypassedDevices),
    [activeBypassedDevices]
  );
  const evidenceByDevice = useMemo<Record<string, EvidenceResult | undefined>>(() => ({
    [DEVICE_IDS.snpeff]: deviceEvaluations[DEVICE_IDS.snpeff] ?? evaluation?.snpeff,
    [DEVICE_IDS.dbnsfp]: deviceEvaluations[DEVICE_IDS.dbnsfp] ?? evaluation?.dbnsfp,
    [DEVICE_IDS.clinvar]: deviceEvaluations[DEVICE_IDS.clinvar] ?? evaluation?.clinvar,
    [DEVICE_IDS.cosmic]: deviceEvaluations[DEVICE_IDS.cosmic] ?? evaluation?.cosmic
  }), [deviceEvaluations, evaluation]);
  const rackDevices = useMemo<RackDeviceView[]>(() => {
    const bundle = snapshot.manifest.resourceBundle;
    const order = new Map<string, number>([
      [DEVICE_IDS.snpeff, 10],
      [DEVICE_IDS.dbnsfp, 20],
      [DEVICE_IDS.clinvar, 30],
      [DEVICE_IDS.cosmic, 40]
    ]);
    return deviceManifests
      .filter((manifest) => alleleDeviceIds.includes(manifest.id as typeof alleleDeviceIds[number]))
      .map((manifest) => {
        const evidence = evidenceByDevice[manifest.id];
        const resource = manifest.id === DEVICE_IDS.snpeff
          ? `${bundle.snpeffGenome} transcript data`
          : manifest.id === DEVICE_IDS.dbnsfp
            ? bundle.dbnsfp.release
            : manifest.id === DEVICE_IDS.clinvar
              ? bundle.clinvar.release
              : bundle.cosmic.release;
        const version = manifest.id === DEVICE_IDS.snpeff ? `SnpEff ${bundle.snpeffVersion}` : `device ${manifest.version}`;
        const kind = manifest.id === DEVICE_IDS.snpeff
          ? "annotation"
          : manifest.id === DEVICE_IDS.dbnsfp
            ? "prediction"
            : "evidence";
        const running = runningDeviceId === manifest.id || runningDeviceId === "all";
        return {
          id: manifest.id,
          name: manifest.name,
          kind,
          target: "selectedAllele",
          order: order.get(manifest.id) ?? 100,
          bypassed: activeBypassedDeviceSet.has(manifest.id),
          status: running ? "running" : evidence?.status ?? "notComputed",
          resource,
          version,
          result: evidenceSummary(evidence),
          limitation: manifest.scientificLimitations[0],
          canRun: Boolean(selected),
          runLabel: evidence ? "Run again" : "Run"
        } satisfies RackDeviceView;
      });
  }, [activeBypassedDeviceSet, deviceManifests, evidenceByDevice, runningDeviceId, selected, snapshot.manifest.resourceBundle]);
  const trackModels = useMemo<GenomeTrackModel[]>(() => {
    const optimizerManifest = deviceManifests.find((manifest) => manifest.id === DEVICE_IDS.optimizer);
    const randomizerManifest = deviceManifests.find((manifest) => manifest.id === DEVICE_IDS.randomizer);
    return trackDeck.map((lane) => {
      const optimizer = optimizers[lane.track.id] ?? defaultOptimizer(lane.track.id);
      const randomizer = randomizers[lane.track.id] ?? defaultRandomizer();
      return {
        id: lane.track.id,
        name: lane.track.name,
        kind: lane.track.readOnly ? "source" : "candidate",
        visible: !hiddenTrackIds.includes(lane.track.id),
        totalEditCount: lane.edits.length,
        alleles: (lane.variants ?? [])
          .filter((variant) => variant.key.contig === context.contig)
          .filter((variant) => variant.key.position <= context.end && variant.key.position + variant.key.reference.length - 1 >= context.start)
          .map((variant) => ({
            id: alleleId(variant),
            position: variant.key.position,
            reference: variant.key.reference,
            alternate: variant.key.alternate,
            origin: variant.origin
          })),
        edits: lane.edits
          .filter((edit) => (edit.edit.kind === "restoreReference" ? edit.edit.sourceKey : edit.edit.key).contig === context.contig)
          .map((edit) => editBlock(lane, edit.id))
          .filter((edit): edit is GenomeTrackEditBlock => Boolean(edit))
          .filter((edit) => edit.position >= context.start && edit.position <= context.end),
        optimizer: lane.track.readOnly ? undefined : {
          ...optimizer,
          name: optimizerManifest?.name ?? optimizer.name,
          version: optimizerManifest ? `device ${optimizerManifest.version}` : optimizer.version,
          limitation: optimizerManifest?.scientificLimitations[0] ?? optimizer.limitation
        },
        randomizer: lane.track.readOnly ? undefined : {
          ...randomizer,
          name: randomizerManifest?.name ?? randomizer.name,
          version: randomizerManifest ? `device ${randomizerManifest.version}` : randomizer.version,
          limitation: randomizerManifest?.scientificLimitations[0] ?? randomizer.limitation
        }
      } satisfies GenomeTrackModel;
    });
  }, [context.contig, context.end, context.start, deviceManifests, hiddenTrackIds, optimizers, randomizers, trackDeck]);
  const trackMeter = useMemo<TrackMeterModel>(() => {
    const lane = trackDeck.find((item) => item.track.id === activeTrack.id);
    const stored = meterEvaluations[activeTrack.id] ?? {};
    const items = (lane?.edits ?? []).map((operation) => {
      const block = editBlock(lane!, operation.id);
      const enabled = !activeTrack.bypassedEditIds.includes(operation.id);
      const measured = stored[operation.id];
      const sourceImpact = snpeffImpactSignal(measured?.sourceEvidence[DEVICE_IDS.snpeff]);
      const currentImpact = measured?.currentIsReference
        ? 0
        : snpeffImpactSignal(measured?.currentEvidence[DEVICE_IDS.snpeff]);
      const impactDelta = sourceImpact !== undefined && currentImpact !== undefined
        ? currentImpact - sourceImpact
        : undefined;
      return {
        editId: operation.id,
        label: block?.label ?? operation.id.slice(0, 8),
        enabled,
        evaluated: impactDelta !== undefined,
        impactDelta
      };
    });
    const activeItems = items.filter((item) => item.enabled);
    const evaluatedItems = activeItems.filter((item) => item.impactDelta !== undefined);
    const labels = new Map([
      [DEVICE_IDS.snpeff, "SnpEff"],
      [DEVICE_IDS.dbnsfp, "dbNSFP"],
      [DEVICE_IDS.clinvar, "ClinVar"],
      [DEVICE_IDS.cosmic, "COSMIC"]
    ]);
    const deviceCoverage = alleleDeviceIds.map((deviceId) => {
      const activeEvaluations = activeItems
        .map((item) => stored[item.editId])
        .filter((value): value is MeterEditEvaluation => Boolean(value));
      return {
        id: deviceId,
        label: labels.get(deviceId) ?? deviceId,
        evaluated: activeEvaluations.filter((value) => value.evaluatedDeviceIds.includes(deviceId)).length,
        total: activeItems.length,
        exactMatches: activeEvaluations.reduce((count, value) => {
          const evidence = value.currentIsReference ? undefined : value.currentEvidence[deviceId];
          return count + (evidence?.status === "found" ? evidence.records.length : 0);
        }, 0)
      };
    });
    const snpeffEnabled = !activeBypassedDeviceSet.has(DEVICE_IDS.snpeff);
    return {
      evaluatedMutations: snpeffEnabled ? evaluatedItems.length : 0,
      activeMutations: activeItems.length,
      impactDelta: snpeffEnabled && evaluatedItems.length === activeItems.length && activeItems.length > 0
        ? evaluatedItems.reduce((sum, item) => sum + (item.impactDelta ?? 0), 0)
        : undefined,
      deviceCoverage,
      items
    };
  }, [activeBypassedDeviceSet, activeTrack, meterEvaluations, trackDeck]);
  useEffect(() => {
    api.deviceCatalog()
      .then(setDeviceManifests)
      .catch((error) => setNotice(`Device catalog unavailable: ${messageOf(error)}`));
  }, []);

  useEffect(() => {
    if (trackDeck.length === 0) return;
    setOptimizers((current) => {
      let changed = false;
      const next = { ...current };
      for (const lane of trackDeck) {
        if (!lane.track.readOnly && !next[lane.track.id]) {
          next[lane.track.id] = defaultOptimizer(lane.track.id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
    setRandomizers((current) => {
      let changed = false;
      const next = { ...current };
      for (const lane of trackDeck) {
        if (!lane.track.readOnly && !next[lane.track.id]) {
          next[lane.track.id] = defaultRandomizer();
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [trackDeck]);

  useEffect(() => {
    setRandomizers((current) => {
      const device = current[activeTrack.id];
      if (!device?.preview) return current;
      return {
        ...current,
        [activeTrack.id]: {
          ...device,
          preview: undefined,
          status: "stale",
          message: "The allele selection or track state changed. Preview again before applying."
        }
      };
    });
  }, [activeTrack.id, selectedAlleleIds, trackDeck]);

  async function refresh(
    nextContext = context,
    options: { background?: boolean; reloadTracks?: boolean } = {}
  ) {
    const background = options.background ?? false;
    const reloadTracks = options.reloadTracks ?? true;
    const generation = ++focusRefreshGeneration.current;
    if (!background && viewportRefreshTimer.current !== undefined) {
      window.clearTimeout(viewportRefreshTimer.current);
      viewportRefreshTimer.current = undefined;
    }
    if (!background) setBusy(true);
    try {
      const [view, lanes] = await Promise.all([
        api.focusRegion(projectPath, nextContext),
        reloadTracks ? api.trackDeck(projectPath) : Promise.resolve(undefined)
      ]);
      if (generation !== focusRefreshGeneration.current) return;
      setFocus(view);
      if (lanes) setTrackDeck(lanes);
      setContext(nextContext);
      if (selected) {
        const refreshedSelection = view.variants.find((item) => item.key.assembly === selected.key.assembly && variantLabel(item.key) === variantLabel(selected.key));
        if (refreshedSelection) setSelected(refreshedSelection);
      } else {
        setSelected(view.variants[0]);
      }
      setNotice("Focused region is up to date");
      return { view, lanes };
    } catch (error) {
      if (generation !== focusRefreshGeneration.current) return;
      setNotice(messageOf(error));
    } finally {
      if (!background && generation === focusRefreshGeneration.current) setBusy(false);
    }
  }

  function previewViewport(nextContext: FocusContext) {
    setContext(nextContext);
    setNotice(`Viewing ${nextContext.contig}:${nextContext.start.toLocaleString()}–${nextContext.end.toLocaleString()}…`);
    if (viewportRefreshTimer.current !== undefined) {
      window.clearTimeout(viewportRefreshTimer.current);
    }
    viewportRefreshTimer.current = window.setTimeout(() => {
      viewportRefreshTimer.current = undefined;
      void refresh(nextContext, { background: true, reloadTracks: false });
    }, 160);
  }

  useEffect(() => {
    void refresh(initial);
    const first = snapshot.variants[0];
    if (first) void api.evaluate(projectPath, first.key).catch(() => undefined);
  }, []);

  useEffect(() => () => {
    if (viewportRefreshTimer.current !== undefined) {
      window.clearTimeout(viewportRefreshTimer.current);
    }
  }, []);

  async function focusVariant(variant: EffectiveVariant) {
    evaluationGeneration.current += 1;
    setSelected(variant);
    setSelectedAlleleIds([alleleId(variant)]);
    setSelectedEditId(variant.editIds[0]);
    setDetailMode("allele");
    setEvaluation(undefined);
    setDeviceEvaluations({});
    const next = {
      contig: variant.key.contig,
      start: Math.max(1, variant.key.position - 35),
      end: variant.key.position + Math.max(35, variant.key.reference.length + 10)
    };
    await refresh(next);
  }

  async function apply(haplotype: Haplotype, edit: EditKind, note: string) {
    setBusy(true);
    try {
      const createdState = await api.applyEdit(
        projectPath,
        activeTrack.headStateId,
        haplotype,
        edit,
        activeTrack.bypassedEditIds,
        note || undefined,
        activeTrack.id
      );
      const nextSnapshot = await api.openProject(projectPath);
      setSnapshot(nextSnapshot);
      setEvaluation(undefined);
      setDeviceEvaluations({});
      const refreshed = await refresh(context);
      const createdEditId = createdState.editId;
      let mutationCount: number | undefined;
      if (createdEditId && refreshed?.lanes) {
        const lane = refreshed.lanes.find((item) => item.track.id === nextSnapshot.activeTrack.id);
        mutationCount = lane?.edits.length;
        const createdVariant = lane && variantForTrackEdit(lane, createdEditId);
        if (createdVariant) setSelected(createdVariant);
        if (createdVariant) setSelectedAlleleIds([alleleId(createdVariant)]);
        setSelectedEditId(createdEditId);
      }
      setDetailMode("allele");
      setNotice(`Mutation state${mutationCount ? ` ${mutationCount}` : ""} added to ${nextSnapshot.activeTrack.name}`);
    } catch (error) {
      setNotice(messageOf(error));
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function selectTrack(trackId: string) {
    if (trackId === activeTrack.id) return;
    setBusy(true);
    try {
      const nextSnapshot = await api.selectTrack(projectPath, trackId);
      setSnapshot(nextSnapshot);
      setEvaluation(undefined);
      setDeviceEvaluations({});
      setSelectedEditId(undefined);
      setSelectedAlleleIds([]);
      await refresh(context);
      setNotice(`Selected ${nextSnapshot.activeTrack.name}`);
    } catch (error) {
      setNotice(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function selectTrackAndShowDevices(trackId: string) {
    if (trackId !== activeTrack.id) await selectTrack(trackId);
    setSelectedEditId(undefined);
    setDetailMode("devices");
  }

  async function openTrackAllele(trackId: string, id: string) {
    const lane = trackDeck.find((item) => item.track.id === trackId);
    const variant = lane?.variants?.find((item) => alleleId(item) === id);
    if (!variant) {
      setNotice("That allele is no longer present on this track");
      return;
    }
    if (trackId !== activeTrack.id) await selectTrack(trackId);
    setSelected(variant);
    setSelectedAlleleIds([id]);
    setSelectedEditId(variant.editIds[0]);
    setEvaluation(undefined);
    setDeviceEvaluations({});
    setDetailMode("allele");
    setNotice(`Editing ${variant.key.contig}:${variant.key.position.toLocaleString()} on ${lane?.track.name ?? "track"}`);
  }

  async function openTrackEdit(trackId: string, editId: string) {
    const lane = trackDeck.find((item) => item.track.id === trackId);
    if (!lane) return;
    const variant = variantForTrackEdit(lane, editId);
    if (!variant) return;
    if (trackId !== activeTrack.id) await selectTrack(trackId);
    setSelected(variant);
    setSelectedAlleleIds([alleleId(variant)]);
    setSelectedEditId(editId);
    setEvaluation(undefined);
    setDeviceEvaluations({});
    setDetailMode("allele");
    setNotice(`Opened mutation block on ${lane.track.name}`);
  }

  function selectAllVisibleAlleles(trackId: string) {
    const track = trackModels.find((item) => item.id === trackId);
    const ids = track?.alleles.map((allele) => allele.id) ?? [];
    setSelectedAlleleIds(ids);
    setSelectedEditId(undefined);
    setDetailMode("devices");
    setSelectedDeviceId(DEVICE_IDS.randomizer);
    if (ids.length > 0) {
      const lane = trackDeck.find((item) => item.track.id === trackId);
      const first = lane?.variants.find((variant) => ids.includes(alleleId(variant)));
      if (first) setSelected(first);
    }
    setNotice(ids.length === 0 ? "No VCF alleles are visible in this region" : `Selected all ${ids.length} visible VCF allele positions`);
  }

  function clearAlleleSelection() {
    setSelectedAlleleIds([]);
    setSelectedEditId(undefined);
    setNotice("Allele selection cleared");
  }

  async function duplicateTrack(trackId: string) {
    const source = snapshot.tracks.find((track) => track.id === trackId);
    if (!source) return;
    const copyNumber = snapshot.tracks.filter((track) => !track.readOnly).length + 1;
    setBusy(true);
    try {
      const nextSnapshot = await api.duplicateTrack(projectPath, trackId, `${source.name} copy ${copyNumber}`);
      setSnapshot(nextSnapshot);
      setEvaluation(undefined);
      setDeviceEvaluations({});
      setSelectedEditId(undefined);
      await refresh(context);
      setNotice(`Duplicated ${source.name} as ${nextSnapshot.activeTrack.name}`);
    } catch (error) {
      setNotice(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function renameTrack(trackId: string, name: string) {
    const normalized = name.trim();
    if (!normalized) return;
    const stored = snapshot.tracks.find((track) => track.id === trackId);
    if (!stored || stored.name === normalized) return;
    setBusy(true);
    try {
      const nextSnapshot = await api.renameTrack(projectPath, trackId, normalized);
      setSnapshot(nextSnapshot);
      await refresh(context);
      setNotice(`Renamed track to ${normalized}`);
    } catch (error) {
      setNotice(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function deleteTrack(trackId: string) {
    const track = snapshot.tracks.find((candidate) => candidate.id === trackId);
    if (!track || !window.confirm(`Archive “${track.name}”? Its scientific ancestry remains in the project audit trail.`)) return;
    if (!track.readOnly && snapshot.tracks.filter((candidate) => !candidate.readOnly).length <= 1) {
      setNotice("A project must keep at least one editable genome track");
      return;
    }
    setBusy(true);
    try {
      if (activeTrack.id === trackId) {
        const fallback = snapshot.tracks.find((candidate) => candidate.id !== trackId && !candidate.readOnly)
          ?? snapshot.tracks.find((candidate) => candidate.id !== trackId);
        if (!fallback) throw new Error("No other genome track is available.");
        await api.selectTrack(projectPath, fallback.id);
      }
      const nextSnapshot = await api.deleteTrack(projectPath, trackId);
      setSnapshot(nextSnapshot);
      setHiddenTrackIds((current) => current.filter((id) => id !== trackId));
      setOptimizers((current) => {
        const next = { ...current };
        delete next[trackId];
        return next;
      });
      setRandomizers((current) => {
        const next = { ...current };
        delete next[trackId];
        return next;
      });
      await refresh(context);
      setNotice(`Archived ${track.name}`);
    } catch (error) {
      setNotice(messageOf(error));
      await refresh(context);
    } finally {
      setBusy(false);
    }
  }

  async function toggleTrackEdit(trackId: string, editId: string, enabled: boolean) {
    setBusy(true);
    try {
      const nextSnapshot = await api.setTrackEditBypass(projectPath, trackId, editId, !enabled);
      setSnapshot(nextSnapshot);
      if (trackId === activeTrack.id) setEvaluation(undefined);
      if (trackId === activeTrack.id) setDeviceEvaluations({});
      await refresh(context);
      setNotice(`${enabled ? "Enabled" : "Bypassed"} edit block`);
    } catch (error) {
      setNotice(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  function changeOptimizer(trackId: string, settings: GenomeOptimizerSettings) {
    setOptimizers((current) => ({
      ...current,
      [trackId]: {
        ...(current[trackId] ?? defaultOptimizer(trackId)),
        settings,
        status: "stale",
        result: undefined,
        message: "Controls changed. Regenerate to create a new bounded candidate."
      }
    }));
  }

  function randomizerRequest(trackId: string, device: AlleleRandomizerDevice): RandomizerRequest {
    const lane = trackDeck.find((item) => item.track.id === trackId);
    const selectedSet = new Set(selectedAlleleIds);
    return {
      selectedVariants: (lane?.variants ?? [])
        .filter((variant) => selectedSet.has(alleleId(variant)))
        .map((variant) => variant.key),
      amount: device.settings.amount,
      seed: device.settings.seed
    };
  }

  function randomizerPreview(plan: RandomizerPlan) {
    const changes = new Map<string, { position: number; from: string; to: string }>();
    for (const proposal of plan.proposals) {
      const key = `${proposal.sourceVariant.contig}:${proposal.sourceVariant.position}:${proposal.sourceVariant.alternate}:${proposal.replacementVariant.alternate}`;
      changes.set(key, {
        position: proposal.sourceVariant.position,
        from: proposal.sourceVariant.alternate,
        to: proposal.replacementVariant.alternate
      });
    }
    return {
      selectedPositions: plan.selectedPositions,
      randomizedPositions: plan.randomizedPositions,
      generatedEdits: plan.generatedEdits,
      excludedPositions: plan.exclusions.length,
      changes: [...changes.values()],
      message: plan.noOpReason
    };
  }

  function changeRandomizer(trackId: string, settings: AlleleRandomizerSettings) {
    setRandomizers((current) => ({
      ...current,
      [trackId]: {
        ...(current[trackId] ?? defaultRandomizer()),
        settings,
        status: "stale",
        preview: undefined,
        message: "Controls changed. Preview the new deterministic result."
      }
    }));
  }

  async function previewRandomizer(trackId: string) {
    const device = randomizers[trackId] ?? defaultRandomizer();
    setBusy(true);
    setRandomizers((current) => ({
      ...current,
      [trackId]: { ...(current[trackId] ?? device), status: "running", message: "Building preview…" }
    }));
    try {
      const plan = await api.previewRandomizer(projectPath, trackId, randomizerRequest(trackId, device));
      setRandomizers((current) => ({
        ...current,
        [trackId]: {
          ...(current[trackId] ?? device),
          status: "ready",
          preview: randomizerPreview(plan),
          message: plan.noOpReason ?? `${plan.randomizedPositions} selected positions ready to apply.`
        }
      }));
      setNotice(plan.noOpReason ?? `Preview: ${plan.randomizedPositions} positions become ${plan.generatedEdits} reversible mutation blocks`);
    } catch (error) {
      setRandomizers((current) => ({
        ...current,
        [trackId]: { ...(current[trackId] ?? device), status: "error", message: messageOf(error) }
      }));
      setNotice(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function applyRandomizer(trackId: string) {
    const device = randomizers[trackId] ?? defaultRandomizer();
    if (!device.preview || device.preview.generatedEdits === 0) return;
    setBusy(true);
    setRandomizers((current) => ({
      ...current,
      [trackId]: { ...(current[trackId] ?? device), status: "running", message: "Writing reversible mutation blocks…" }
    }));
    try {
      const result = await api.runRandomizer(projectPath, trackId, randomizerRequest(trackId, device));
      setSnapshot(result.snapshot);
      setRandomizers((current) => ({
        ...current,
        [trackId]: {
          ...(current[trackId] ?? device),
          bypassed: false,
          status: "ready",
          generatedEditIds: [...new Set([...(device.generatedEditIds ?? []), ...result.generatedEditIds])],
          preview: undefined,
          message: `${result.generatedEditIds.length} reversible mutation blocks applied.`
        }
      }));
      setSelectedAlleleIds([]);
      setSelectedEditId(result.generatedEditIds.at(-1));
      setEvaluation(undefined);
      setDeviceEvaluations({});
      await refresh(context);
      setNotice(`Allele Randomizer added ${result.generatedEditIds.length} reversible mutation blocks`);
    } catch (error) {
      setRandomizers((current) => ({
        ...current,
        [trackId]: { ...(current[trackId] ?? device), status: "error", message: messageOf(error) }
      }));
      setNotice(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function bypassRandomizer(trackId: string, bypassed: boolean) {
    const device = randomizers[trackId] ?? defaultRandomizer();
    if (!device.generatedEditIds?.length) {
      setRandomizers((current) => ({ ...current, [trackId]: { ...(current[trackId] ?? device), bypassed } }));
      return;
    }
    setBusy(true);
    try {
      let nextSnapshot = snapshot;
      for (const editId of device.generatedEditIds) {
        nextSnapshot = await api.setTrackEditBypass(projectPath, trackId, editId, bypassed);
      }
      setSnapshot(nextSnapshot);
      setRandomizers((current) => ({ ...current, [trackId]: { ...(current[trackId] ?? device), bypassed } }));
      await refresh(context);
      setNotice(`${bypassed ? "Bypassed" : "Enabled"} Allele Randomizer mutation blocks`);
    } catch (error) {
      setNotice(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function bypassOptimizer(trackId: string, bypassed: boolean) {
    const device = optimizers[trackId] ?? defaultOptimizer(trackId);
    if (!device.generatedEditIds?.length) {
      setOptimizers((current) => ({
        ...current,
        [trackId]: { ...(current[trackId] ?? defaultOptimizer(trackId)), bypassed }
      }));
      return;
    }
    setBusy(true);
    try {
      let nextSnapshot = snapshot;
      for (const editId of device.generatedEditIds) {
        nextSnapshot = await api.setTrackEditBypass(projectPath, trackId, editId, bypassed);
      }
      setSnapshot(nextSnapshot);
      setOptimizers((current) => ({
        ...current,
        [trackId]: { ...(current[trackId] ?? defaultOptimizer(trackId)), bypassed }
      }));
      await refresh(context);
      setNotice(`${bypassed ? "Bypassed" : "Enabled"} Genome Optimizer edit blocks`);
    } catch (error) {
      setNotice(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function regenerateOptimizer(trackId: string) {
    const device = optimizers[trackId] ?? defaultOptimizer(trackId);
    setOptimizers((current) => ({
      ...current,
      [trackId]: {
        ...(current[trackId] ?? defaultOptimizer(trackId)),
        status: "running",
        message: "Preparing a bounded candidate from source-sample alleles…"
      }
    }));
    setBusy(true);
    setNotice("Genome Optimizer is scoring independent source alleles…");
    try {
      for (const editId of device.generatedEditIds ?? []) {
        await api.setTrackEditBypass(projectPath, trackId, editId, true);
      }
      const settings = device.settings;
      const request: OptimizerRequest = {
        objective: settings.objectiveId as OptimizerRequest["objective"],
        direction: settings.direction,
        maxEdits: settings.maxEdits,
        weights: {
          impact: settings.weights.impact ?? 0,
          clinvar: settings.weights.clinvar ?? 0,
          sourceEvidence: settings.weights.sourceEvidence ?? 0
        }
      };
      const result = await api.runOptimizer(projectPath, trackId, context, request);
      setSnapshot(result.snapshot);
      setOptimizers((current) => ({
        ...current,
        [trackId]: {
          ...(current[trackId] ?? device),
          bypassed: false,
          status: "ready",
          generatedEditIds: result.generatedEditIds,
          message: result.plan.noOpReason ?? `${result.generatedEditIds.length} reversible edit blocks generated.`,
          result: {
            generatedEdits: result.generatedEditIds.length,
            beforeScore: result.plan.scoreBefore,
            afterScore: result.plan.scoreAfter,
            scoreUnit: "model units",
            summary: `${result.plan.scoreDescription} ${result.plan.limitation}`
          }
        }
      }));
      setEvaluation(undefined);
      setDeviceEvaluations({});
      await refresh(context);
      setNotice(result.plan.noOpReason ?? `Genome Optimizer added ${result.generatedEditIds.length} edit blocks`);
    } catch (error) {
      setOptimizers((current) => ({
        ...current,
        [trackId]: {
          ...(current[trackId] ?? device),
          status: "error",
          message: messageOf(error)
        }
      }));
      setNotice(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function consolidateTrack(trackId: string) {
    const track = snapshot.tracks.find((candidate) => candidate.id === trackId);
    if (!track || !window.confirm(`Consolidate the visible edits on “${track.name}” into its baseline? The audit history is retained.`)) return;
    setBusy(true);
    try {
      const nextSnapshot = await api.consolidateTrack(projectPath, trackId);
      setSnapshot(nextSnapshot);
      setSelectedEditId(undefined);
      setEvaluation(undefined);
      setDeviceEvaluations({});
      setOptimizers((current) => ({
        ...current,
        [trackId]: {
          ...(current[trackId] ?? defaultOptimizer(trackId)),
          status: "ready",
          generatedEditIds: [],
          result: undefined,
          message: "Track baseline consolidated; ready for a new bounded run."
        }
      }));
      setRandomizers((current) => ({
        ...current,
        [trackId]: {
          ...(current[trackId] ?? defaultRandomizer()),
          status: "ready",
          generatedEditIds: [],
          preview: undefined,
          message: "Track baseline consolidated; select alleles for a new randomization."
        }
      }));
      await refresh(context);
      setNotice(`Consolidated ${track.name}; its previous edits remain in the audit trail`);
    } catch (error) {
      setNotice(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function recordSelectedMutationMeter(
    currentEvidence: DeviceEvidenceMap,
    evaluatedDeviceIds: string[],
    generation: number
  ) {
    if (!selectedEditId || !selected) return;
    const lane = trackDeck.find((item) => item.track.id === activeTrack.id);
    const operation = lane?.edits.find((item) => item.id === selectedEditId);
    if (!operation) return;
    const sourceKey = operation.edit.kind === "restoreReference"
      ? operation.edit.sourceKey
      : operation.edit.sourceKey ?? operation.edit.key;
    const currentIsReference = operation.edit.kind === "restoreReference";
    let sourceEvidence: DeviceEvidenceMap;
    if (currentIsReference || sameVariant(sourceKey, selected.key)) {
      sourceEvidence = currentEvidence;
    } else if (evaluatedDeviceIds.length === alleleDeviceIds.length) {
      sourceEvidence = evaluationEvidence(await api.evaluate(projectPath, sourceKey));
    } else {
      const results = await Promise.all(evaluatedDeviceIds.map(async (deviceId) => [
        deviceId,
        await api.evaluateDevice(projectPath, sourceKey, deviceId)
      ] as const));
      sourceEvidence = Object.fromEntries(results);
    }
    if (generation !== evaluationGeneration.current) return;
    setMeterEvaluations((allTracks) => {
      const trackValues = allTracks[activeTrack.id] ?? {};
      const previous = trackValues[selectedEditId];
      return {
        ...allTracks,
        [activeTrack.id]: {
          ...trackValues,
          [selectedEditId]: {
            sourceEvidence: { ...(previous?.sourceEvidence ?? {}), ...sourceEvidence },
            currentEvidence: currentIsReference
              ? {}
              : { ...(previous?.currentEvidence ?? {}), ...currentEvidence },
            currentIsReference,
            evaluatedDeviceIds: [...new Set([...(previous?.evaluatedDeviceIds ?? []), ...evaluatedDeviceIds])]
          }
        }
      };
    });
  }

  async function evaluate() {
    if (!selected) return;
    const generation = ++evaluationGeneration.current;
    const activeDeviceIds = alleleDeviceIds.filter((deviceId) => !activeBypassedDeviceSet.has(deviceId));
    if (activeDeviceIds.length === 0) {
      setNotice("All allele-analysis devices are bypassed");
      return;
    }
    setBusy(true);
    setRunningDeviceId("all");
    setNotice(`Running ${activeDeviceIds.length} active allele ${activeDeviceIds.length === 1 ? "device" : "devices"}…`);
    try {
      let currentEvidence: DeviceEvidenceMap;
      if (activeDeviceIds.length === alleleDeviceIds.length) {
        const result = await api.evaluate(projectPath, selected.key);
        currentEvidence = evaluationEvidence(result);
        if (generation === evaluationGeneration.current) {
          setEvaluation(result);
          setDeviceEvaluations(currentEvidence);
        }
      } else {
        const results = await Promise.all(activeDeviceIds.map(async (deviceId) => [
          deviceId,
          await api.evaluateDevice(projectPath, selected.key, deviceId)
        ] as const));
        currentEvidence = Object.fromEntries(results);
        if (generation === evaluationGeneration.current) {
          setEvaluation(undefined);
          setDeviceEvaluations((current) => ({ ...current, ...Object.fromEntries(results) }));
        }
      }
      if (generation === evaluationGeneration.current) {
        await recordSelectedMutationMeter(currentEvidence, activeDeviceIds, generation);
        setNotice(activeDeviceIds.length === alleleDeviceIds.length
          ? "Allele evaluation is up to date"
          : "Active device results are up to date");
      }
    } catch (error) {
      setNotice(messageOf(error));
    } finally {
      setRunningDeviceId(undefined);
      setBusy(false);
    }
  }

  async function runRackDevice(_trackId: string, deviceId: string) {
    if (!selected || !alleleDeviceIds.includes(deviceId as typeof alleleDeviceIds[number])) return;
    const generation = ++evaluationGeneration.current;
    setSelectedDeviceId(deviceId);
    setRunningDeviceId(deviceId);
    setBusy(true);
    setNotice(`Running ${deviceManifests.find((manifest) => manifest.id === deviceId)?.name ?? "device"} for the selected allele…`);
    try {
      const result = await api.evaluateDevice(projectPath, selected.key, deviceId);
      if (generation === evaluationGeneration.current) {
        setDeviceEvaluations((current) => ({ ...current, [deviceId]: result }));
        await recordSelectedMutationMeter({ [deviceId]: result }, [deviceId], generation);
        setNotice(`${result.source}: ${evidenceSummary(result)}`);
      }
    } catch (error) {
      setNotice(messageOf(error));
    } finally {
      setRunningDeviceId(undefined);
      setBusy(false);
    }
  }

  function toggleRackDevice(trackId: string, deviceId: string, bypassed: boolean) {
    setBypassedDevicesByTrack((current) => {
      const existing = current[trackId] ?? [];
      return {
        ...current,
        [trackId]: bypassed
          ? [...new Set([...existing, deviceId])]
          : existing.filter((id) => id !== deviceId)
      };
    });
    const name = deviceManifests.find((manifest) => manifest.id === deviceId)?.name ?? "Device";
    setNotice(`${bypassed ? "Bypassed" : "Enabled"} ${name}; genome edits are unchanged`);
  }

  async function renderVcf() {
    const destination = await save({
      defaultPath: `${snapshot.manifest.name.replace(/\s+/g, "-").toLowerCase()}-${shortId(activeTrack.id)}.vcf.gz`,
      filters: [{ name: "Compressed VCF", extensions: ["vcf.gz"] }]
    });
    if (!destination) return;
    setBusy(true);
    try {
      const path = await api.renderTrack(projectPath, activeTrack.id, destination);
      setNotice(`Rendered ${path}`);
    } catch (error) {
      setNotice(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function exportFocusFasta() {
    const regionLabel = `${context.contig}-${context.start}-${context.end}`;
    const destination = await save({
      defaultPath: `${snapshot.manifest.name.replace(/\s+/g, "-").toLowerCase()}-${shortId(activeTrack.id)}-${regionLabel}.fa`,
      filters: [{ name: "Focused FASTA", extensions: ["fa", "fasta"] }]
    });
    if (!destination) return;
    setBusy(true);
    try {
      const result = await api.exportFocusFasta(projectPath, activeTrack.id, context, destination);
      setNotice(result.maskedUnphasedAlleles > 0
        ? `Exported ${result.sequenceRecords} FASTA records; ${result.maskedUnphasedAlleles} unphased ${result.maskedUnphasedAlleles === 1 ? "allele was" : "alleles were"} masked (details: ${result.uncertaintyPath})`
        : `Exported ${result.sequenceRecords} focused FASTA records to ${result.fastaPath}`);
    } catch (error) {
      setNotice(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!exportRequest || exportRequest.id === handledExportRequest.current) return;
    handledExportRequest.current = exportRequest.id;
    if (exportRequest.kind === "trackVcf") {
      void renderVcf();
    } else {
      void exportFocusFasta();
    }
  }, [exportRequest]);

  const activeSnpeffEvidence = activeBypassedDeviceSet.has(DEVICE_IDS.snpeff)
    ? undefined
    : evidenceByDevice[DEVICE_IDS.snpeff];
  const visibleEvidence = alleleDeviceIds
    .filter((deviceId) => !activeBypassedDeviceSet.has(deviceId))
    .map((deviceId) => evidenceByDevice[deviceId])
    .filter((result): result is EvidenceResult => Boolean(result));

  return (
    <main className={`workstation${settings.showVariantBrowser ? "" : " hide-variants"}${settings.showEvidenceInspector ? "" : " hide-evidence"}`}>
      <header className="app-header">
        <div className="mini-brand"><img src="/dgw-logo.png" alt="" /></div>
        <div><strong>{snapshot.manifest.name}</strong><span>{snapshot.manifest.selectedSample} · {snapshot.manifest.assembly}</span></div>
        <div className="header-spacer" />
        <div className="worker-state"><span className={busy ? "pulse" : "status-dot"} />{notice}</div>
      </header>

      <aside className="variant-browser">
        <div className="section-title"><span>Variants</span><small>choose · {visibleVariants.length} / {snapshot.variantCount.toLocaleString()}</small></div>
        <div className="variant-list">
          {visibleVariants.map((variant) => (
            <button key={variant.key.assembly + variantLabel(variant.key)} className={selected && variantLabel(selected.key) === variantLabel(variant.key) ? "variant-item active" : "variant-item"} onClick={() => focusVariant(variant)}>
              <span>{variant.key.contig}:{variant.key.position.toLocaleString()}</span>
              <b>{variant.key.reference}<i>›</i>{variant.key.alternate}</b>
              <small><em className={variant.origin}>{variant.origin}</em>{variantPhaseLabel(variant)}</small>
            </button>
          ))}
        </div>
      </aside>

      <section className="canvas">
        <div className="focus-toolbar">
          <label>chr<input value={context.contig} onChange={(event) => setContext({ ...context, contig: event.target.value })} /></label>
          <label>start<input type="number" value={context.start} onChange={(event) => setContext({ ...context, start: Number(event.target.value) })} /></label>
          <span>—</span>
          <label>end<input type="number" value={context.end} onChange={(event) => setContext({ ...context, end: Number(event.target.value) })} /></label>
          <button className="button secondary" onClick={() => refresh()} disabled={busy}>Go</button>
          <div className="header-spacer" />
          <small>{context.end - context.start + 1} reference bases</small>
        </div>

        <div className="track-workspace-shell">
          <TrackDeviceWorkspace
            region={context}
            tracks={trackModels}
            selectedTrackId={activeTrack.id}
            selectedEditId={selectedEditId}
            selectedAlleleId={selected ? alleleId(selected) : undefined}
            selectedAlleleIds={selectedAlleleIds}
            objectives={optimizerObjectives}
            weightControls={optimizerWeights}
            rackDevices={rackDevices}
            trackMeter={trackMeter}
            showTrackMeter={settings.showMasterMeter}
            selectedDeviceId={selectedDeviceId}
            selectedPosition={selected?.key.contig === context.contig ? selected.key.position : undefined}
            contigLength={focus?.context.contig === context.contig ? focus.contigLength : undefined}
            busy={busy}
            detailPanel={detailMode === "allele" ? <AlleleEditorPane
              variant={selected}
              focus={focus}
              context={context}
              snpeffEvidence={activeSnpeffEvidence}
              track={activeTrack}
              busy={busy}
              onApply={apply}
              onDuplicateTrack={() => {
                const currentVariant = selected;
                void duplicateTrack(activeTrack.id).then(() => {
                  if (currentVariant) setSelected(currentVariant);
                  setDetailMode("allele");
                });
              }}
              onShowDevices={() => setDetailMode("devices")}
            /> : undefined}
            onViewportChange={previewViewport}
            onSelectTrack={selectTrackAndShowDevices}
            onDuplicateTrack={duplicateTrack}
            onRenameTrack={renameTrack}
            onDeleteTrack={deleteTrack}
            onToggleTrackVisibility={(trackId, visible) => setHiddenTrackIds((current) => visible ? current.filter((id) => id !== trackId) : [...new Set([...current, trackId])])}
            onSelectEdit={openTrackEdit}
            onSelectAllele={openTrackAllele}
            onSelectAllAlleles={selectAllVisibleAlleles}
            onClearAlleleSelection={clearAlleleSelection}
            onToggleEdit={toggleTrackEdit}
            onOptimizerChange={changeOptimizer}
            onOptimizerBypass={bypassOptimizer}
            onRegenerate={regenerateOptimizer}
            onConsolidate={consolidateTrack}
            onRandomizerChange={changeRandomizer}
            onRandomizerPreview={previewRandomizer}
            onRandomizerApply={applyRandomizer}
            onRandomizerBypass={bypassRandomizer}
            onSelectDevice={(_trackId, deviceId) => { setSelectedDeviceId(deviceId); setDetailMode("devices"); }}
            onToggleDevice={toggleRackDevice}
            onRunDevice={runRackDevice}
          />
        </div>
      </section>

      <aside className="inspector">
        <div className="section-title"><span>Evidence</span><small>selected allele only</small></div>
        {selected ? <>
          <div className="selected-variant"><p>{selected.key.contig}:{selected.key.position.toLocaleString()}</p><h3>{selected.key.reference}<i>›</i>{selected.key.alternate}</h3><span>{selected.origin} · {variantPhaseLabel(selected)}</span></div>
          {selected.sourceInfo.ANN && <article className="source-annotation"><p className="eyebrow">Frozen source ANN</p><code>{selected.sourceInfo.ANN}</code></article>}
          <p className="evaluation-scope">Results apply to this selected allele alone. Select each other variant to assess it separately.</p>
          <button className="button primary wide" onClick={evaluate} disabled={busy || alleleDeviceIds.every((id) => activeBypassedDeviceSet.has(id))}>{busy ? "Working…" : "Run all active devices"}</button>
          {visibleEvidence.length > 0 ? <div className="evidence-stack">
            {visibleEvidence.map((evidence, index) => <EvidenceCard evidence={evidence} key={`${evidence.source}-${index}`} />)}
            <p className="limitation">{evaluation?.limitation ?? "Consequences and evidence are evaluated independently for one exact allele. Compound and phase-dependent effects are not calculated."}</p>
          </div> : <div className="empty-inspector"><span>◇</span><p>Predict this allele’s molecular consequence and check dbNSFP, ClinVar, and COSMIC for exact evidence.</p></div>}
        </> : <div className="empty-inspector"><span>⌖</span><p>Select an allele in the focused region.</p></div>}
      </aside>

      {snapshot.warnings.length > 0 && <footer className="warning-footer">{snapshot.warnings[0]}</footer>}
    </main>
  );
}

export default function App() {
  const [projectPath, setProjectPath] = useState("");
  const [snapshot, setSnapshot] = useState<ProjectSnapshot>();
  const [settings, setSettings] = useState<UserSettings>(() => parseUserSettings(localStorage.getItem(USER_SETTINGS_STORAGE_KEY)));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportRequest, setExportRequest] = useState<ExportRequest>();

  useEffect(() => {
    localStorage.setItem(USER_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    void getCurrentWebview().setZoom(settings.uiScale).catch((error) => {
      console.error("Unable to apply interface scale", error);
    });
  }, [settings.uiScale]);

  function closeProject() {
    setSnapshot(undefined);
    setProjectPath("");
    setExportRequest(undefined);
  }

  function requestExport(kind: ExportKind) {
    setExportRequest((current) => ({ id: (current?.id ?? 0) + 1, kind }));
  }

  return <div className={`application-shell${settings.reduceMotion ? " reduce-motion" : ""}${settings.uiScale >= 1.3 ? " large-interface" : ""}`}>
    <ApplicationMenu
      projectOpen={Boolean(snapshot)}
      projectName={snapshot?.manifest.name}
      settings={settings}
      onSettingsChange={setSettings}
      onOpenSettings={() => setSettingsOpen(true)}
      onExportTrackVcf={() => requestExport("trackVcf")}
      onExportFocusFasta={() => requestExport("focusFasta")}
      onCloseProject={closeProject}
    />
    <div className="application-stage">
      {snapshot
        ? <Workstation
          projectPath={projectPath}
          snapshot={snapshot}
          setSnapshot={setSnapshot}
          settings={settings}
          exportRequest={exportRequest}
        />
        : <Onboarding onOpened={(path, opened) => {
          setProjectPath(path);
          setSnapshot(opened);
        }} />}
    </div>
    <SettingsDialog open={settingsOpen} settings={settings} onChange={setSettings} onClose={() => setSettingsOpen(false)} />
  </div>;
}
