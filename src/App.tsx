import { useEffect, useMemo, useRef, useState } from "react";
import { confirm as confirmDialog, open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api } from "./api";
import { ApplicationMenu, ProjectTemplateDialog, SettingsDialog, type ProjectTemplateId } from "./ApplicationChrome";
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
  type TrackMeterModel,
  type TrackProfilerModel
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
  VariantSelection,
  VariantDensity,
  VariantKey,
  VcfInspection,
  WorkspaceSnapshot
} from "./types";
import { filterSamples, haplotypeLabel, parentDirectory, projectSlug, sequenceChunks, sequenceDisplayParts, shortId, variantLabel, variantPhaseLabel } from "./utils";
import { snpeffImpactSignal } from "./trackMeter";
import { effectiveScoringWeights, scoringInputState } from "./scoringInputs";
import {
  AUTO_EVALUATION_DELAY_MS,
  cacheStableEvidence,
  cachedEvidenceForDevices,
  missingEvidenceDeviceIds,
  selectionEvidenceKey,
  type SelectedAlleleEvidenceCache
} from "./selectedAlleleEvidence";
import { buildVariantNavigationEntries } from "./variantNavigation";
import {
  DEFAULT_USER_SETTINGS,
  USER_SETTINGS_STORAGE_KEY,
  parseUserSettings,
  type UserSettings
} from "./userSettings";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DEVICE_IDS = {
  snpeff: "org.dgw.builtin.snpeff",
  dbnsfp: "org.dgw.builtin.dbnsfp",
  clinvar: "org.dgw.builtin.clinvar",
  cosmic: "org.dgw.builtin.cosmic",
  randomizer: "org.dgw.builtin.mutation-generator",
  optimizer: "org.dgw.builtin.genome-optimizer"
} as const;

const VARIANT_ROW_HEIGHT = 50;
const VARIANT_LIST_OVERSCAN = 8;

const optimizerObjectives: OptimizerObjective[] = [
  {
    id: "predictedImpactBurden",
    label: "Weighted annotation burden",
    description: "Compares live exact-allele SnpEff impact among non-reference SNV candidates. It does not assume the reference allele is benign, and imported VCF annotations are never used.",
    includedWeightIds: ["impact"]
  },
  {
    id: "alternateAlleleBurden",
    label: "Distance from reference (ALT copies)",
    description: "Counts active non-reference allele copies in the focused region. This measures distance from the reference sequence; it is not a biological burden or health score.",
    includedWeightIds: []
  }
];

const optimizerWeights: OptimizerWeightControl[] = [
  { id: "impact", label: "Impact", sourceDeviceId: DEVICE_IDS.snpeff, sourceLabel: "SnpEff", description: "Weight of the live SnpEff molecular-impact result for each exact allele.", min: 0, max: 100, step: 5 }
];

function alleleId(variant: EffectiveVariant) {
  return variantKeyId(variant.key);
}

function variantKeyId(key: VariantKey) {
  return `${key.assembly}:${key.contig}:${key.position}:${key.reference}:${key.alternate}`;
}

const alleleDeviceIds = [DEVICE_IDS.snpeff, DEVICE_IDS.dbnsfp, DEVICE_IDS.clinvar, DEVICE_IDS.cosmic];
const dgwStarterDeviceIds = [DEVICE_IDS.randomizer, ...alleleDeviceIds, DEVICE_IDS.optimizer];

type DeviceEvidenceMap = Record<string, EvidenceResult>;

interface MeterEditEvaluation {
  sourceEvidence: DeviceEvidenceMap;
  currentEvidence: DeviceEvidenceMap;
  currentIsReference: boolean;
  evaluatedDeviceIds: string[];
}

type WorkstationAction =
  | { kind: "alleleSelection"; trackId: string; before: string[]; after: string[]; label: string }
  | { kind: "renameTrack"; trackId: string; before: string; after: string }
  | { kind: "editBatch"; trackId: string; editIds: string[]; label: string };

function workstationActionLabel(action?: WorkstationAction) {
  if (!action) return undefined;
  if (action.kind === "renameTrack") return `Rename track “${action.before}” → “${action.after}”`;
  return action.label;
}

type ExportKind = "trackVcf" | "focusFasta";

interface ExportRequest {
  id: number;
  kind: ExportKind;
}

type HistoryDirection = "undo" | "redo";

interface HistoryRequest {
  id: number;
  direction: HistoryDirection;
}

interface WorkstationHistoryState {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
}

const EMPTY_HISTORY_STATE: WorkstationHistoryState = {
  canUndo: false,
  canRedo: false
};

function sameVariant(left: EffectiveVariant["key"], right: EffectiveVariant["key"]) {
  return left.assembly === right.assembly
    && left.contig === right.contig
    && left.position === right.position
    && left.reference === right.reference
    && left.alternate === right.alternate;
}

function isTransitionSubstitution(reference: string, alternate: string) {
  const pair = `${reference.toUpperCase()}${alternate.toUpperCase()}`;
  return pair === "AG" || pair === "GA" || pair === "CT" || pair === "TC";
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
      mode: "saturation",
      objectiveId: "predictedImpactBurden",
      direction: "minimize",
      weights: { impact: 70, clinvar: 0, sourceEvidence: 0 },
      maxEdits: 5
    },
    message: "Ready to compare live-evaluated non-reference SNV candidates.",
    rackOrder: 50,
    target: "focusedRegion",
    resource: "Selected alleles and live Evidence devices",
    limitation: "Nearby allele scores remain independent; this device does not infer a combined biological effect."
  };
}

function defaultRandomizer(): AlleleRandomizerDevice {
  return {
    id: DEVICE_IDS.randomizer,
    name: "Mutation Generator",
    bypassed: false,
    status: "ready",
    settings: { mode: "randomizer", amount: 100, seed: 42, substitutionPattern: "uniform", transitionProbability: 67 },
    message: "Select visible VCF alleles, preview the changes, then apply them as reversible blocks.",
    rackOrder: 5,
    limitation: "Randomization is not a biological prediction. Version 1 changes canonical SNVs only and each result must be evaluated independently."
  };
}

function sameOptimizerSettings(left: GenomeOptimizerSettings, right: GenomeOptimizerSettings) {
  return left.mode === right.mode
    && left.objectiveId === right.objectiveId
    && left.direction === right.direction
    && left.maxEdits === right.maxEdits
    && left.weights.impact === right.weights.impact
    && left.weights.clinvar === right.weights.clinvar
    && left.weights.sourceEvidence === right.weights.sourceEvidence;
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

function Onboarding({ projectTemplate, onOpened }: { projectTemplate: ProjectTemplateId; onOpened: (path: string, snapshot: ProjectSnapshot, created: boolean) => void }) {
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
        setStatus("Register the b37 reference and Evidence resources, then choose a VCF.");
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
  ): Promise<VcfInspection> {
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
      `${options?.example ? "Example ready · " : ""}${result.supportedRecordCount.toLocaleString()} supported small-variant records of ${result.recordCount.toLocaleString()} total · ${result.samples.length.toLocaleString()} ${result.samples.length === 1 ? "sample" : "samples"} · input INFO annotations will be ignored`
    );
    return result;
  }

  async function loadExample() {
    setBusy(true);
    setStatus("Opening the synthetic two-chromosome example…");
    try {
      const [example, resourceBundle] = await Promise.all([
        api.exampleFixture(),
        bundle ? Promise.resolve(bundle) : api.suggestedBundle()
      ]);
      setBundle(resourceBundle);
      setBundleText(JSON.stringify(resourceBundle, null, 2));
      const result = await inspectSelectedVcf(example.path, {
        preferredSample: example.sample,
        projectName: example.projectName,
        projectPath: example.projectPath,
        example: true
      });
      if (!result.biallelic || result.supportedRecordCount === 0 || !result.samples.includes(example.sample)) {
        throw new Error("The bundled example does not satisfy the DGW input contract.");
      }
      setStatus("Creating the example project…");
      const snapshot = await api.createProject({
        projectPath: example.projectPath,
        name: example.projectName,
        sourceVcfPath: example.path,
        selectedSample: example.sample,
        resourceBundle
      });
      onOpened(example.projectPath, snapshot, true);
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
      onOpened(projectPath, snapshot, true);
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
      onOpened(selected, await api.openProject(selected), false);
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
          <div><p className="eyebrow">Start a project</p><h2>Load a genome</h2><small>{projectTemplate === "standardEvidence" ? "DGW Starter template" : "Empty template"}</small></div>
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
            <label>Normalized biallelic VCF with SNVs/indels</label>
            <div className="file-choice-row">
              <button className="file-picker" onClick={chooseVcf} disabled={busy}>
                <span>{sourcePath || "Choose .vcf or .vcf.gz"}</span><b>Browse</b>
              </button>
              <button className="button secondary load-example" onClick={loadExample} disabled={busy}>{busy ? "Opening…" : "Open example"}</button>
            </div>
            <small className="fixture-note">Annotations are optional. DGW ignores imported INFO annotations and evaluates selected alleles with the configured resources.</small>
            <small className="fixture-note">10 synthetic variants · chr7 + chr17 · fictional sample DGW_DEMO</small>
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
  const annotationRows = snpeffEvidence?.status === "found" ? snpeffEvidence.records : [];
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
        <span>Live SnpEff prediction</span>
        <b>{consequence || (snpeffEvidence?.status === "noExactMatch" ? "No exact result" : snpeffEvidence ? evidenceSummary(snpeffEvidence) : "No live result yet")}</b>
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
  exportRequest,
  historyRequest,
  deviceBrowserRequest,
  initialAppliedDeviceIds = dgwStarterDeviceIds,
  onHistoryStateChange
}: {
  projectPath: string;
  snapshot: ProjectSnapshot;
  setSnapshot: (snapshot: ProjectSnapshot) => void;
  settings: UserSettings;
  exportRequest?: ExportRequest;
  historyRequest?: HistoryRequest;
  deviceBrowserRequest?: number;
  initialAppliedDeviceIds?: string[];
  onHistoryStateChange: (state: WorkstationHistoryState) => void;
}) {
  const initial = snapshot.workspace.focus ?? (snapshot.variants[0] ? {
    contig: snapshot.variants[0].key.contig,
    start: Math.max(1, snapshot.variants[0].key.position - 35),
    end: snapshot.variants[0].key.position + 35
  } : { contig: "1", start: 1, end: 80 });
  const [context, setContext] = useState<FocusContext>(initial);
  const [focus, setFocus] = useState<FocusView>();
  const [contigDensity, setContigDensity] = useState<VariantDensity>();
  const [selected, setSelected] = useState<EffectiveVariant>();
  const [selectedAlleleIds, setSelectedAlleleIds] = useState<string[]>([]);
  const selectedAlleleIdsRef = useRef<string[]>([]);
  const [symbolicSelection, setSymbolicSelection] = useState<{
    selection: VariantSelection;
    total: number;
  }>();
  const suppressOptimizerSelectionStaleRef = useRef(false);
  const [undoActions, setUndoActions] = useState<WorkstationAction[]>([]);
  const [redoActions, setRedoActions] = useState<WorkstationAction[]>([]);
  const [evaluation, setEvaluation] = useState<EvaluationResult>();
  const [deviceManifests, setDeviceManifests] = useState<DeviceManifest[]>([]);
  const [deviceEvaluations, setDeviceEvaluations] = useState<Record<string, EvidenceResult>>({});
  const [selectedEvaluationRevision, setSelectedEvaluationRevision] = useState(0);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>(DEVICE_IDS.snpeff);
  const [runningDeviceId, setRunningDeviceId] = useState<string>();
  const [bypassedDevicesByTrack, setBypassedDevicesByTrack] = useState<Record<string, string[]>>({});
  const [appliedDevicesByTrack, setAppliedDevicesByTrack] = useState<Record<string, string[]>>(() => Object.fromEntries(
    snapshot.tracks.map((track) => [track.id, [...initialAppliedDeviceIds]])
  ));
  const [trackDeck, setTrackDeck] = useState<GenomeTrackLane[]>([]);
  const [variantListScrollTop, setVariantListScrollTop] = useState(0);
  const [variantListHeight, setVariantListHeight] = useState(600);
  const variantListRef = useRef<HTMLDivElement>(null);
  const [selectedEditId, setSelectedEditId] = useState<string>();
  const [hiddenTrackIds, setHiddenTrackIds] = useState<string[]>([]);
  const [optimizers, setOptimizers] = useState<Record<string, GenomeOptimizerDevice>>({});
  const [randomizers, setRandomizers] = useState<Record<string, AlleleRandomizerDevice>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("Ready");
  const [detailMode, setDetailMode] = useState<"devices" | "allele">("devices");
  const [meterEvaluations, setMeterEvaluations] = useState<Record<string, Record<string, MeterEditEvaluation>>>({});
  const [trackProfilerRuns, setTrackProfilerRuns] = useState<Record<string, TrackProfilerModel>>({});
  const evaluationGeneration = useRef(0);
  const selectedAlleleEvidenceCache = useRef<SelectedAlleleEvidenceCache>(new Map());
  const evidenceRequests = useRef<Map<string, Promise<EvidenceResult>>>(new Map());
  const automaticEvaluationTimer = useRef<number | undefined>(undefined);
  const focusRefreshGeneration = useRef(0);
  const viewportRefreshTimer = useRef<number | undefined>(undefined);
  const handledExportRequest = useRef(0);
  const handledHistoryRequest = useRef(0);
  const handledDeviceBrowserRequest = useRef(0);
  const sourceTrackVariants = trackDeck.find((lane) => lane.track.readOnly)?.variants;
  const navigationVariants = sourceTrackVariants ?? snapshot.variants;
  const navigationEntries = useMemo(
    () => buildVariantNavigationEntries(navigationVariants),
    [navigationVariants]
  );
  const firstRenderedVariant = Math.max(0, Math.floor(variantListScrollTop / VARIANT_ROW_HEIGHT) - VARIANT_LIST_OVERSCAN);
  const renderedVariantCount = Math.ceil(variantListHeight / VARIANT_ROW_HEIGHT) + VARIANT_LIST_OVERSCAN * 2;
  const lastRenderedVariant = Math.min(navigationEntries.length, firstRenderedVariant + renderedVariantCount);
  const renderedNavigationEntries = navigationEntries.slice(firstRenderedVariant, lastRenderedVariant);
  const activeTrack = focus?.activeTrack ?? snapshot.activeTrack;
  const activeBypassedDevices = bypassedDevicesByTrack[activeTrack.id] ?? [];
  const activeAppliedDevices = appliedDevicesByTrack[activeTrack.id] ?? initialAppliedDeviceIds;
  const activeBypassedDeviceSet = useMemo(
    () => new Set(activeBypassedDevices),
    [activeBypassedDevices]
  );
  const activeAppliedDeviceSet = useMemo(
    () => new Set(activeAppliedDevices),
    [activeAppliedDevices]
  );
  const activeOptimizerSettings = (optimizers[activeTrack.id] ?? defaultOptimizer(activeTrack.id)).settings;
  const activeScoringObjective = optimizerObjectives.find((objective) => objective.id === activeOptimizerSettings.objectiveId);

  useEffect(() => {
    if (!deviceBrowserRequest || deviceBrowserRequest === handledDeviceBrowserRequest.current) return;
    handledDeviceBrowserRequest.current = deviceBrowserRequest;
    setDetailMode("devices");
  }, [deviceBrowserRequest]);

  useEffect(() => {
    const list = variantListRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setVariantListHeight(list.clientHeight));
    observer.observe(list);
    setVariantListHeight(list.clientHeight);
    return () => observer.disconnect();
  }, []);
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
        const scoringInput = optimizerWeights.find((input) => input.sourceDeviceId === manifest.id)
          ?? { id: manifest.id, sourceDeviceId: manifest.id };
        const inputState = scoringInputState(activeScoringObjective, scoringInput, activeBypassedDeviceSet);
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
          runLabel: evidence ? "Refresh" : "Run now",
          scoreInclusion: activeTrack.readOnly ? undefined : inputState === "excluded" ? "excluded" : "included"
        } satisfies RackDeviceView;
      });
  }, [activeBypassedDeviceSet, activeScoringObjective, activeTrack.readOnly, deviceManifests, evidenceByDevice, runningDeviceId, selected, snapshot.manifest.resourceBundle]);
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
          bypassedScoringDeviceIds: bypassedDevicesByTrack[lane.track.id] ?? [],
          appliedScoringDeviceIds: appliedDevicesByTrack[lane.track.id] ?? initialAppliedDeviceIds,
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
  }, [appliedDevicesByTrack, bypassedDevicesByTrack, context.contig, context.end, context.start, deviceManifests, hiddenTrackIds, optimizers, randomizers, trackDeck]);
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
    const deviceCoverage = alleleDeviceIds.filter((deviceId) => activeAppliedDeviceSet.has(deviceId)).map((deviceId) => {
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
        }, 0),
        bypassed: activeBypassedDeviceSet.has(deviceId)
      };
    });
    const snpeffEnabled = activeAppliedDeviceSet.has(DEVICE_IDS.snpeff) && !activeBypassedDeviceSet.has(DEVICE_IDS.snpeff);
    const optimizer = optimizers[activeTrack.id];
    const optimizerResult = optimizer?.result;
    const optimizerEditIds = new Set(optimizer?.generatedEditIds ?? []);
    const activeOptimizerEdits = [...optimizerEditIds]
      .filter((editId) => !activeTrack.bypassedEditIds.includes(editId)).length;
    return {
      evaluatedMutations: snpeffEnabled ? evaluatedItems.length : 0,
      activeMutations: activeItems.length,
      impactDelta: snpeffEnabled && evaluatedItems.length === activeItems.length && activeItems.length > 0
        ? evaluatedItems.reduce((sum, item) => sum + (item.impactDelta ?? 0), 0)
        : undefined,
      deviceCoverage,
      items,
      appliedRun: optimizerResult ? {
        device: optimizer?.name ?? "Genome Optimizer",
        mode: optimizer?.settings.mode === "saturation" ? "Saturation" : "Conservative",
        direction: optimizer?.settings.direction ?? "minimize",
        active: !optimizer?.bypassed && activeOptimizerEdits > 0,
        consideredPositions: optimizerResult.consideredPositions
          ?? new Set(optimizerResult.candidateComparisons?.map((candidate) => `${candidate.contig}:${candidate.position}`) ?? []).size,
        evaluatedCandidates: optimizerResult.evaluatedCandidates
          ?? optimizerResult.candidateComparisons?.length
          ?? 0,
        generatedEdits: optimizerResult.generatedEdits,
        changedPositions: optimizerResult.changedPositions ?? optimizerResult.generatedEdits,
        activeEdits: activeOptimizerEdits,
        beforeScore: optimizerResult.beforeScore,
        afterScore: optimizerResult.afterScore,
        scoreUnit: optimizerResult.scoreUnit
      } : undefined
    };
  }, [activeAppliedDeviceSet, activeBypassedDeviceSet, activeTrack, meterEvaluations, optimizers, trackDeck]);
  const activeAnalyzerDeviceIds = alleleDeviceIds.filter((deviceId) => activeAppliedDeviceSet.has(deviceId) && !activeBypassedDeviceSet.has(deviceId));
  const activeAnalyzerCount = activeAnalyzerDeviceIds.length;
  const storedTrackProfiler = trackProfilerRuns[activeTrack.id];
  const trackProfiler: TrackProfilerModel = storedTrackProfiler
    && (storedTrackProfiler.status === "running"
      || (storedTrackProfiler.totalMutations === trackMeter.activeMutations
        && storedTrackProfiler.activeAnalyzers === activeAnalyzerCount
        && (storedTrackProfiler.activeDeviceIds ?? []).length === activeAnalyzerDeviceIds.length
        && (storedTrackProfiler.activeDeviceIds ?? []).every((deviceId, index) => deviceId === activeAnalyzerDeviceIds[index])))
    ? storedTrackProfiler
    : {
      status: "idle",
      processedMutations: 0,
      totalMutations: trackMeter.activeMutations,
      activeAnalyzers: activeAnalyzerCount,
      activeDeviceIds: activeAnalyzerDeviceIds,
      message: trackMeter.activeMutations === 0
        ? "Add mutation blocks to profile this track."
        : "Run applied Evidence devices across every active mutation."
    };

  function trackEvidenceDeviceIds(trackId: string) {
    const applied = new Set(appliedDevicesByTrack[trackId] ?? initialAppliedDeviceIds);
    const bypassed = new Set(bypassedDevicesByTrack[trackId] ?? []);
    return alleleDeviceIds.filter((deviceId) => applied.has(deviceId) && !bypassed.has(deviceId));
  }
  useEffect(() => {
    api.deviceCatalog()
      .then(setDeviceManifests)
      .catch((error) => setNotice(`Device catalog unavailable: ${messageOf(error)}`));
  }, []);

  useEffect(() => {
    if (trackDeck.length === 0) return;
    setAppliedDevicesByTrack((current) => {
      let changed = false;
      const next = { ...current };
      for (const lane of trackDeck) {
        if (next[lane.track.id] === undefined) {
          next[lane.track.id] = [...initialAppliedDeviceIds];
          changed = true;
        }
      }
      return changed ? next : current;
    });
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
    if (!symbolicSelection) return;
    const lane = trackDeck.find(
      (item) => item.track.id === symbolicSelection.selection.trackId
    );
    if (!lane) return;
    const visibleIds = lane.variants.map(alleleId);
    selectedAlleleIdsRef.current = visibleIds;
    setSelectedAlleleIds(visibleIds);
  }, [symbolicSelection, trackDeck]);

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

  useEffect(() => {
    if (suppressOptimizerSelectionStaleRef.current) {
      suppressOptimizerSelectionStaleRef.current = false;
      return;
    }
    setOptimizers((current) => {
      const device = current[activeTrack.id];
      if (!device || device.settings.mode !== "saturation" || !device.result?.candidateComparisons?.length) return current;
      return {
        ...current,
        [activeTrack.id]: {
          ...device,
          status: "stale",
          result: undefined,
          message: "The selected positions or track state changed. Run Saturation again."
        }
      };
    });
  }, [activeTrack.id, selectedAlleleIds]);

  function sameAlleleSelection(left: string[], right: string[]) {
    return left.length === right.length && left.every((id, index) => id === right[index]);
  }

  function recordAction(action: WorkstationAction) {
    setUndoActions((current) => [...current, action].slice(-100));
    setRedoActions([]);
  }

  function setAlleleSelection(
    nextIds: string[],
    label: string,
    record = true,
    preserveSymbolicSelection = false
  ) {
    if (!preserveSymbolicSelection) setSymbolicSelection(undefined);
    const next = [...new Set(nextIds)];
    const before = selectedAlleleIdsRef.current;
    if (sameAlleleSelection(before, next)) return false;
    if (record) {
      recordAction({
        kind: "alleleSelection",
        trackId: activeTrack.id,
        before: [...before],
        after: [...next],
        label
      });
    }
    selectedAlleleIdsRef.current = next;
    setSelectedAlleleIds(next);
    return true;
  }

  function resetAlleleSelection(nextIds: string[]) {
    setAlleleSelection(nextIds, "", false);
    setUndoActions((current) => current.filter((action) => action.kind !== "alleleSelection"));
    setRedoActions((current) => current.filter((action) => action.kind !== "alleleSelection"));
  }

  function invalidateSelectedAlleleEvaluation() {
    evaluationGeneration.current += 1;
    setSelectedEvaluationRevision((revision) => revision + 1);
    if (automaticEvaluationTimer.current !== undefined) {
      window.clearTimeout(automaticEvaluationTimer.current);
      automaticEvaluationTimer.current = undefined;
    }
  }

  function restoreSelection(ids: string[]) {
    invalidateSelectedAlleleEvaluation();
    setAlleleSelection(ids, "", false);
    setSelectedEditId(undefined);
    setDetailMode("devices");
    const lane = trackDeck.find((item) => item.track.id === activeTrack.id);
    const last = [...ids].reverse().map((id) => lane?.variants.find((variant) => alleleId(variant) === id)).find(Boolean);
    if (last) setSelected(last);
  }

  async function applyHistoryAction(action: WorkstationAction, direction: "undo" | "redo") {
    if (action.kind === "alleleSelection") {
      restoreSelection(direction === "undo" ? action.before : action.after);
      setNotice(`${direction === "undo" ? "Undid" : "Redid"} ${action.label.toLowerCase()}`);
      return;
    }
    if (action.kind === "editBatch") {
      const bypassed = direction === "undo";
      const nextSnapshot = await api.setTrackEditsBypass(projectPath, action.trackId, action.editIds, bypassed);
      setSnapshot(nextSnapshot);
      setEvaluation(undefined);
      setDeviceEvaluations({});
      setSelectedEditId(undefined);
      await refresh(context);
      setNotice(`${direction === "undo" ? "Undid" : "Redid"} ${action.label.toLowerCase()} · ${action.editIds.length} ${action.editIds.length === 1 ? "block" : "blocks"}`);
      return;
    }
    const name = direction === "undo" ? action.before : action.after;
    const nextSnapshot = await api.renameTrack(projectPath, action.trackId, name);
    setSnapshot(nextSnapshot);
    await refresh(context);
    setNotice(`${direction === "undo" ? "Undid" : "Redid"} track rename · ${name}`);
  }

  async function undoLastAction() {
    const action = undoActions.at(-1);
    if (!action || busy) return;
    setBusy(true);
    try {
      await applyHistoryAction(action, "undo");
      setUndoActions((current) => current.slice(0, -1));
      setRedoActions((current) => [...current, action]);
    } catch (error) {
      setNotice(`Undo failed: ${messageOf(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function redoLastAction() {
    const action = redoActions.at(-1);
    if (!action || busy) return;
    setBusy(true);
    try {
      await applyHistoryAction(action, "redo");
      setRedoActions((current) => current.slice(0, -1));
      setUndoActions((current) => [...current, action]);
    } catch (error) {
      setNotice(`Redo failed: ${messageOf(error)}`);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    onHistoryStateChange({
      canUndo: !busy && undoActions.length > 0,
      canRedo: !busy && redoActions.length > 0,
      undoLabel: workstationActionLabel(undoActions.at(-1)),
      redoLabel: workstationActionLabel(redoActions.at(-1))
    });
  }, [busy, onHistoryStateChange, redoActions, undoActions]);

  useEffect(() => {
    if (!historyRequest || historyRequest.id === handledHistoryRequest.current) return;
    handledHistoryRequest.current = historyRequest.id;
    if (historyRequest.direction === "undo") {
      void undoLastAction();
    } else {
      void redoLastAction();
    }
  }, [historyRequest]);

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
    let view: FocusView | undefined;
    let lanes: GenomeTrackLane[] | undefined;
    const loadErrors: string[] = [];
    try {
      // Tracks are a primary workspace surface. Load them independently and first
      // so a stale or invalid saved focus cannot leave the project looking empty.
      if (reloadTracks) {
        try {
          lanes = await api.trackDeck(projectPath, nextContext);
          if (generation !== focusRefreshGeneration.current) return;
          setTrackDeck(lanes);
        } catch (error) {
          loadErrors.push(`Tracks unavailable: ${messageOf(error)}`);
        }
      }

      try {
        view = await api.focusRegion(projectPath, nextContext);
        if (generation !== focusRefreshGeneration.current) return;
        setFocus(view);
        setContext(nextContext);
        if (selected) {
          const refreshedSelection = view.variants.find((item) => item.key.assembly === selected.key.assembly && variantLabel(item.key) === variantLabel(selected.key));
          if (refreshedSelection) setSelected(refreshedSelection);
        } else {
          setSelected(view.variants[0]);
        }
      } catch (error) {
        loadErrors.push(`Focused region unavailable: ${messageOf(error)}`);
      }

      if (generation !== focusRefreshGeneration.current) return;
      setNotice(loadErrors.length > 0 ? loadErrors.join(" · ") : "Focused region is up to date");
      return { view, lanes };
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
      void refresh(nextContext, { background: true, reloadTracks: true });
    }, 160);
  }

  useEffect(() => {
    void refresh(initial);
  }, []);

  useEffect(() => {
    const contigLength = focus?.contigLength;
    if (!contigLength || !activeTrack.id) {
      setContigDensity(undefined);
      return;
    }
    let cancelled = false;
    void api.variantDensity(projectPath, activeTrack.id, {
      contig: focus.context.contig,
      start: 1,
      end: contigLength
    }).then((density) => {
      if (!cancelled) setContigDensity(density);
    }).catch(() => {
      if (!cancelled) setContigDensity(undefined);
    });
    return () => { cancelled = true; };
  }, [activeTrack.id, focus?.context.contig, focus?.contigLength, projectPath]);

  function openDensityBin(start: number, end: number) {
    const contigLength = focus?.contigLength ?? end;
    const currentSpan = Math.max(1, context.end - context.start + 1);
    const span = Math.min(50_000, Math.max(1_000, currentSpan));
    const center = Math.floor((start + end) / 2);
    const nextStart = Math.max(1, Math.min(center - Math.floor(span / 2), contigLength - span + 1));
    const nextContext = {
      contig: context.contig,
      start: nextStart,
      end: Math.min(contigLength, nextStart + span - 1)
    };
    void refresh(nextContext);
  }

  useEffect(() => () => {
    if (viewportRefreshTimer.current !== undefined) {
      window.clearTimeout(viewportRefreshTimer.current);
    }
    if (automaticEvaluationTimer.current !== undefined) {
      window.clearTimeout(automaticEvaluationTimer.current);
    }
  }, []);

  async function focusVariant(variant: EffectiveVariant) {
    invalidateSelectedAlleleEvaluation();
    setSelected(variant);
    resetAlleleSelection([alleleId(variant)]);
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
      if (createdEditId) {
        recordAction({ kind: "editBatch", trackId: activeTrack.id, editIds: [createdEditId], label: "Apply mutation" });
      }
      let mutationCount: number | undefined;
      let profiledAutomatically = false;
      if (createdEditId && refreshed?.lanes) {
        const lane = refreshed.lanes.find((item) => item.track.id === nextSnapshot.activeTrack.id);
        mutationCount = lane?.edits.length;
        const createdVariant = lane && variantForTrackEdit(lane, createdEditId);
        if (createdVariant) setSelected(createdVariant);
        if (createdVariant) resetAlleleSelection([alleleId(createdVariant)]);
        setSelectedEditId(createdEditId);
        if (lane && trackEvidenceDeviceIds(nextSnapshot.activeTrack.id).length > 0) {
          await analyzeTrack(nextSnapshot.activeTrack.id, lane, "automatic");
          profiledAutomatically = true;
        }
      }
      setDetailMode("allele");
      if (!createdEditId || !profiledAutomatically) {
        setNotice(`Mutation state${mutationCount ? ` ${mutationCount}` : ""} added to ${nextSnapshot.activeTrack.name}`);
      }
    } catch (error) {
      setNotice(messageOf(error));
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function selectTrack(trackId: string) {
    if (trackId === activeTrack.id) return;
    invalidateSelectedAlleleEvaluation();
    setBusy(true);
    try {
      const nextSnapshot = await api.selectTrack(projectPath, trackId);
      setSnapshot(nextSnapshot);
      setEvaluation(undefined);
      setDeviceEvaluations({});
      setSelectedEditId(undefined);
      resetAlleleSelection([]);
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

  async function openTrackAllele(trackId: string, id: string, additive = false) {
    const lane = trackDeck.find((item) => item.track.id === trackId);
    const variant = lane?.variants?.find((item) => alleleId(item) === id);
    if (!variant) {
      setNotice("That allele is no longer present on this track");
      return;
    }
    if (trackId !== activeTrack.id) await selectTrack(trackId);
    if (additive) {
      invalidateSelectedAlleleEvaluation();
      setSelected(variant);
      setSelectedEditId(undefined);
      setEvaluation(undefined);
      setDeviceEvaluations({});
      setDetailMode("devices");
      setSelectedDeviceId(DEVICE_IDS.randomizer);
      const current = selectedAlleleIdsRef.current;
      const alreadySelected = current.includes(id);
      setAlleleSelection(
        alreadySelected ? current.filter((candidate) => candidate !== id) : [...current, id],
        alreadySelected ? "Remove variant from selection" : "Add variant to selection"
      );
      setNotice(`Updated multi-selection at ${variant.key.contig}:${variant.key.position.toLocaleString()}`);
      return;
    }
    invalidateSelectedAlleleEvaluation();
    setSelected(variant);
    setAlleleSelection([id], "Select variant");
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
    invalidateSelectedAlleleEvaluation();
    setSelected(variant);
    resetAlleleSelection([alleleId(variant)]);
    setSelectedEditId(editId);
    setEvaluation(undefined);
    setDeviceEvaluations({});
    setDetailMode("allele");
    setNotice(`Opened mutation block on ${lane.track.name}`);
  }

  function selectAllVisibleAlleles(trackId: string) {
    invalidateSelectedAlleleEvaluation();
    const track = trackModels.find((item) => item.id === trackId);
    const ids = track?.alleles.map((allele) => allele.id) ?? [];
    setAlleleSelection(ids, "Select all visible variants");
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

  async function selectAllTrackAlleles(trackId: string) {
    invalidateSelectedAlleleEvaluation();
    const lane = trackDeck.find((item) => item.track.id === trackId);
    const variants = lane?.variants ?? [];
    const ids = variants.map(alleleId);
    const selection: VariantSelection = { kind: "allTrack", trackId, exclusions: [] };
    setBusy(true);
    try {
      const resolution = await api.resolveVariantSelection(projectPath, selection, 1);
      setSymbolicSelection({ selection, total: resolution.total });
      setAlleleSelection(ids, "Select all variants in track", true, true);
      setSelectedEditId(undefined);
      setDetailMode("devices");
      setSelectedDeviceId(DEVICE_IDS.randomizer);
      if (variants[0]) setSelected(variants[0]);
      setNotice(resolution.total === 0
        ? "This track has no active VCF alleles"
        : `Selected all ${resolution.total.toLocaleString()} active VCF alleles in this track · device run limits are checked before generation`);
    } catch (error) {
      setNotice(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function selectedVariantKeysForDevice(trackId: string, limit: number, deviceName: string) {
    if (symbolicSelection && symbolicSelection.selection.trackId === trackId) {
      const resolution = await api.resolveVariantSelection(
        projectPath,
        symbolicSelection.selection,
        limit
      );
      if (resolution.truncated) {
        throw new Error(
          `${resolution.total.toLocaleString()} alleles are selected. ${deviceName} accepts at most ${limit.toLocaleString()} positions per run; narrow the selection.`
        );
      }
      return resolution.variants;
    }
    const lane = trackDeck.find((item) => item.track.id === trackId);
    const selectedSet = new Set(selectedAlleleIdsRef.current);
    return (lane?.variants ?? [])
      .filter((variant) => selectedSet.has(alleleId(variant)))
      .map((variant) => variant.key);
  }

  function clearAlleleSelection() {
    setAlleleSelection([], "Clear variant selection");
    setSelectedEditId(undefined);
    setNotice("Allele selection cleared");
  }

  function marqueeSelectAlleles(trackId: string, ids: string[], additive: boolean) {
    const lane = trackDeck.find((item) => item.track.id === trackId);
    if (!lane) return;
    invalidateSelectedAlleleEvaluation();
    const next = additive ? [...new Set([...selectedAlleleIdsRef.current, ...ids])] : ids;
    setAlleleSelection(next, additive ? "Add marquee selection" : "Marquee selection");
    setSelectedEditId(undefined);
    setEvaluation(undefined);
    setDeviceEvaluations({});
    setDetailMode("devices");
    if (!lane.track.readOnly) setSelectedDeviceId(DEVICE_IDS.randomizer);
    const first = lane.variants.find((variant) => ids.includes(alleleId(variant)));
    if (first) setSelected(first);
    setNotice(ids.length === 0
      ? additive ? "No additional lollipops inside the marquee" : "Marquee selection cleared"
      : `${additive ? "Added" : "Selected"} ${ids.length} ${ids.length === 1 ? "variant" : "variants"} with the marquee`);
  }

  async function duplicateTrack(trackId: string) {
    const source = snapshot.tracks.find((track) => track.id === trackId);
    if (!source) return;
    const sourceAppliedDevices = appliedDevicesByTrack[trackId] ?? initialAppliedDeviceIds;
    const sourceBypassedDevices = bypassedDevicesByTrack[trackId] ?? [];
    const copyNumber = snapshot.tracks.filter((track) => !track.readOnly).length + 1;
    setBusy(true);
    try {
      const nextSnapshot = await api.duplicateTrack(projectPath, trackId, `${source.name} copy ${copyNumber}`);
      setSnapshot(nextSnapshot);
      setAppliedDevicesByTrack((current) => ({ ...current, [nextSnapshot.activeTrack.id]: [...sourceAppliedDevices] }));
      setBypassedDevicesByTrack((current) => ({ ...current, [nextSnapshot.activeTrack.id]: [...sourceBypassedDevices] }));
      if (optimizers[trackId]) {
        setOptimizers((current) => ({
          ...current,
          [nextSnapshot.activeTrack.id]: { ...optimizers[trackId], settings: { ...optimizers[trackId].settings, weights: { ...optimizers[trackId].settings.weights } } }
        }));
      }
      if (randomizers[trackId]) {
        setRandomizers((current) => ({
          ...current,
          [nextSnapshot.activeTrack.id]: { ...randomizers[trackId], settings: { ...randomizers[trackId].settings } }
        }));
      }
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
      recordAction({ kind: "renameTrack", trackId, before: stored.name, after: normalized });
      setNotice(`Renamed track to ${normalized}`);
    } catch (error) {
      setNotice(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function deleteTrack(trackId: string) {
    const track = snapshot.tracks.find((candidate) => candidate.id === trackId);
    if (!track) return;
    const confirmed = await confirmDialog(
      `Archive “${track.name}”? Its scientific ancestry remains in the project audit trail.`,
      { title: "Archive Genome Track", kind: "warning", okLabel: "Archive", cancelLabel: "Cancel" }
    );
    if (!confirmed) return;
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
      setAppliedDevicesByTrack((current) => {
        const next = { ...current };
        delete next[trackId];
        return next;
      });
      setBypassedDevicesByTrack((current) => {
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
    setOptimizers((current) => {
      const device = current[trackId] ?? defaultOptimizer(trackId);
      if (sameOptimizerSettings(device.settings, settings)) return current;
      return {
        ...current,
        [trackId]: {
          ...device,
          settings,
          status: "stale",
          result: undefined,
          message: "Controls changed. Generate a new bounded candidate."
        }
      };
    });
  }

  async function randomizerRequest(trackId: string, device: AlleleRandomizerDevice): Promise<RandomizerRequest> {
    return {
      selectedVariants: await selectedVariantKeysForDevice(trackId, 1_000, "Mutation Generator"),
      amount: device.settings.amount,
      seed: device.settings.seed,
      substitutionPattern: device.settings.substitutionPattern,
      transitionProbability: device.settings.transitionProbability
    };
  }

  function randomizerPreview(plan: RandomizerPlan) {
    const changes = new Map<string, { position: number; from: string; to: string; substitutionClass: "transition" | "transversion" }>();
    for (const proposal of plan.proposals) {
      const key = `${proposal.sourceVariant.contig}:${proposal.sourceVariant.position}:${proposal.sourceVariant.alternate}:${proposal.replacementVariant.alternate}`;
      changes.set(key, {
        position: proposal.sourceVariant.position,
        from: proposal.sourceVariant.alternate,
        to: proposal.replacementVariant.alternate,
        substitutionClass: isTransitionSubstitution(proposal.sourceVariant.reference, proposal.replacementVariant.alternate) ? "transition" : "transversion"
      });
    }
    return {
      selectedPositions: plan.selectedPositions,
      randomizedPositions: plan.randomizedPositions,
      transitionPositions: plan.transitionPositions,
      transversionPositions: plan.transversionPositions,
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
      const plan = await api.previewRandomizer(projectPath, trackId, await randomizerRequest(trackId, device));
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
      const result = await api.runRandomizer(projectPath, trackId, await randomizerRequest(trackId, device));
      setSnapshot(result.snapshot);
      if (result.generatedEditIds.length > 0) {
        recordAction({
          kind: "editBatch",
          trackId,
          editIds: result.generatedEditIds,
          label: `Randomize ${result.plan.randomizedPositions} ${result.plan.randomizedPositions === 1 ? "position" : "positions"}`
        });
      }
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
      resetAlleleSelection([]);
      setSelectedEditId(result.generatedEditIds.at(-1));
      setEvaluation(undefined);
      setDeviceEvaluations({});
      const refreshed = await refresh(context);
      const lane = refreshed?.lanes?.find((item) => item.track.id === trackId);
      if (result.generatedEditIds.length > 0 && lane && trackEvidenceDeviceIds(trackId).length > 0) {
        await analyzeTrack(trackId, lane, "automatic");
      } else {
        setNotice(`Mutation Generator added ${result.generatedEditIds.length} reversible mutation blocks in Randomizer mode`);
      }
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
      const nextSnapshot = await api.setTrackEditsBypass(projectPath, trackId, device.generatedEditIds, bypassed);
      setSnapshot(nextSnapshot);
      setRandomizers((current) => ({ ...current, [trackId]: { ...(current[trackId] ?? device), bypassed } }));
      await refresh(context);
      setNotice(`${bypassed ? "Bypassed" : "Enabled"} Mutation Generator mutation blocks`);
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
      const nextSnapshot = await api.setTrackEditsBypass(projectPath, trackId, device.generatedEditIds, bypassed);
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
    const lane = trackDeck.find((item) => item.track.id === trackId);
    let selectedVariants: VariantKey[];
    try {
      selectedVariants = await selectedVariantKeysForDevice(trackId, 100, "Genome Optimizer");
    } catch (error) {
      setNotice(messageOf(error));
      return;
    }
    if (device.settings.mode === "saturation" && device.generatedEditIds?.length) {
      const previousIds = new Set(device.generatedEditIds);
      const previousReplacements = new Map(
        (lane?.edits ?? [])
          .filter((operation) => previousIds.has(operation.id) && operation.edit.kind === "setAllele" && operation.edit.sourceKey)
          .map((operation) => {
            const edit = operation.edit as Extract<EditKind, { kind: "setAllele" }>;
            return [variantKeyId(edit.key), edit.sourceKey!] as const;
          })
      );
      selectedVariants = selectedVariants.map((key) => previousReplacements.get(variantKeyId(key)) ?? key);
    }
    const activeEvidenceDeviceIds = trackEvidenceDeviceIds(trackId);
    if (selectedVariants.length === 0) {
      setNotice("Select at least one active allele before running Genome Optimizer.");
      return;
    }
    if (device.settings.mode === "saturation" && !activeEvidenceDeviceIds.includes(DEVICE_IDS.snpeff)) {
      setNotice("Saturation requires an applied, active SnpEff device.");
      return;
    }
    if ((device.settings.mode === "saturation" || device.settings.direction === "maximize")
      && !activeEvidenceDeviceIds.includes(DEVICE_IDS.clinvar)) {
      setNotice("This optimizer run requires an applied, active ClinVar device for the fixed Pathogenic/Likely pathogenic guard.");
      return;
    }
    setOptimizers((current) => ({
      ...current,
      [trackId]: {
        ...(current[trackId] ?? defaultOptimizer(trackId)),
        status: "running",
        message: device.settings.mode === "saturation"
          ? `Evaluating three possible non-reference bases at ${selectedVariants.length} selected ${selectedVariants.length === 1 ? "position" : "positions"}…`
          : "Preparing a bounded candidate from source-sample alleles…"
      }
    }));
    setBusy(true);
    setNotice(device.settings.mode === "saturation"
      ? `Genome Optimizer is annotating up to ${selectedVariants.length * 3} candidate alleles…`
      : "Genome Optimizer is scoring independent source alleles…");
    try {
      if (device.generatedEditIds?.length) {
        await api.setTrackEditsBypass(projectPath, trackId, device.generatedEditIds, true);
      }
      const settings = device.settings;
      const objective = optimizerObjectives.find((item) => item.id === (settings.mode === "saturation"
        ? "predictedImpactBurden"
        : settings.objectiveId));
      const effectiveWeights = effectiveScoringWeights(
        settings.weights,
        objective,
        optimizerWeights,
        new Set(bypassedDevicesByTrack[trackId] ?? []),
        new Set(appliedDevicesByTrack[trackId] ?? initialAppliedDeviceIds)
      );
      const request: OptimizerRequest = {
        mode: settings.mode,
        objective: settings.mode === "saturation"
          ? "predictedImpactBurden"
          : settings.objectiveId as OptimizerRequest["objective"],
        direction: settings.direction,
        maxEdits: selectedVariants.length > 0
          ? Math.min(settings.maxEdits, selectedVariants.length)
          : settings.maxEdits,
        weights: {
          impact: effectiveWeights.impact ?? 0,
          clinvar: 0,
          sourceEvidence: settings.mode === "saturation" ? 0 : effectiveWeights.sourceEvidence ?? 0
        },
        selectedVariants,
        evidenceDeviceIds: activeEvidenceDeviceIds
      };
      const result = await api.runOptimizer(projectPath, trackId, context, request);
      setSnapshot(result.snapshot);
      if (settings.mode === "saturation") {
        const appliedReplacements = new Map(
          result.plan.proposals
            .filter((proposal) => proposal.edit.kind === "setAllele")
            .map((proposal) => {
              const edit = proposal.edit as Extract<EditKind, { kind: "setAllele" }>;
              return [variantKeyId(proposal.sourceVariant), edit.key] as const;
            })
        );
        const nextSelection = [...new Set(selectedVariants.map((key) => variantKeyId(
          appliedReplacements.get(variantKeyId(key)) ?? key
        )))];
        if (!sameAlleleSelection(selectedAlleleIdsRef.current, nextSelection)) {
          suppressOptimizerSelectionStaleRef.current = true;
          selectedAlleleIdsRef.current = nextSelection;
          setSelectedAlleleIds(nextSelection);
        }
      }
      if (result.generatedEditIds.length > 0) {
        recordAction({
          kind: "editBatch",
          trackId,
          editIds: result.generatedEditIds,
          label: `Generate ${result.generatedEditIds.length} optimizer ${result.generatedEditIds.length === 1 ? "edit" : "edits"}`
        });
      }
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
            changedPositions: new Set(result.plan.proposals.map((proposal) => variantKeyId(proposal.sourceVariant))).size,
            consideredPositions: result.plan.consideredVariants,
            evaluatedCandidates: result.plan.candidateComparisons.length,
            beforeScore: result.plan.scoreBefore,
            afterScore: result.plan.scoreAfter,
            scoreUnit: "model units",
            summary: `${result.plan.scoreDescription} ${result.plan.limitation}`,
            candidateComparisons: result.plan.candidateComparisons.map((comparison) => ({
              contig: comparison.candidateVariant.contig,
              position: comparison.candidateVariant.position,
              reference: comparison.candidateVariant.reference,
              alternate: comparison.candidateVariant.alternate,
              current: comparison.current,
              selected: comparison.selected,
              comparable: comparison.comparable,
              impact: comparison.evidence.impactLabel,
              score: comparison.scoreComponents.objectiveScore,
              exactEvidenceSources: comparison.exactEvidenceSources,
              note: comparison.note
            }))
          }
        }
      }));
      setEvaluation(undefined);
      setDeviceEvaluations({});
      const refreshed = await refresh(context);
      const lane = refreshed?.lanes?.find((item) => item.track.id === trackId);
      if (result.generatedEditIds.length > 0 && lane && trackEvidenceDeviceIds(trackId).length > 0) {
        await analyzeTrack(trackId, lane, "automatic");
      } else {
        setNotice(result.plan.noOpReason ?? `Genome Optimizer added ${result.generatedEditIds.length} edit blocks`);
      }
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
    if (!track) return;
    const confirmed = await confirmDialog(
      `Consolidate the visible edits on “${track.name}” into its baseline? The audit history is retained.`,
      { title: "Consolidate Genome Track", kind: "warning", okLabel: "Consolidate", cancelLabel: "Cancel" }
    );
    if (!confirmed) return;
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
      setUndoActions((current) => current.filter((action) => action.kind !== "editBatch" || action.trackId !== trackId));
      setRedoActions((current) => current.filter((action) => action.kind !== "editBatch" || action.trackId !== trackId));
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
    } else {
      sourceEvidence = await collectDeviceEvidence(sourceKey, evaluatedDeviceIds, true);
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

  async function analyzeTrack(
    trackId: string,
    laneOverride?: GenomeTrackLane,
    trigger: "manual" | "automatic" = "manual"
  ) {
    const lane = laneOverride ?? trackDeck.find((item) => item.track.id === trackId);
    if (!lane) {
      setNotice("That genome track is not available");
      return;
    }
    const bypassedEdits = new Set(lane.track.bypassedEditIds);
    const operations = lane.edits.filter((operation) => !bypassedEdits.has(operation.id));
    const activeDeviceIds = trackEvidenceDeviceIds(trackId);
    if (operations.length === 0) {
      setNotice("This track has no active mutation blocks to analyze");
      return;
    }
    if (activeDeviceIds.length === 0) {
      setNotice("No active Evidence devices are applied to this track");
      return;
    }

    const totalMutations = operations.length;
    const activeAnalyzers = activeDeviceIds.length;
    const resultCache = new Map<string, Promise<DeviceEvidenceMap>>();
    const evaluateKey = (key: VariantKey) => {
      const cacheKey = `${activeDeviceIds.join(",")}:${key.assembly}:${key.contig}:${key.position}:${key.reference}:${key.alternate}`;
      const cached = resultCache.get(cacheKey);
      if (cached) return cached;
      const pending = activeDeviceIds.length === alleleDeviceIds.length
        ? api.evaluate(projectPath, key).then(evaluationEvidence)
        : Promise.all(activeDeviceIds.map(async (deviceId) => [
          deviceId,
          await api.evaluateDevice(projectPath, key, deviceId)
        ] as const)).then(Object.fromEntries);
      resultCache.set(cacheKey, pending);
      return pending;
    };

    setBusy(true);
    setTrackProfilerRuns((current) => ({
      ...current,
      [trackId]: {
        status: "running",
        processedMutations: 0,
        totalMutations,
        activeAnalyzers,
        activeDeviceIds: [...activeDeviceIds],
        message: `${trigger === "automatic" ? "Changes applied · automatically starting" : "Starting"} ${activeAnalyzers} active Evidence ${activeAnalyzers === 1 ? "device" : "devices"} across ${totalMutations} mutations…`
      }
    }));
    setNotice(`${trigger === "automatic" ? "Changes applied · Track Profiler is automatically analyzing" : "Track Profiler is analyzing"} ${totalMutations} active mutations independently…`);

    let failures = 0;
    let lastFailure = "";
    for (const [index, operation] of operations.entries()) {
      const block = editBlock(lane, operation.id);
      setTrackProfilerRuns((current) => ({
        ...current,
        [trackId]: {
          status: "running",
          processedMutations: index,
          totalMutations,
          activeAnalyzers,
          activeDeviceIds: [...activeDeviceIds],
          message: `Analyzing ${block?.label ?? operation.id.slice(0, 8)} · ${index + 1} of ${totalMutations}`
        }
      }));
      try {
        const sourceKey = operation.edit.kind === "restoreReference"
          ? operation.edit.sourceKey
          : operation.edit.sourceKey ?? operation.edit.key;
        const currentIsReference = operation.edit.kind === "restoreReference";
        const currentVariant = variantForTrackEdit(lane, operation.id);
        if (!currentVariant) throw new Error("The effective edited allele is unavailable");
        const [sourceEvidence, currentEvidence] = await Promise.all([
          evaluateKey(sourceKey),
          currentIsReference ? Promise.resolve({} as DeviceEvidenceMap) : evaluateKey(currentVariant.key)
        ]);
        setMeterEvaluations((allTracks) => {
          const trackValues = allTracks[trackId] ?? {};
          const previous = trackValues[operation.id];
          return {
            ...allTracks,
            [trackId]: {
              ...trackValues,
              [operation.id]: {
                sourceEvidence: { ...(previous?.sourceEvidence ?? {}), ...sourceEvidence },
                currentEvidence: currentIsReference
                  ? {}
                  : { ...(previous?.currentEvidence ?? {}), ...currentEvidence },
                currentIsReference,
                evaluatedDeviceIds: [...new Set([...(previous?.evaluatedDeviceIds ?? []), ...activeDeviceIds])]
              }
            }
          };
        });
      } catch (error) {
        failures += 1;
        lastFailure = messageOf(error);
      }
      setTrackProfilerRuns((current) => ({
        ...current,
        [trackId]: {
          status: "running",
          processedMutations: index + 1,
          totalMutations,
          activeAnalyzers,
          activeDeviceIds: [...activeDeviceIds],
          message: `Analyzed ${index + 1} of ${totalMutations} mutations${failures ? ` · ${failures} failed` : ""}`
        }
      }));
    }

    const status = failures === 0 ? "complete" : "partial";
    const message = failures === 0
      ? `${trigger === "automatic" ? "Automatically profiled" : "Profiled"} ${totalMutations} mutations independently with ${activeAnalyzers} active Evidence ${activeAnalyzers === 1 ? "device" : "devices"}.`
      : `${totalMutations - failures} of ${totalMutations} mutations profiled · ${failures} failed${lastFailure ? `: ${lastFailure}` : ""}`;
    setTrackProfilerRuns((current) => ({
      ...current,
      [trackId]: { status, processedMutations: totalMutations, totalMutations, activeAnalyzers, activeDeviceIds: [...activeDeviceIds], message }
    }));
    setNotice(failures === 0
      ? trigger === "automatic" ? "Track profile updated automatically" : "Track profile is complete"
      : `Track profile is partial · ${failures} mutations failed`);
    setBusy(false);
  }

  function requestDeviceEvidence(
    variant: VariantKey,
    deviceId: string,
    useStableCache: boolean
  ): Promise<EvidenceResult> {
    const alleleKey = selectionEvidenceKey(variant);
    if (useStableCache) {
      const cached = cachedEvidenceForDevices(selectedAlleleEvidenceCache.current, alleleKey, [deviceId])[deviceId];
      if (cached) return Promise.resolve(cached);
    }
    const requestKey = `${alleleKey}:${deviceId}`;
    const inFlight = evidenceRequests.current.get(requestKey);
    if (inFlight) return inFlight;
    const pending = api.evaluateDevice(projectPath, variant, deviceId)
      .then((result) => {
        cacheStableEvidence(selectedAlleleEvidenceCache.current, alleleKey, deviceId, result);
        return result;
      })
      .finally(() => {
        if (evidenceRequests.current.get(requestKey) === pending) evidenceRequests.current.delete(requestKey);
      });
    evidenceRequests.current.set(requestKey, pending);
    return pending;
  }

  function failedDeviceEvidence(deviceId: string, error: unknown): EvidenceResult {
    return {
      source: deviceManifests.find((manifest) => manifest.id === deviceId)?.name ?? deviceId,
      status: "error",
      records: [],
      message: messageOf(error)
    };
  }

  async function collectDeviceEvidence(
    variant: VariantKey,
    deviceIds: string[],
    useStableCache: boolean
  ): Promise<DeviceEvidenceMap> {
    const results = await Promise.all(deviceIds.map(async (deviceId) => {
      try {
        return [deviceId, await requestDeviceEvidence(variant, deviceId, useStableCache)] as const;
      } catch (error) {
        return [deviceId, failedDeviceEvidence(deviceId, error)] as const;
      }
    }));
    return Object.fromEntries(results);
  }

  async function evaluate() {
    if (!selected) return;
    if (automaticEvaluationTimer.current !== undefined) {
      window.clearTimeout(automaticEvaluationTimer.current);
      automaticEvaluationTimer.current = undefined;
    }
    const evaluatedVariant = selected;
    const generation = ++evaluationGeneration.current;
    const activeDeviceIds = [...activeAnalyzerDeviceIds];
    if (activeDeviceIds.length === 0) {
      setNotice("No active Evidence devices are applied to this track");
      return;
    }
    setBusy(true);
    setRunningDeviceId("all");
    setNotice(`Refreshing ${activeDeviceIds.length} active allele ${activeDeviceIds.length === 1 ? "device" : "devices"}…`);
    try {
      const currentEvidence = await collectDeviceEvidence(evaluatedVariant.key, activeDeviceIds, false);
      if (generation === evaluationGeneration.current) {
        setEvaluation(undefined);
        setDeviceEvaluations(currentEvidence);
        await recordSelectedMutationMeter(currentEvidence, activeDeviceIds, generation);
        setNotice("Selected-allele evidence is up to date");
      }
    } catch (error) {
      if (generation === evaluationGeneration.current) setNotice(messageOf(error));
    } finally {
      if (generation === evaluationGeneration.current) {
        setRunningDeviceId(undefined);
      }
      setBusy(false);
    }
  }

  const selectedEvidenceKey = selected ? selectionEvidenceKey(selected.key) : "";
  const activeAnalyzerSignature = activeAnalyzerDeviceIds.join("|");
  useEffect(() => {
    const generation = ++evaluationGeneration.current;
    if (automaticEvaluationTimer.current !== undefined) {
      window.clearTimeout(automaticEvaluationTimer.current);
      automaticEvaluationTimer.current = undefined;
    }
    setEvaluation(undefined);
    if (!selected || activeAnalyzerDeviceIds.length === 0) {
      setDeviceEvaluations({});
      setRunningDeviceId(undefined);
      return;
    }

    const evaluatedVariant = selected;
    const alleleKey = selectionEvidenceKey(evaluatedVariant.key);
    const activeDeviceIds = [...activeAnalyzerDeviceIds];
    const cached = cachedEvidenceForDevices(selectedAlleleEvidenceCache.current, alleleKey, activeDeviceIds);
    const missingDeviceIds = missingEvidenceDeviceIds(selectedAlleleEvidenceCache.current, alleleKey, activeDeviceIds);
    setDeviceEvaluations(cached);

    automaticEvaluationTimer.current = window.setTimeout(() => {
      automaticEvaluationTimer.current = undefined;
      if (generation !== evaluationGeneration.current) return;
      setRunningDeviceId("all");
      setNotice(missingDeviceIds.length > 0
        ? `Evaluating the selected allele with ${missingDeviceIds.length} ${missingDeviceIds.length === 1 ? "device" : "devices"}…`
        : "Loading cached evidence for the selected allele…");
      const pending = missingDeviceIds.length > 0
        ? collectDeviceEvidence(evaluatedVariant.key, missingDeviceIds, true)
        : Promise.resolve({} as DeviceEvidenceMap);
      void pending.then(async (freshEvidence) => {
        if (generation !== evaluationGeneration.current) return;
        const currentEvidence = { ...cached, ...freshEvidence };
        setDeviceEvaluations(currentEvidence);
        await recordSelectedMutationMeter(currentEvidence, activeDeviceIds, generation);
        if (generation !== evaluationGeneration.current) return;
        const transientFailures = Object.values(currentEvidence)
          .filter((evidence) => evidence.status === "error" || evidence.status === "resourceUnavailable").length;
        setNotice(transientFailures > 0
          ? `Selected-allele evidence updated · ${transientFailures} ${transientFailures === 1 ? "device needs" : "devices need"} attention`
          : "Selected-allele evidence updated automatically");
      }).catch((error) => {
        if (generation === evaluationGeneration.current) setNotice(`Automatic evidence evaluation failed: ${messageOf(error)}`);
      }).finally(() => {
        if (generation === evaluationGeneration.current) setRunningDeviceId(undefined);
      });
    }, AUTO_EVALUATION_DELAY_MS);

    return () => {
      if (automaticEvaluationTimer.current !== undefined) {
        window.clearTimeout(automaticEvaluationTimer.current);
        automaticEvaluationTimer.current = undefined;
      }
    };
  }, [activeAnalyzerSignature, activeTrack.id, selectedEditId, selectedEvidenceKey, selectedEvaluationRevision]);

  async function runRackDevice(_trackId: string, deviceId: string) {
    if (!selected || !alleleDeviceIds.includes(deviceId as typeof alleleDeviceIds[number])) return;
    if (automaticEvaluationTimer.current !== undefined) {
      window.clearTimeout(automaticEvaluationTimer.current);
      automaticEvaluationTimer.current = undefined;
    }
    const evaluatedVariant = selected;
    const generation = ++evaluationGeneration.current;
    setSelectedDeviceId(deviceId);
    setRunningDeviceId(deviceId);
    setBusy(true);
    setNotice(`Running ${deviceManifests.find((manifest) => manifest.id === deviceId)?.name ?? "device"} for the selected allele…`);
    try {
      const result = await requestDeviceEvidence(evaluatedVariant.key, deviceId, false);
      if (generation === evaluationGeneration.current) {
        setDeviceEvaluations((current) => ({ ...current, [deviceId]: result }));
        await recordSelectedMutationMeter({ [deviceId]: result }, [deviceId], generation);
        setNotice(`${result.source}: ${evidenceSummary(result)}`);
      }
    } catch (error) {
      if (generation === evaluationGeneration.current) setNotice(messageOf(error));
    } finally {
      if (generation === evaluationGeneration.current) {
        setRunningDeviceId(undefined);
      }
      setBusy(false);
    }
  }

  function scoringDeviceContributes(trackId: string, deviceId: string) {
    const optimizer = optimizers[trackId] ?? defaultOptimizer(trackId);
    const objective = optimizerObjectives.find((item) => item.id === optimizer.settings.objectiveId);
    const scoringInput = optimizerWeights.find((input) => input.sourceDeviceId === deviceId);
    return Boolean(scoringInput && objective?.includedWeightIds.includes(scoringInput.id));
  }

  function invalidateOptimizerScoringInputs(trackId: string, message: string) {
    const track = trackDeck.find((lane) => lane.track.id === trackId)?.track;
    const applied = appliedDevicesByTrack[trackId] ?? initialAppliedDeviceIds;
    if (track?.readOnly || !applied.includes(DEVICE_IDS.optimizer)) return;
    setOptimizers((current) => ({
      ...current,
      [trackId]: {
        ...(current[trackId] ?? defaultOptimizer(trackId)),
        status: "stale",
        result: undefined,
        message
      }
    }));
  }

  function addRackDevice(trackId: string, deviceId: string) {
    setAppliedDevicesByTrack((current) => {
      const existing = current[trackId] ?? initialAppliedDeviceIds;
      return existing.includes(deviceId) ? current : { ...current, [trackId]: [...existing, deviceId] };
    });
    setBypassedDevicesByTrack((current) => ({
      ...current,
      [trackId]: (current[trackId] ?? []).filter((id) => id !== deviceId)
    }));
    const name = deviceManifests.find((manifest) => manifest.id === deviceId)?.name
      ?? (deviceId === DEVICE_IDS.optimizer ? "Genome Optimizer" : deviceId === DEVICE_IDS.randomizer ? "Mutation Generator" : "Device");
    if (scoringDeviceContributes(trackId, deviceId)) {
      invalidateOptimizerScoringInputs(trackId, `${name} was added to the track. Generate again to use its configured contribution.`);
    }
    setSelectedDeviceId(deviceId);
    setDetailMode("devices");
    setNotice(`Added ${name} to the selected Genome Track`);
  }

  function removeRackDevice(trackId: string, deviceId: string) {
    const name = deviceManifests.find((manifest) => manifest.id === deviceId)?.name
      ?? (deviceId === DEVICE_IDS.optimizer ? "Genome Optimizer" : deviceId === DEVICE_IDS.randomizer ? "Mutation Generator" : "Device");
    setAppliedDevicesByTrack((current) => {
      const existing = current[trackId] ?? initialAppliedDeviceIds;
      return { ...current, [trackId]: existing.filter((id) => id !== deviceId) };
    });
    setBypassedDevicesByTrack((current) => ({
      ...current,
      [trackId]: (current[trackId] ?? []).filter((id) => id !== deviceId)
    }));
    if (deviceId === DEVICE_IDS.optimizer) {
      setOptimizers((current) => {
        const next = { ...current };
        delete next[trackId];
        return next;
      });
    }
    if (deviceId === DEVICE_IDS.randomizer) {
      setRandomizers((current) => {
        const next = { ...current };
        delete next[trackId];
        return next;
      });
    }
    if (scoringDeviceContributes(trackId, deviceId)) {
      invalidateOptimizerScoringInputs(trackId, `${name} is no longer applied. Its effective contribution is 0 until it is added again.`);
    }
    const remaining = (appliedDevicesByTrack[trackId] ?? initialAppliedDeviceIds).filter((id) => id !== deviceId);
    if (selectedDeviceId === deviceId) setSelectedDeviceId(remaining[0] ?? "");
    setNotice(`Removed ${name} from the track; source data and genome edits are unchanged`);
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
    const optimizer = optimizers[trackId] ?? defaultOptimizer(trackId);
    const objective = optimizerObjectives.find((item) => item.id === optimizer.settings.objectiveId);
    const scoringInput = optimizerWeights.find((input) => input.sourceDeviceId === deviceId);
    const contributesToObjective = Boolean(scoringInput && objective?.includedWeightIds.includes(scoringInput.id));
    if (contributesToObjective) invalidateOptimizerScoringInputs(trackId, `${name} is ${bypassed ? "bypassed" : "active"}. Generate again to use the updated effective scoring inputs.`);
    setNotice(contributesToObjective
      ? `${bypassed ? "Bypassed" : "Enabled"} ${name}; its effective score contribution is ${bypassed ? "0" : "restored"} and existing genome edits are unchanged`
      : `${bypassed ? "Bypassed" : "Enabled"} ${name}; it is not included in the current objective and genome edits are unchanged`);
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

  const activeSnpeffEvidence = !activeAppliedDeviceSet.has(DEVICE_IDS.snpeff) || activeBypassedDeviceSet.has(DEVICE_IDS.snpeff)
    ? undefined
    : evidenceByDevice[DEVICE_IDS.snpeff];
  const visibleEvidence = alleleDeviceIds
    .filter((deviceId) => activeAppliedDeviceSet.has(deviceId) && !activeBypassedDeviceSet.has(deviceId))
    .map((deviceId) => evidenceByDevice[deviceId])
    .filter((result): result is EvidenceResult => Boolean(result));

  return (
    <main className={`workstation${settings.showVariantBrowser ? "" : " hide-variants"}${settings.showEvidenceInspector ? "" : " hide-evidence"}`}>
      <header className="app-header">
        <div className="mini-brand"><img src="/dgw-logo.png" alt="" /></div>
        <div><strong title={projectPath}>{snapshot.manifest.name}</strong><span>{snapshot.manifest.selectedSample} · {snapshot.manifest.assembly}</span></div>
        <div className="header-spacer" />
        <div className="worker-state"><span className={busy || runningDeviceId ? "pulse" : "status-dot"} />{notice}</div>
      </header>

      <aside className="variant-browser">
        <div className="section-title"><span>Source Variants</span><small>{navigationVariants.length.toLocaleString()} {navigationVariants.length === 1 ? "variant" : "variants"}</small></div>
        <div
          className="variant-list"
          ref={variantListRef}
          onScroll={(event) => setVariantListScrollTop(event.currentTarget.scrollTop)}
        >
          <div className="variant-list-spacer" style={{ height: `${navigationEntries.length * VARIANT_ROW_HEIGHT}px` }}>
            <div className="variant-list-window" style={{ transform: `translateY(${firstRenderedVariant * VARIANT_ROW_HEIGHT}px)` }}>
              {renderedNavigationEntries.map((entry) => {
                if (entry.kind === "contig") {
                  return (
                    <div className="variant-contig-divider" key={`contig-${entry.contig}`}>
                      <b>CHR {entry.contig}</b>
                      <span>{entry.variantCount.toLocaleString()} source {entry.variantCount === 1 ? "variant" : "variants"}</span>
                    </div>
                  );
                }
                const variant = entry.variant;
                return (
                  <button key={variant.key.assembly + variantLabel(variant.key)} className={selected && variantLabel(selected.key) === variantLabel(variant.key) ? "variant-item active" : "variant-item"} onClick={() => focusVariant(variant)}>
                    <span>{variant.key.contig}:{variant.key.position.toLocaleString()}</span>
                    <b>{variant.key.reference}<i>›</i>{variant.key.alternate}</b>
                    <small><em className={variant.origin}>{variant.origin}</em>{variantPhaseLabel(variant)}</small>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </aside>

      <section className="canvas">
        <div className="focus-toolbar">
          <label>chr<input value={context.contig} onChange={(event) => setContext({ ...context, contig: event.target.value })} /></label>
          <label>start<input type="number" value={context.start} onChange={(event) => setContext({ ...context, start: Number(event.target.value) })} /></label>
          <span>—</span>
          <label>end<input type="number" value={context.end} onChange={(event) => setContext({ ...context, end: Number(event.target.value) })} /></label>
          <button className="button secondary" onClick={() => refresh()} disabled={busy}>Go</button>
          <small className="coordinate-system" title="DGW displays the 1-based coordinates used by the VCF POS column">VCF positions · 1-based</small>
          <div className="header-spacer" />
          <small>{context.end - context.start + 1} reference bases</small>
        </div>

        {contigDensity && <div className="genome-density-strip" aria-label={`Variant density across chromosome ${contigDensity.context.contig}`}>
          <span>chr{contigDensity.context.contig} overview</span>
          <div>{contigDensity.bins.map((bin, index) => {
            const maximum = Math.max(1, ...contigDensity.bins.map((item) => item.count));
            const height = bin.count === 0 ? 2 : 2 + 14 * Math.log1p(bin.count) / Math.log1p(maximum);
            const active = bin.start <= context.end && bin.end >= context.start;
            return <button
              type="button"
              className={active ? "active" : undefined}
              style={{ height }}
              title={`${bin.contig}:${bin.start.toLocaleString()}–${bin.end.toLocaleString()} · ${bin.count.toLocaleString()} active source ${bin.count === 1 ? "allele" : "alleles"}`}
              aria-label={`Open ${bin.contig}:${bin.start}-${bin.end}, ${bin.count} alleles`}
              onClick={() => openDensityBin(bin.start, bin.end)}
              key={`${bin.start}-${index}`}
            />;
          })}</div>
          <small>{contigDensity.total.toLocaleString()} source alleles · 256 bins</small>
        </div>}

        <div className="track-workspace-shell">
          <TrackDeviceWorkspace
            region={context}
            tracks={trackModels}
            selectedTrackId={activeTrack.id}
            selectedEditId={selectedEditId}
            selectedAlleleId={detailMode === "allele" && selected ? alleleId(selected) : undefined}
            selectedAlleleIds={selectedAlleleIds}
            selectedAlleleCount={symbolicSelection?.total ?? selectedAlleleIds.length}
            objectives={optimizerObjectives}
            weightControls={optimizerWeights}
            rackDevices={rackDevices}
            appliedDeviceIds={activeAppliedDevices}
            trackMeter={trackMeter}
            trackProfiler={trackProfiler}
            showDeviceRack={settings.showDeviceRack}
            showTrackMeter={settings.showTrackMonitor}
            deviceBrowserRequest={deviceBrowserRequest}
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
            onMarqueeSelectAlleles={marqueeSelectAlleles}
            onSelectVisibleAlleles={selectAllVisibleAlleles}
            onSelectAllAlleles={selectAllTrackAlleles}
            onClearAlleleSelection={clearAlleleSelection}
            onUndoAction={() => { void undoLastAction(); }}
            onRedoAction={() => { void redoLastAction(); }}
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
            onAddDevice={addRackDevice}
            onRemoveDevice={removeRackDevice}
            onAnalyzeTrack={(trackId) => { void analyzeTrack(trackId); }}
          />
        </div>
      </section>

      <aside className="inspector">
        <div className="section-title"><span>Evidence</span><small>selected allele only</small></div>
        {selected ? <>
          <div className="selected-variant"><p>{selected.key.contig}:{selected.key.position.toLocaleString()}</p><h3>{selected.key.reference}<i>›</i>{selected.key.alternate}</h3><span>{selected.origin} · {variantPhaseLabel(selected)}</span></div>
          <p className="evaluation-scope">Active devices run automatically for this exact allele. Imported VCF annotations are not used.</p>
          <button className="button primary wide" onClick={evaluate} disabled={busy || Boolean(runningDeviceId) || activeAnalyzerDeviceIds.length === 0}>{runningDeviceId ? "Evaluating…" : "Refresh active Evidence devices"}</button>
          {visibleEvidence.length > 0 ? <div className="evidence-stack">
            {visibleEvidence.map((evidence, index) => <EvidenceCard evidence={evidence} key={`${evidence.source}-${index}`} />)}
            <p className="limitation">{evaluation?.limitation ?? "Consequences and evidence are evaluated independently for one exact allele. Compound and phase-dependent effects are not calculated."}</p>
          </div> : <div className="empty-inspector"><span>◇</span><p>{runningDeviceId ? "Evaluating this exact allele…" : "Select an active Evidence device or refresh to evaluate this exact allele."}</p></div>}
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
  const [historyRequest, setHistoryRequest] = useState<HistoryRequest>();
  const [deviceBrowserRequest, setDeviceBrowserRequest] = useState(0);
  const [projectTemplate, setProjectTemplate] = useState<ProjectTemplateId>("standardEvidence");
  const [initialAppliedDeviceIds, setInitialAppliedDeviceIds] = useState<string[]>(dgwStarterDeviceIds);
  const [projectTemplateDialogOpen, setProjectTemplateDialogOpen] = useState(false);
  const [templateCreationBusy, setTemplateCreationBusy] = useState(false);
  const [templateCreationError, setTemplateCreationError] = useState<string>();
  const [projectSetupKey, setProjectSetupKey] = useState(0);
  const [historyState, setHistoryState] = useState<WorkstationHistoryState>(EMPTY_HISTORY_STATE);

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
    setHistoryRequest(undefined);
    setDeviceBrowserRequest(0);
    setHistoryState(EMPTY_HISTORY_STATE);
  }

  function requestExport(kind: ExportKind) {
    setExportRequest((current) => ({ id: (current?.id ?? 0) + 1, kind }));
  }

  function requestHistory(direction: HistoryDirection) {
    setHistoryRequest((current) => ({ id: (current?.id ?? 0) + 1, direction }));
  }

  function beginNewProject(template: ProjectTemplateId) {
    closeProject();
    setProjectTemplate(template);
    setProjectTemplateDialogOpen(false);
    setProjectSetupKey((current) => current + 1);
  }

  async function selectProjectTemplate(template: ProjectTemplateId) {
    setProjectTemplate(template);
    setTemplateCreationError(undefined);
    if (!snapshot || !projectPath) {
      beginNewProject(template);
      return;
    }

    setTemplateCreationBusy(true);
    try {
      const created = await api.createProjectFromCurrent(projectPath, template);
      setProjectPath(created.projectPath);
      setInitialAppliedDeviceIds(template === "empty" ? [] : [...dgwStarterDeviceIds]);
      setSnapshot(created.snapshot);
      setHistoryState(EMPTY_HISTORY_STATE);
      setProjectTemplateDialogOpen(false);
    } catch (error) {
      setTemplateCreationError(messageOf(error));
    } finally {
      setTemplateCreationBusy(false);
    }
  }

  return <div className={`application-shell${settings.reduceMotion ? " reduce-motion" : ""}${settings.uiScale >= 1.3 ? " large-interface" : ""}`}>
    <ApplicationMenu
      projectOpen={Boolean(snapshot)}
      projectName={snapshot?.manifest.name}
      projectPath={snapshot ? projectPath : undefined}
      settings={settings}
      canUndo={historyState.canUndo}
      canRedo={historyState.canRedo}
      undoLabel={historyState.undoLabel}
      redoLabel={historyState.redoLabel}
      onNewProject={() => beginNewProject("standardEvidence")}
      onNewFromTemplate={() => {
        setTemplateCreationError(undefined);
        setProjectTemplateDialogOpen(true);
      }}
      onSettingsChange={setSettings}
      onUndo={() => requestHistory("undo")}
      onRedo={() => requestHistory("redo")}
      onAddDevice={() => {
        setSettings((current) => ({ ...current, showDeviceRack: true }));
        setDeviceBrowserRequest((current) => current + 1);
      }}
      onOpenSettings={() => setSettingsOpen(true)}
      onExportTrackVcf={() => requestExport("trackVcf")}
      onExportFocusFasta={() => requestExport("focusFasta")}
      onCloseProject={closeProject}
    />
    <div className="application-stage">
      {snapshot
        ? <Workstation
          key={snapshot.manifest.projectId}
          projectPath={projectPath}
          snapshot={snapshot}
          setSnapshot={setSnapshot}
          settings={settings}
          exportRequest={exportRequest}
          historyRequest={historyRequest}
          deviceBrowserRequest={deviceBrowserRequest}
          initialAppliedDeviceIds={initialAppliedDeviceIds}
          onHistoryStateChange={setHistoryState}
        />
        : <Onboarding projectTemplate={projectTemplate} key={projectSetupKey} onOpened={(path, opened, created) => {
          setProjectPath(path);
          setInitialAppliedDeviceIds(created && projectTemplate === "empty" ? [] : [...dgwStarterDeviceIds]);
          setSnapshot(opened);
          setHistoryState(EMPTY_HISTORY_STATE);
        }} />}
    </div>
    <ProjectTemplateDialog
      open={projectTemplateDialogOpen}
      currentProjectOpen={Boolean(snapshot)}
      busy={templateCreationBusy}
      error={templateCreationError}
      onSelect={(template) => { void selectProjectTemplate(template); }}
      onClose={() => { if (!templateCreationBusy) setProjectTemplateDialogOpen(false); }}
    />
    <SettingsDialog open={settingsOpen} settings={settings} onChange={setSettings} onClose={() => setSettingsOpen(false)} />
  </div>;
}
