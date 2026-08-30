import { useEffect, useMemo, useRef, useState } from "react";
import { confirm as confirmDialog, open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api } from "./api";
import { ApplicationMenu, JobsDialog, ProjectTemplateDialog, SettingsDialog, type ProjectTemplateId } from "./ApplicationChrome";
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
  BackgroundJob,
  EditKind,
  EditOperation,
  EffectiveVariant,
  EvaluationResult,
  EvidenceResult,
  FocusContext,
  FocusView,
  GenomeTrack,
  GenomeTrackLane,
  Haplotype,
  OptimizerRequest,
  ProcessProgress,
  ProjectSnapshot,
  RandomizerPreviewResult,
  RandomizerRequest,
  ResourceBundle,
  TrackEvidenceProfileResult,
  VariantSelection,
  VariantContigSummary,
  VariantNavigationBin,
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
import {
  DEFAULT_USER_SETTINGS,
  USER_SETTINGS_STORAGE_KEY,
  parseUserSettings,
  type UserSettings
} from "./userSettings";
import { ALLELE_ROLL_BASES, buildAlleleRoll } from "./alleleRoll";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DEVICE_IDS = {
  snpeff: "org.dgw.builtin.snpeff",
  dbnsfp: "org.dgw.builtin.dbnsfp",
  clinvar: "org.dgw.builtin.clinvar",
  cosmic: "org.dgw.builtin.cosmic",
  randomizer: "org.dgw.builtin.mutation-generator",
  optimizer: "org.dgw.builtin.genome-optimizer",
  variantMap: "org.dgw.builtin.variant-map"
} as const;

const VARIANT_NAVIGATION_BIN_COUNT = 24;
const VARIANT_NAVIGATION_ALLELE_LIMIT = 200;
const VARIANT_NAVIGATION_LEAF_SPAN = 50_001;
const AUTOMATIC_TRACK_ANALYSIS_EDIT_LIMIT = 1_000;

function variantNavigationScope(contig: string, start?: number, end?: number): string {
  return start === undefined || end === undefined ? contig : `${contig}:${start}-${end}`;
}

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
const rackCompactDeviceIds = [...alleleDeviceIds, DEVICE_IDS.variantMap];
const dgwStarterDeviceIds = [DEVICE_IDS.randomizer, ...alleleDeviceIds, DEVICE_IDS.optimizer, DEVICE_IDS.variantMap];

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
    settings: { mode: "randomizer", amount: 100, seed: 42, maximumPositions: 1_000, substitutionPattern: "uniform", transitionProbability: 67 },
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
  if (operation.edit.kind === "compoundMutationLayer") return undefined;
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
  if (operation.edit.kind === "compoundMutationLayer") return undefined;
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

function editPrimaryKey(operation: EditOperation): VariantKey | undefined {
  if (operation.edit.kind === "compoundMutationLayer") return undefined;
  return operation.edit.kind === "restoreReference" ? operation.edit.sourceKey : operation.edit.key;
}

function editMutationCount(operation: EditOperation): number {
  return operation.edit.kind === "compoundMutationLayer" ? operation.edit.changeCount : 1;
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
  const [processSteps, setProcessSteps] = useState<ProcessProgress[]>([]);

  function receiveProgress(progress: ProcessProgress) {
    setStatus(progress.message);
    setProcessSteps((current) => [
      ...current.filter((item) => item.operation !== progress.operation || item.step !== progress.step),
      progress
    ].sort((left, right) => left.step - right.step));
  }

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
    setProcessSteps([]);
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
    const result = await api.inspectVcf(selected, receiveProgress);
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
    if (result.nonPassRecordCount > 0) {
      nextInputWarnings.push(
        `${result.nonPassRecordCount.toLocaleString()} non-PASS ${result.nonPassRecordCount === 1 ? "record" : "records"} will be excluded before selected-sample projection and normalization.`
      );
    }
    if (!result.biallelic) {
      nextInputWarnings.push("This VCF contains multiallelic records. DGW will decompose each supported ALT into an exact internal allele and preserve the selected sample's GT semantics.");
    }
    if (result.skippedUnsupportedRecordCount > 0) {
      nextInputWarnings.push(
        `${result.skippedUnsupportedRecordCount.toLocaleString()} symbolic, CNV, MNV, or large-allele ${result.skippedUnsupportedRecordCount === 1 ? "record" : "records"} will be skipped. DGW v0.1 imports only sequence-resolved SNVs and 1–49 bp indels.`
      );
    }
    setInputWarnings(nextInputWarnings);
    setStatus(
      `${options?.example ? "Example ready · " : ""}${result.supportedRecordCount.toLocaleString()} importable PASS small-variant records of ${result.recordCount.toLocaleString()} total · ${result.nonPassRecordCount.toLocaleString()} non-PASS excluded · ${result.samples.length.toLocaleString()} ${result.samples.length === 1 ? "sample" : "samples"} · input INFO annotations will be ignored`
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
      if (result.supportedRecordCount === 0 || !result.samples.includes(example.sample)) {
        throw new Error("The bundled example does not satisfy the DGW input contract.");
      }
      setStatus("Creating the example project…");
      setProcessSteps([]);
      const snapshot = await api.createProject({
        projectPath: example.projectPath,
        name: example.projectName,
        sourceVcfPath: example.path,
        selectedSample: example.sample,
        resourceBundle
      }, receiveProgress);
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
    setProcessSteps([]);
    setStatus("Fingerprinting the VCF, normalizing a project copy, and freezing the selected sample…");
    try {
      const snapshot = await api.createProject({
        projectPath,
        name,
        sourceVcfPath: sourcePath,
        selectedSample: sample,
        resourceBundle: bundle
      }, receiveProgress);
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
        <div className="brand-mark"><img src="/dgw-mark.svg" alt="Digital Genome Workstation" /></div>
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
            <label>VCF with SNVs/indels</label>
            <div className="file-choice-row">
              <button className="file-picker" onClick={chooseVcf} disabled={busy}>
                <span>{sourcePath || "Choose .vcf or .vcf.gz"}</span><b>Browse</b>
              </button>
              <button className="button secondary load-example" onClick={loadExample} disabled={busy}>{busy ? "Opening…" : "Open example"}</button>
            </div>
            <small className="fixture-note">DGW normalizes the selected sample against the configured reference inside the project. The source VCF is never changed.</small>
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
        {busy && processSteps.length > 0 && <section className="processing-panel" aria-live="polite" aria-label="Processing progress">
          <div className="processing-progress"><i style={{ width: `${Math.min(100, (processSteps.at(-1)!.step / processSteps.at(-1)!.totalSteps) * 100)}%` }} /></div>
          <ol>
            {processSteps.map((progress, index) => <li className={index === processSteps.length - 1 ? "current" : "complete"} key={`${progress.operation}-${progress.step}`}>
              <span>{index === processSteps.length - 1 ? "Processing" : "Done"}</span>
              <b>{progress.message}</b>
              <small>{progress.step}/{progress.totalSteps}</small>
            </li>)}
          </ol>
        </section>}
        {inputWarnings.map((warning) => <p className="warning" key={warning}>{warning}</p>)}
        {warnings.map((warning) => <p className="warning" key={warning}>{warning}</p>)}
        <button className="button primary wide" onClick={create} disabled={busy || !bundle || !inspection || inspection.supportedRecordCount === 0 || !sample || !projectPath}>
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

interface AlleleRollChoice {
  base: string;
  haplotype?: Haplotype;
  revision: number;
}

function AlleleRoll({
  context,
  referenceSequence,
  variants,
  selected,
  stagedBase,
  stagedHaplotype,
  editable,
  onSelectVariant,
  onStageBase
}: {
  context: FocusContext;
  referenceSequence?: string;
  variants: EffectiveVariant[];
  selected?: EffectiveVariant;
  stagedBase?: string;
  stagedHaplotype?: Haplotype;
  editable: boolean;
  onSelectVariant: (variant: EffectiveVariant) => void;
  onStageBase: (base: string, haplotype?: Haplotype) => void;
}) {
  const [draggingHaplotype, setDraggingHaplotype] = useState<Haplotype>();
  const [dragTargetBase, setDragTargetBase] = useState<string>();
  const columns = useMemo(
    () => buildAlleleRoll(context, referenceSequence, variants, selected),
    [context, referenceSequence, variants, selected]
  );
  const selectedIsCanonicalSnv = Boolean(
    selected
    && /^[ACGT]$/i.test(selected.key.reference)
    && /^[ACGT]$/i.test(selected.key.alternate)
  );

  if (columns.length === 0) {
    return <div className="allele-roll-empty">Reference FASTA is unavailable for this focused region.</div>;
  }

  const gridStyle = { gridTemplateColumns: `74px repeat(${columns.length}, 30px)` };

  return <section className="allele-roll" aria-label="FASTA-aligned Allele Roll">
    <div className="allele-roll-toolbar">
      <div><b>Allele Roll</b><span>A/C/G/T lanes aligned to forward-strand FASTA</span></div>
      <div className="allele-roll-legend" aria-label="Chromosome-copy legend">
        <span className="copy-a">A</span> chromosome copy A
        <span className="copy-b">B</span> chromosome copy B
        <span className="copy-u">U</span> copy unknown
      </div>
    </div>
    <div className="allele-roll-scroll">
      <div className="allele-roll-grid allele-roll-positions" style={gridStyle}>
        <span className="allele-roll-axis">1-based</span>
        {columns.map((column) => column.variant
          ? <button
              type="button"
              className={column.selected ? "selected" : undefined}
              title={`Open VCF allele at ${context.contig}:${column.position.toLocaleString()}`}
              onClick={() => onSelectVariant(column.variant!)}
              key={column.position}
            >{String(column.position).slice(-3)}</button>
          : <span className={column.selected ? "selected" : undefined} key={column.position}>{String(column.position).slice(-3)}</span>)}
      </div>
      <div className="allele-roll-grid allele-roll-reference" style={gridStyle}>
        <span className="allele-roll-axis">REF 5′→3′</span>
        {columns.map((column) => <span className={column.selected ? "selected" : undefined} key={column.position}>{column.reference}</span>)}
      </div>
      {ALLELE_ROLL_BASES.map((base) => <div className="allele-roll-grid allele-roll-lane" style={gridStyle} key={base}>
        <span className={`allele-roll-axis base-${base.toLowerCase()}`}>{base}</span>
        {columns.map((column) => {
          const isCurrentPosition = column.selected;
          const canStage = isCurrentPosition && column.canonicalSnv && editable;
          const isReference = column.reference === base;
          const isStaged = isCurrentPosition && stagedBase === base;
          const isCurrentCopyBase = (haplotype: Haplotype) => isCurrentPosition && column.canonicalSnv && Boolean(
            haplotype === "one" ? column.variant?.haplotype1Alt && column.copyA === base
              : haplotype === "two" ? column.variant?.haplotype2Alt && column.copyB === base
                : column.variant?.unphasedAlt && (column.effective ? column.unphasedAlternate === base : column.reference === base)
          );
          const canDragCopy = (haplotype: Haplotype) => editable && isCurrentCopyBase(haplotype);
          const hasActiveCopy = isCurrentCopyBase("one") || isCurrentCopyBase("two") || isCurrentCopyBase("unphased");
          const copyMark = (label: "A" | "B" | "U", haplotype: Haplotype, active: boolean) => {
            const draggable = canDragCopy(haplotype);
            return <i
            className={`copy-${label.toLowerCase()}${active ? " is-note" : ""}${draggable ? " is-draggable" : ""}`}
            draggable={draggable}
            title={draggable
              ? `Drag base ${base} vertically to another lane · ${label === "U" ? "chromosome copy unknown" : `chromosome copy ${label}`}`
              : active && !editable ? `Base ${base} on the protected source track · duplicate the track to drag it`
                : label === "U" ? "Chromosome copy is unknown" : `Chromosome copy ${label}`}
            onDragStart={draggable ? (event) => {
              event.stopPropagation();
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", haplotype);
              setDraggingHaplotype(haplotype);
            } : undefined}
            onDragEnd={draggable ? () => {
              setDraggingHaplotype(undefined);
              setDragTargetBase(undefined);
            } : undefined}
          >{active ? <><b>{base}</b><small>{label}</small></> : label}</i>;
          };
          const marks = column.variant && column.canonicalSnv
            ? <span className={`allele-roll-copy-marks${hasActiveCopy ? " has-note" : ""}`}>
                {!column.variant.unphasedAlt && column.copyA === base && copyMark("A", "one", isCurrentCopyBase("one"))}
                {!column.variant.unphasedAlt && column.copyB === base && copyMark("B", "two", isCurrentCopyBase("two"))}
                {column.variant.unphasedAlt
                  && (column.effective
                    ? column.unphasedAlternate === base || column.reference === base
                    : column.reference === base)
                  && copyMark("U", "unphased", isCurrentCopyBase("unphased"))}
              </span>
            : undefined;
          const stagedMark = isStaged && stagedHaplotype
            ? <span className="allele-roll-staged-mark">{stagedHaplotype === "one" ? "A" : stagedHaplotype === "two" ? "B" : "U"}</span>
            : undefined;
          const className = [
            "allele-roll-cell",
            isReference ? "is-reference" : "",
            column.variant ? "is-vcf-locus" : "is-locked",
            isCurrentPosition ? "is-selected-position" : "",
            isStaged ? "is-staged" : "",
            isCurrentPosition && dragTargetBase === base ? "is-drag-target" : ""
          ].filter(Boolean).join(" ");

          return canStage
            ? <button
                type="button"
                className={className}
                title={base === column.reference ? `Stage restoration to REF ${base}` : `Stage ALT ${base}`}
                aria-label={`${base === column.reference ? "Use reference" : "Change ALT to"} ${base} at ${context.contig}:${column.position}`}
                onClick={() => onStageBase(base)}
                onDragEnter={draggingHaplotype ? () => setDragTargetBase(base) : undefined}
                onDragOver={draggingHaplotype ? (event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                } : undefined}
                onDrop={draggingHaplotype ? (event) => {
                  event.preventDefault();
                  onStageBase(base, draggingHaplotype);
                  setDraggingHaplotype(undefined);
                  setDragTargetBase(undefined);
                } : undefined}
                key={column.position}
              ><span>{base}</span>{marks}{stagedMark}</button>
            : column.variant ? <button
                type="button"
                className={className}
                title={column.canonicalSnv
                  ? isCurrentPosition && !editable
                    ? "Duplicate the protected source track before editing"
                    : "Select this VCF locus before editing it"
                  : "Indels remain editable in the Mutation editor"}
                onClick={() => onSelectVariant(column.variant!)}
                key={column.position}
              >{isReference && <span>{base}</span>}{marks}</button>
              : <span
                  className={className}
                  title="FASTA context only — this position is not editable from a conventional VCF"
                  key={column.position}
                >{isReference && <span>{base}</span>}</span>;
        })}
      </div>)}
    </div>
    <p className="allele-roll-help">
      {selectedIsCanonicalSnv
        ? editable
          ? "Drag the filled base block vertically to another A/C/G/T lane, or click a destination cell, to stage a reversible mutation; then Apply it in the Mutation editor."
          : "This source track is protected. Duplicate it before staging a mutation."
        : "The selected allele is not a canonical SNV. Inspect or change its full sequence in the Mutation editor."}
      <span> Muted columns are FASTA context, not editable sample calls.</span>
    </p>
  </section>;
}

function EditPanel({
  variant,
  rollChoice,
  onApply,
  busy,
  editable,
  trackName,
  onDuplicateProtectedTrack
}: {
  variant?: EffectiveVariant;
  rollChoice?: AlleleRollChoice;
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
    ? [{ value: "unphased", label: "Chromosome copy unknown (unphased GT)" }]
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
    setMode("replace");
    setAlternate(variant.key.alternate);
    setHaplotype(variant.unphasedAlt ? "unphased" : variant.haplotype2Alt ? "two" : "one");
    setSaveFeedback(undefined);
  }, [variant]);

  useEffect(() => {
    if (!variant || !rollChoice) return;
    if (rollChoice.haplotype && placementOptions.some((option) => option.value === rollChoice.haplotype)) {
      setHaplotype(rollChoice.haplotype);
    }
    if (rollChoice.base === variant.key.reference.toUpperCase()) {
      setMode("restore");
    } else {
      setMode("replace");
      setAlternate(rollChoice.base);
    }
    setSaveFeedback(undefined);
  }, [rollChoice?.revision]);

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
        <b>Chromosome copy unknown · input genotype uses /</b>
        <span>DGW follows this exact ALT in its slash-separated genotype slot without assigning it to chromosome copy A or B. Changing ALT stays unphased; using reference removes this allele from the track.</span>
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
  onSelectVariant,
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
  onSelectVariant: (variant: EffectiveVariant) => void;
  onShowDevices: () => void;
}) {
  const [detailView, setDetailView] = useState<"roll" | "sequence">("roll");
  const [rollChoice, setRollChoice] = useState<AlleleRollChoice>();
  const compoundCopyGroups = [
    { label: "chromosome copy A", count: focus?.variants.filter((item) => item.haplotype1Alt).length ?? 0 },
    { label: "chromosome copy B", count: focus?.variants.filter((item) => item.haplotype2Alt).length ?? 0 }
  ].filter((group) => group.count > 1);

  useEffect(() => {
    setRollChoice(undefined);
  }, [variant?.key.assembly, variant?.key.contig, variant?.key.position, variant?.key.reference, variant?.key.alternate]);

  return <section className="dgw-allele-detail" aria-label="Selected allele editor">
    <header className="dgw-detail-header">
      <div><span>Allele editor</span><small>{variant ? `${variant.key.contig}:${variant.key.position.toLocaleString()} ${variant.key.reference}→${variant.key.alternate}` : "Select an allele block"}</small></div>
      <button type="button" onClick={onShowDevices}>Show devices</button>
    </header>
    <div className="dgw-allele-detail-body">
      <div className="dgw-focused-sequence">
        <div className="allele-detail-view-switch" role="tablist" aria-label="Allele detail view">
          <button type="button" role="tab" aria-selected={detailView === "roll"} className={detailView === "roll" ? "active" : undefined} onClick={() => setDetailView("roll")}>Allele Roll</button>
          <button type="button" role="tab" aria-selected={detailView === "sequence"} className={detailView === "sequence" ? "active" : undefined} onClick={() => setDetailView("sequence")}>Sequence</button>
        </div>
        {detailView === "roll" ? <AlleleRoll
          context={context}
          referenceSequence={focus?.referenceSequence}
          variants={focus?.variants ?? []}
          selected={variant}
          stagedBase={rollChoice?.base}
          stagedHaplotype={rollChoice?.haplotype}
          editable={!track.readOnly}
          onSelectVariant={onSelectVariant}
          onStageBase={(base, haplotype) => setRollChoice((current) => ({ base, haplotype, revision: (current?.revision ?? 0) + 1 }))}
        /> : <>
          <VariantChangeLens variant={variant} referenceSequence={focus?.referenceSequence} context={context} snpeffEvidence={snpeffEvidence} />
          <div className="coordinate-ruler"><span>{context.contig}:{context.start.toLocaleString()}</span><i /><span>{context.end.toLocaleString()}</span></div>
          <SequenceRow label="REF" sequence={focus?.referenceSequence} tone="reference" context={context} variants={focus?.variants ?? []} track="reference" selected={variant} />
          <SequenceRow label="CHR COPY A" sequence={focus?.haplotype1Sequence} tone="hap-one" context={context} variants={focus?.variants ?? []} track="one" selected={variant} />
          <SequenceRow label="CHR COPY B" sequence={focus?.haplotype2Sequence} tone="hap-two" context={context} variants={focus?.variants ?? []} track="two" selected={variant} />
        </>}
        {focus?.variants.some((item) => item.unphasedAlt) && <p className="phase-notice"><b>U</b> The ALT belongs to one chromosome copy, but genotype 0/1 does not identify A or B.</p>}
        {compoundCopyGroups.length > 0 && <p className="compound-notice"><b>Combined effect not calculated</b> {compoundCopyGroups.map((group) => `${group.count} variants on ${group.label}`).join(" · ")}.</p>}
      </div>
      <EditPanel
        variant={variant}
        rollChoice={rollChoice}
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
  onShowDeviceRack,
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
  onShowDeviceRack: () => void;
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
  const [variantContigs, setVariantContigs] = useState<VariantContigSummary[]>([]);
  const [expandedVariantContigs, setExpandedVariantContigs] = useState<string[]>([]);
  const [expandedVariantBins, setExpandedVariantBins] = useState<string[]>([]);
  const [variantBinsByScope, setVariantBinsByScope] = useState<Record<string, VariantNavigationBin[]>>({});
  const [variantNavigationLoading, setVariantNavigationLoading] = useState<string[]>([]);
  const [selectedEditId, setSelectedEditId] = useState<string>();
  const [hiddenTrackIds, setHiddenTrackIds] = useState<string[]>([]);
  const [optimizers, setOptimizers] = useState<Record<string, GenomeOptimizerDevice>>({});
  const [randomizers, setRandomizers] = useState<Record<string, AlleleRandomizerDevice>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("Ready");
  const [detailMode, setDetailMode] = useState<"devices" | "allele">("devices");
  const [meterEvaluations, setMeterEvaluations] = useState<Record<string, Record<string, MeterEditEvaluation>>>({});
  const [bulkProfiles, setBulkProfiles] = useState<Record<string, TrackEvidenceProfileResult>>({});
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
  const activeTrack = focus?.activeTrack ?? snapshot.activeTrack;
  const focusedSourceVariants = trackDeck.find((lane) => lane.track.readOnly)?.variants;
  const navigationVariantTotal = variantContigs.reduce((total, contig) => total + contig.total, 0);
  const contextMidpoint = context.start + Math.floor((context.end - context.start) / 2);
  const navigationVariants = (focusedSourceVariants ?? snapshot.variants)
    .filter((variant) => variant.key.contig === context.contig
      && variant.key.position >= context.start
      && variant.key.position <= context.end)
    .slice(0, VARIANT_NAVIGATION_ALLELE_LIMIT);
  const selectedAlleleIdSet = useMemo(() => new Set(selectedAlleleIds), [selectedAlleleIds]);
  const allTrackSelectionActive = symbolicSelection?.selection.kind === "allTrack"
    && symbolicSelection.selection.trackId === activeTrack.id;
  const allTrackSelectionExclusions = useMemo(() => new Set(
    symbolicSelection?.selection.kind === "allTrack"
      ? symbolicSelection.selection.exclusions.map(variantKeyId)
      : []
  ), [symbolicSelection]);
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
    let cancelled = false;
    setVariantContigs([]);
    setVariantBinsByScope({});
    setExpandedVariantContigs([context.contig]);
    setExpandedVariantBins([]);
    void api.variantContigs(projectPath)
      .then((contigs) => {
        if (!cancelled) setVariantContigs(contigs);
      })
      .catch((error) => {
        if (!cancelled) setNotice(`Source variant navigator unavailable: ${messageOf(error)}`);
      });
    return () => { cancelled = true; };
  }, [projectPath]);

  useEffect(() => {
    if (!variantContigs.some((summary) => summary.contig === context.contig)) return;
    setExpandedVariantContigs((current) => current.includes(context.contig)
      ? current
      : [...current, context.contig]);
    let start: number | undefined;
    let end: number | undefined;
    while (true) {
      const scope = variantNavigationScope(context.contig, start, end);
      const bins = variantBinsByScope[scope];
      if (!bins) {
        if (!variantNavigationLoading.includes(scope)) {
          void loadVariantNavigationBins(context.contig, start, end);
        }
        return;
      }
      const active = bins.find((bin) => bin.start <= contextMidpoint && bin.end >= contextMidpoint);
      if (!active || active.end - active.start + 1 <= VARIANT_NAVIGATION_LEAF_SPAN) return;
      const childScope = variantNavigationScope(active.contig, active.start, active.end);
      setExpandedVariantBins((current) => current.includes(childScope)
        ? current
        : [...current, childScope]);
      start = active.start;
      end = active.end;
    }
  }, [context.contig, contextMidpoint, variantContigs, variantBinsByScope, variantNavigationLoading]);
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
      [DEVICE_IDS.cosmic, 40],
      [DEVICE_IDS.variantMap, 60]
    ]);
    const activeLane = trackDeck.find((lane) => lane.track.id === activeTrack.id);
    const activeEditCount = activeLane?.edits.filter((edit) => !activeTrack.bypassedEditIds.includes(edit.id)).length ?? 0;
    const visibleVariantCount = activeLane?.variants.length ?? 0;
    return deviceManifests
      .filter((manifest) => rackCompactDeviceIds.includes(manifest.id as typeof rackCompactDeviceIds[number]))
      .map((manifest) => {
        const evidence = evidenceByDevice[manifest.id];
        const visualization = manifest.id === DEVICE_IDS.variantMap;
        const resource = visualization
          ? "Current track state and Track Monitor results"
          : manifest.id === DEVICE_IDS.snpeff
          ? `${bundle.snpeffGenome} transcript data`
          : manifest.id === DEVICE_IDS.dbnsfp
            ? bundle.dbnsfp.release
            : manifest.id === DEVICE_IDS.clinvar
              ? bundle.clinvar.release
              : bundle.cosmic.release;
        const version = manifest.id === DEVICE_IDS.snpeff ? `SnpEff ${bundle.snpeffVersion}` : `device ${manifest.version}`;
        const kind = visualization
          ? "visualization"
          : manifest.id === DEVICE_IDS.snpeff
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
          target: visualization ? "focusedRegion" : "selectedAllele",
          order: order.get(manifest.id) ?? 100,
          bypassed: activeBypassedDeviceSet.has(manifest.id),
          status: visualization ? "ready" : running ? "running" : evidence?.status ?? "notComputed",
          resource,
          version,
          result: visualization
            ? `${visibleVariantCount.toLocaleString()} visible ${visibleVariantCount === 1 ? "allele" : "alleles"} · ${activeEditCount.toLocaleString()} active ${activeEditCount === 1 ? "edit" : "edits"}`
            : evidenceSummary(evidence),
          limitation: manifest.scientificLimitations[0],
          canRun: visualization || Boolean(selected),
          runLabel: visualization ? "Open map" : evidence ? "Refresh" : "Run now",
          scoreInclusion: visualization || activeTrack.readOnly ? undefined : inputState === "excluded" ? "excluded" : "included"
        } satisfies RackDeviceView;
      });
  }, [activeBypassedDeviceSet, activeScoringObjective, activeTrack, deviceManifests, evidenceByDevice, runningDeviceId, selected, snapshot.manifest.resourceBundle, trackDeck]);
  const trackModels = useMemo<GenomeTrackModel[]>(() => {
    const optimizerManifest = deviceManifests.find((manifest) => manifest.id === DEVICE_IDS.optimizer);
    const randomizerManifest = deviceManifests.find((manifest) => manifest.id === DEVICE_IDS.randomizer);
    return trackDeck.map((lane) => {
      const optimizer = optimizers[lane.track.id] ?? defaultOptimizer(lane.track.id);
      const randomizer = randomizers[lane.track.id] ?? defaultRandomizer();
      const visibleVariants = (lane.variants ?? [])
        .filter((variant) => variant.key.contig === context.contig)
        .filter((variant) => variant.key.position <= context.end && variant.key.position + variant.key.reference.length - 1 >= context.start);
      const locusCounts = new Map<string, number>();
      const locusIndexes = new Map<string, number>();
      for (const variant of visibleVariants) {
        const locus = `${variant.key.position}:${variant.key.reference}`;
        locusCounts.set(locus, (locusCounts.get(locus) ?? 0) + 1);
      }
      return {
        id: lane.track.id,
        name: lane.track.name,
        kind: lane.track.readOnly ? "source" : "candidate",
        visible: !hiddenTrackIds.includes(lane.track.id),
        totalEditCount: lane.edits.reduce((total, edit) => total + editMutationCount(edit), 0),
        alleles: visibleVariants.map((variant) => {
          const locus = `${variant.key.position}:${variant.key.reference}`;
          const stackIndex = locusIndexes.get(locus) ?? 0;
          locusIndexes.set(locus, stackIndex + 1);
          return {
            id: alleleId(variant),
            position: variant.key.position,
            reference: variant.key.reference,
            alternate: variant.key.alternate,
            origin: variant.origin,
            stackIndex,
            stackCount: locusCounts.get(locus) ?? 1
          };
        }),
        edits: lane.edits
          .filter((edit) => editPrimaryKey(edit)?.contig === context.contig)
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
      if (operation.edit.kind === "compoundMutationLayer") {
        return {
          editId: operation.id,
          label: `${operation.edit.positionCount.toLocaleString()} positions · ${operation.edit.changeCount.toLocaleString()} changes`,
          contig: "Multiple contigs",
          position: 0,
          reference: "—",
          alternate: "—",
          enabled,
          evaluated: false,
          mutationCount: operation.edit.changeCount
        };
      }
      const operationKey = operation.edit.kind === "restoreReference" ? operation.edit.sourceKey : operation.edit.key;
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
        contig: operationKey.contig,
        position: block?.position ?? operationKey.position,
        reference: block?.reference ?? operationKey.reference,
        alternate: block?.alternate ?? operationKey.alternate,
        enabled,
        evaluated: impactDelta !== undefined,
        impactDelta,
        mutationCount: 1
      };
    });
    const activeItems = items.filter((item) => item.enabled);
    const activeMutationCount = activeItems.reduce((total, item) => total + (item.mutationCount ?? 1), 0);
    const candidateBulkProfile = bulkProfiles[activeTrack.id];
    const bulkProfile = candidateBulkProfile
      && candidateBulkProfile.stateId === activeTrack.headStateId
      && candidateBulkProfile.activeMutations === activeMutationCount
      ? candidateBulkProfile
      : undefined;
    const evaluatedItems = activeItems.filter((item) => item.impactDelta !== undefined);
    const itemDistributionComplete = evaluatedItems.reduce(
      (total, item) => total + (item.mutationCount ?? 1),
      0
    ) === activeMutationCount && activeMutationCount > 0;
    const itemDistribution = itemDistributionComplete
      ? evaluatedItems.reduce((counts, item) => {
        const count = item.mutationCount ?? 1;
        if ((item.impactDelta ?? 0) > Number.EPSILON) counts.higher += count;
        else if ((item.impactDelta ?? 0) < -Number.EPSILON) counts.lower += count;
        else counts.unchanged += count;
        return counts;
      }, { higher: 0, lower: 0, unchanged: 0 })
      : undefined;
    const labels = new Map([
      [DEVICE_IDS.snpeff, "SnpEff"],
      [DEVICE_IDS.dbnsfp, "dbNSFP"],
      [DEVICE_IDS.clinvar, "ClinVar"],
      [DEVICE_IDS.cosmic, "COSMIC"]
    ]);
    const deviceCoverage = alleleDeviceIds.filter((deviceId) => activeAppliedDeviceSet.has(deviceId)).map((deviceId) => {
      const bulkCoverage = bulkProfile?.deviceCoverage.find((coverage) => coverage.id === deviceId);
      const activeEvaluations = activeItems
        .map((item) => stored[item.editId])
        .filter((value): value is MeterEditEvaluation => Boolean(value));
      return {
        id: deviceId,
        label: labels.get(deviceId) ?? deviceId,
        evaluated: bulkCoverage?.evaluated
          ?? activeEvaluations.filter((value) => value.evaluatedDeviceIds.includes(deviceId)).length,
        total: activeMutationCount,
        exactMatches: bulkCoverage?.exactMatches ?? activeEvaluations.reduce((count, value) => {
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
      evaluatedMutations: snpeffEnabled
        ? bulkProfile?.evaluatedMutations ?? evaluatedItems.reduce((total, item) => total + (item.mutationCount ?? 1), 0)
        : 0,
      activeMutations: activeMutationCount,
      impactDelta: snpeffEnabled && bulkProfile
        ? bulkProfile.impactDelta
        : snpeffEnabled
        && evaluatedItems.reduce((total, item) => total + (item.mutationCount ?? 1), 0) === activeItems.reduce((total, item) => total + (item.mutationCount ?? 1), 0)
        && activeItems.length > 0
        ? evaluatedItems.reduce((sum, item) => sum + (item.impactDelta ?? 0), 0)
        : undefined,
      higherImpactMutations: snpeffEnabled
        ? bulkProfile?.higherImpactMutations ?? itemDistribution?.higher
        : undefined,
      lowerImpactMutations: snpeffEnabled
        ? bulkProfile?.lowerImpactMutations ?? itemDistribution?.lower
        : undefined,
      unchangedImpactMutations: snpeffEnabled
        ? bulkProfile?.unchangedImpactMutations ?? itemDistribution?.unchanged
        : undefined,
      deviceCoverage,
      items: bulkProfile
        ? items.map((item) => item.mutationCount && item.mutationCount > 1
          ? { ...item, evaluated: true }
          : item)
        : items,
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
  }, [activeAppliedDeviceSet, activeBypassedDeviceSet, activeTrack, bulkProfiles, meterEvaluations, optimizers, trackDeck]);
  const activeAnalyzerDeviceIds = alleleDeviceIds.filter((deviceId) => activeAppliedDeviceSet.has(deviceId) && !activeBypassedDeviceSet.has(deviceId));
  const activeAnalyzerCount = activeAnalyzerDeviceIds.length;
  const storedTrackProfiler = trackProfilerRuns[activeTrack.id];
  const restoredBulkProfile = bulkProfiles[activeTrack.id];
  const currentBulkProfile = restoredBulkProfile
    && restoredBulkProfile.stateId === activeTrack.headStateId
    && restoredBulkProfile.activeMutations === trackMeter.activeMutations
    && activeAnalyzerDeviceIds.every((deviceId) => restoredBulkProfile.deviceCoverage.some((coverage) => coverage.id === deviceId))
    ? restoredBulkProfile
    : undefined;
  const trackProfiler: TrackProfilerModel = storedTrackProfiler
    && (storedTrackProfiler.status === "running"
      || (storedTrackProfiler.totalMutations === trackMeter.activeMutations
        && storedTrackProfiler.activeAnalyzers === activeAnalyzerCount
        && (storedTrackProfiler.activeDeviceIds ?? []).length === activeAnalyzerDeviceIds.length
        && (storedTrackProfiler.activeDeviceIds ?? []).every((deviceId, index) => deviceId === activeAnalyzerDeviceIds[index])))
    ? storedTrackProfiler
    : currentBulkProfile
      ? {
        status: currentBulkProfile.deviceCoverage.some((coverage) => coverage.evaluated < coverage.total || coverage.errors > 0 || coverage.unavailable > 0)
          ? "partial"
          : "complete",
        processedMutations: currentBulkProfile.activeMutations,
        totalMutations: currentBulkProfile.activeMutations,
        activeAnalyzers: activeAnalyzerCount,
        activeDeviceIds: activeAnalyzerDeviceIds,
        message: `Restored background profile for ${currentBulkProfile.activeMutations.toLocaleString()} mutations.`
      }
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
    let disposed = false;
    api.listBackgroundJobs(projectPath, 200)
      .then((jobs) => {
        if (disposed) return;
        const restored: Record<string, TrackEvidenceProfileResult> = {};
        for (const job of jobs) {
          if (job.operation !== "trackEvidenceProfile" || job.status !== "completed" || !job.result) continue;
          const result = job.result as Partial<TrackEvidenceProfileResult>;
          if (!result.trackId || !result.stateId || result.activeMutations === undefined || !result.deviceCoverage) continue;
          if (!restored[result.trackId]) restored[result.trackId] = result as TrackEvidenceProfileResult;
        }
        setBulkProfiles(restored);
      })
      .catch(() => undefined);
    return () => { disposed = true; };
  }, [projectPath]);

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
          setSelected(refreshedSelection ?? view.variants[0]);
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

  async function loadVariantNavigationBins(contig: string, start?: number, end?: number) {
    const scope = variantNavigationScope(contig, start, end);
    if (variantBinsByScope[scope] || variantNavigationLoading.includes(scope)) return;
    setVariantNavigationLoading((current) => current.includes(scope) ? current : [...current, scope]);
    try {
      const bins = await api.variantNavigationBins(
        projectPath,
        contig,
        VARIANT_NAVIGATION_BIN_COUNT,
        start,
        end
      );
      setVariantBinsByScope((current) => ({ ...current, [scope]: bins }));
    } catch (error) {
      setNotice(`Could not load ${scope}: ${messageOf(error)}`);
    } finally {
      setVariantNavigationLoading((current) => current.filter((item) => item !== scope));
    }
  }

  function toggleVariantContig(contig: string) {
    const expanded = expandedVariantContigs.includes(contig);
    setExpandedVariantContigs((current) => expanded
      ? current.filter((item) => item !== contig)
      : [...current, contig]);
    if (!expanded) void loadVariantNavigationBins(contig);
  }

  async function activateNavigationBin(bin: VariantNavigationBin) {
    const scope = variantNavigationScope(bin.contig, bin.start, bin.end);
    if (bin.end - bin.start + 1 > VARIANT_NAVIGATION_LEAF_SPAN) {
      const expanded = expandedVariantBins.includes(scope);
      setExpandedVariantBins((current) => expanded
        ? current.filter((item) => item !== scope)
        : [...current, scope]);
      if (!expanded) void loadVariantNavigationBins(bin.contig, bin.start, bin.end);
      return;
    }
    setNotice(`Loading chr${bin.contig}:${bin.start.toLocaleString()}–${bin.end.toLocaleString()}…`);
    await refresh({ contig: bin.contig, start: bin.start, end: bin.end });
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

  function selectAllTrackAlleles(trackId: string) {
    invalidateSelectedAlleleEvaluation();
    const lane = trackDeck.find((item) => item.track.id === trackId);
    const variants = lane?.variants ?? [];
    const ids = variants.map(alleleId);
    const selection: VariantSelection = { kind: "allTrack", trackId, exclusions: [] };
    const total = navigationVariantTotal || snapshot.variants.length;
    setSymbolicSelection({ selection, total });
    setAlleleSelection(ids, "Select all variants in track", true, true);
    setSelectedEditId(undefined);
    setDetailMode("devices");
    setSelectedDeviceId(DEVICE_IDS.randomizer);
    if (variants[0]) setSelected(variants[0]);
    setNotice(total === 0
      ? "This track has no active VCF alleles"
      : `${total.toLocaleString()} variants selected across all ${variantContigs.length.toLocaleString()} contigs`);
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

  function randomizerInvocation(trackId: string, device: AlleleRandomizerDevice): {
    request: RandomizerRequest;
    selection?: VariantSelection;
    selectionLimit?: number;
  } {
    const selectionLimit = Math.max(1, Math.min(100_000, Math.trunc(device.settings.maximumPositions || 1_000)));
    const selection = symbolicSelection?.selection.trackId === trackId
      ? symbolicSelection.selection
      : undefined;
    const symbolicTotal = selection ? (symbolicSelection?.total ?? 0) : 0;
    if (selection && symbolicTotal > selectionLimit) {
      throw new Error(
        `${symbolicTotal.toLocaleString()} alleles are selected. Mutation Generator accepts at most ${selectionLimit.toLocaleString()} positions per run; narrow the selection or raise Maximum positions.`
      );
    }
    const lane = trackDeck.find((item) => item.track.id === trackId);
    const selectedSet = new Set(selectedAlleleIdsRef.current);
    return {
      request: {
        selectedVariants: selection
          ? []
          : (lane?.variants ?? [])
            .filter((variant) => selectedSet.has(alleleId(variant)))
            .map((variant) => variant.key),
      amount: device.settings.amount,
      seed: device.settings.seed,
      substitutionPattern: device.settings.substitutionPattern,
      transitionProbability: device.settings.transitionProbability
      },
      selection,
      selectionLimit: selection ? selectionLimit : undefined
    };
  }

  function randomizerPreview(plan: RandomizerPreviewResult) {
    return {
      selectedPositions: plan.selectedPositions,
      randomizedPositions: plan.randomizedPositions,
      transitionPositions: plan.transitionPositions,
      transversionPositions: plan.transversionPositions,
      generatedEdits: plan.generatedEdits,
      excludedPositions: plan.excludedPositions,
      changeCount: plan.changeCount,
      changes: plan.changes,
      compoundLayerId: plan.compoundLayerId,
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
    const selectionCount = symbolicSelection?.selection.trackId === trackId
      ? symbolicSelection.total
      : selectedAlleleIdsRef.current.length;
    const background = selectionCount > settings.interactiveAlleleLimit;
    if (!background) setBusy(true);
    setRandomizers((current) => ({
      ...current,
      [trackId]: {
        ...(current[trackId] ?? device),
        status: "running",
        message: background ? "Submitting background preview…" : "Building interactive preview…"
      }
    }));
    try {
      const invocation = randomizerInvocation(trackId, device);
      let plan: RandomizerPreviewResult;
      if (background) {
        const workerThreads = settings.workerThreads === "auto"
          ? Math.max(1, (navigator.hardwareConcurrency || 2) - 1)
          : settings.workerThreads;
        let job = await api.startRandomizerPreviewJob(
          projectPath,
          trackId,
          invocation.request,
          invocation.selection,
          invocation.selectionLimit,
          workerThreads
        );
        while (job.status === "queued" || job.status === "running") {
          setRandomizers((current) => ({
            ...current,
            [trackId]: {
              ...(current[trackId] ?? device),
              status: "running",
              message: `Background job · ${job.progress}% · ${job.message}`
            }
          }));
          await new Promise((resolve) => window.setTimeout(resolve, 250));
          job = await api.backgroundJob<RandomizerPreviewResult>(projectPath, job.id);
        }
        if (job.status !== "completed" || !job.result) {
          throw new Error(job.error ?? job.message ?? `Background job ${job.status}`);
        }
        plan = job.result;
      } else {
        plan = await api.previewRandomizer(
          projectPath,
          trackId,
          invocation.request,
          invocation.selection,
          invocation.selectionLimit
        );
      }
      setRandomizers((current) => ({
        ...current,
        [trackId]: {
          ...(current[trackId] ?? device),
          status: "ready",
          preview: randomizerPreview(plan),
          message: plan.noOpReason ?? (background
            ? `Background preview completed for ${plan.randomizedPositions.toLocaleString()} positions.`
            : `${plan.randomizedPositions} selected positions ready to apply.`)
        }
      }));
      setNotice(plan.noOpReason ?? (background
        ? `Background preview: ${plan.randomizedPositions.toLocaleString()} positions · ${plan.generatedEdits.toLocaleString()} copy-specific changes`
        : `Preview: ${plan.randomizedPositions} positions become ${plan.generatedEdits} reversible mutation blocks`));
    } catch (error) {
      setRandomizers((current) => ({
        ...current,
        [trackId]: { ...(current[trackId] ?? device), status: "error", message: messageOf(error) }
      }));
      setNotice(messageOf(error));
    } finally {
      if (!background) setBusy(false);
    }
  }

  async function applyRandomizer(trackId: string) {
    const device = randomizers[trackId] ?? defaultRandomizer();
    if (!device.preview || device.preview.generatedEdits === 0) return;
    const preview = device.preview;
    setBusy(true);
    setRandomizers((current) => ({
      ...current,
      [trackId]: { ...(current[trackId] ?? device), status: "running", message: "Writing reversible mutation blocks…" }
    }));
    try {
      if (preview.compoundLayerId) {
        const applied = await api.applyCompoundMutationLayer(
          projectPath,
          trackId,
          preview.compoundLayerId
        );
        const generatedEditIds = [applied.generatedEditId];
        setSnapshot(applied.snapshot);
        recordAction({
          kind: "editBatch",
          trackId,
          editIds: generatedEditIds,
          label: `Randomize ${preview.randomizedPositions.toLocaleString()} positions`
        });
        setRandomizers((current) => ({
          ...current,
          [trackId]: {
            ...(current[trackId] ?? device),
            bypassed: false,
            status: "ready",
            generatedEditIds: [...new Set([...(device.generatedEditIds ?? []), ...generatedEditIds])],
            preview: undefined,
            message: `${preview.generatedEdits.toLocaleString()} changes applied as one reversible mutation layer.`
          }
        }));
        resetAlleleSelection([]);
        setSelectedEditId(applied.generatedEditId);
        setEvaluation(undefined);
        setDeviceEvaluations({});
        await refresh(context);
        setNotice(
          `Mutation Generator applied ${preview.generatedEdits.toLocaleString()} changes to the selected track as one reversible layer · Track Meter updated`
        );
        return;
      }
      const invocation = randomizerInvocation(trackId, device);
      const result = await api.runRandomizer(
        projectPath,
        trackId,
        invocation.request,
        invocation.selection,
        invocation.selectionLimit
      );
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
      if (result.generatedEditIds.length > 0
        && result.generatedEditIds.length <= AUTOMATIC_TRACK_ANALYSIS_EDIT_LIMIT
        && lane
        && trackEvidenceDeviceIds(trackId).length > 0) {
        await analyzeTrack(trackId, lane, "automatic");
      } else {
        setNotice(result.generatedEditIds.length > AUTOMATIC_TRACK_ANALYSIS_EDIT_LIMIT
          ? `Mutation Generator added ${result.generatedEditIds.length.toLocaleString()} reversible blocks · automatic Evidence analysis was skipped for this high-volume performance run`
          : `Mutation Generator added ${result.generatedEditIds.length} reversible mutation blocks in Randomizer mode`);
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
    if (operation.edit.kind === "compoundMutationLayer") return;
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
    const compoundChanges = operations
      .filter((operation) => operation.edit.kind === "compoundMutationLayer")
      .reduce((total, operation) => total + (operation.edit.kind === "compoundMutationLayer" ? operation.edit.changeCount : 0), 0);
    if (compoundChanges > 0) {
      const totalBulkMutations = operations.reduce(
        (total, operation) => total + editMutationCount(operation),
        0
      );
      setTrackProfilerRuns((current) => ({
        ...current,
        [trackId]: {
          status: "running",
          processedMutations: 0,
          totalMutations: totalBulkMutations,
          activeAnalyzers: activeDeviceIds.length,
          activeDeviceIds: [...activeDeviceIds],
          message: `Submitting ${totalBulkMutations.toLocaleString()} mutations to the background Evidence profiler…`
        }
      }));
      setNotice(`Track Profiler submitted ${totalBulkMutations.toLocaleString()} mutations as a background job`);
      try {
        const workerThreads = settings.workerThreads === "auto"
          ? Math.max(1, (navigator.hardwareConcurrency || 2) - 1)
          : settings.workerThreads;
        let job = await api.startTrackEvidenceProfileJob(
          projectPath,
          trackId,
          activeDeviceIds,
          workerThreads
        );
        while (job.status === "queued" || job.status === "running") {
          setTrackProfilerRuns((current) => ({
            ...current,
            [trackId]: {
              status: "running",
              processedMutations: Math.min(
                totalBulkMutations,
                Math.round((job.progress / 100) * totalBulkMutations)
              ),
              totalMutations: totalBulkMutations,
              activeAnalyzers: activeDeviceIds.length,
              activeDeviceIds: [...activeDeviceIds],
              progress: job.progress,
              message: job.message
            }
          }));
          await new Promise((resolve) => window.setTimeout(resolve, 500));
          job = await api.backgroundJob<TrackEvidenceProfileResult>(projectPath, job.id);
        }
        if (job.status !== "completed" || !job.result) {
          throw new Error(job.error ?? job.message ?? `Background Track Profiler ${job.status}`);
        }
        const result = job.result;
        setBulkProfiles((current) => ({ ...current, [trackId]: result }));
        const incomplete = result.deviceCoverage.some(
          (coverage) => coverage.evaluated < coverage.total || coverage.errors > 0 || coverage.unavailable > 0
        );
        setTrackProfilerRuns((current) => ({
          ...current,
          [trackId]: {
            status: incomplete ? "partial" : "complete",
            processedMutations: result.activeMutations,
            totalMutations: result.activeMutations,
            activeAnalyzers: activeDeviceIds.length,
            activeDeviceIds: [...activeDeviceIds],
            message: incomplete
              ? `Background profile completed with incomplete Evidence coverage across ${result.activeMutations.toLocaleString()} mutations.`
              : `Background profile completed for ${result.activeMutations.toLocaleString()} mutations with ${activeDeviceIds.length} Evidence devices.`
          }
        }));
        setNotice(incomplete ? "Background Track Profile completed with partial Evidence coverage" : "Background Track Profile is complete");
      } catch (error) {
        setTrackProfilerRuns((current) => ({
          ...current,
          [trackId]: {
            status: "partial",
            processedMutations: 0,
            totalMutations: totalBulkMutations,
            activeAnalyzers: activeDeviceIds.length,
            activeDeviceIds: [...activeDeviceIds],
            message: messageOf(error)
          }
        }));
        setNotice(messageOf(error));
      }
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
      if (operation.edit.kind === "compoundMutationLayer") continue;
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

  function renderVariantNavigationBins(bins: VariantNavigationBin[]) {
    return bins.map((bin) => {
      const scope = variantNavigationScope(bin.contig, bin.start, bin.end);
      const leaf = bin.end - bin.start + 1 <= VARIANT_NAVIGATION_LEAF_SPAN;
      const containsFocus = context.contig === bin.contig
        && bin.start <= contextMidpoint
        && bin.end >= contextMidpoint;
      const expanded = expandedVariantBins.includes(scope);
      const loading = variantNavigationLoading.includes(scope);
      const children = variantBinsByScope[scope] ?? [];
      return (
        <div className="variant-bin-node" key={scope}>
          <button
            type="button"
            className={`variant-bin-toggle${allTrackSelectionActive ? " selected" : ""}${containsFocus ? " active" : ""}`}
            aria-expanded={leaf ? undefined : expanded}
            aria-current={leaf && containsFocus ? "location" : undefined}
            onClick={() => void activateNavigationBin(bin)}
          >
            <span>{leaf ? "•" : expanded ? "▾" : "▸"} {bin.start.toLocaleString()}–{bin.end.toLocaleString()}</span>
            <small>{bin.total.toLocaleString()}</small>
          </button>
          {!leaf && expanded && <div className="variant-bin-children">
            {loading && <div className="variant-navigation-status">Loading narrower regions…</div>}
            {!loading && renderVariantNavigationBins(children)}
          </div>}
          {leaf && containsFocus && <div className="variant-bin-alleles">
            {navigationVariants.map((variant) => {
              const id = alleleId(variant);
              const selectedByScope = allTrackSelectionActive
                ? !allTrackSelectionExclusions.has(id)
                : selectedAlleleIdSet.has(id);
              const focused = Boolean(selected && variantLabel(selected.key) === variantLabel(variant.key));
              return (
                <button
                  key={variant.key.assembly + variantLabel(variant.key)}
                  className={`variant-item${selectedByScope ? " selected" : ""}${focused ? " active" : ""}`}
                  aria-pressed={selectedByScope}
                  onClick={() => focusVariant(variant)}
                >
                  <span>{variant.key.position.toLocaleString()}</span>
                  <b>{variant.key.reference}<i>›</i>{variant.key.alternate}</b>
                  <small><em className={variant.origin}>{variant.origin}</em>{variantPhaseLabel(variant)}</small>
                </button>
              );
            })}
            {navigationVariants.length === 0 && <div className="variant-navigation-status">No source alleles in the focused interval</div>}
            {focusedSourceVariants && focusedSourceVariants.length > VARIANT_NAVIGATION_ALLELE_LIMIT && <div className="variant-navigation-status">Showing the first {VARIANT_NAVIGATION_ALLELE_LIMIT.toLocaleString()} alleles in this region</div>}
          </div>}
        </div>
      );
    });
  }

  return (
    <main className={`workstation${settings.showVariantBrowser ? "" : " hide-variants"}${settings.showEvidenceInspector ? "" : " hide-evidence"}`}>
      <header className="app-header">
        <div className="mini-brand"><img src="/dgw-mark.svg" alt="" /></div>
        <div><strong title={projectPath}>{snapshot.manifest.name}</strong><span>{snapshot.manifest.selectedSample} · {snapshot.manifest.assembly}</span></div>
        <div className="header-spacer" />
        <div className={`worker-state${busy || runningDeviceId ? " processing" : ""}`}>
          <span className={busy || runningDeviceId ? "pulse" : "status-dot"} />
          {busy || runningDeviceId ? <><b>Processing</b><i>·</i></> : null}{notice}
        </div>
      </header>

      <aside className="variant-browser">
        <div className="section-title">
          <span>Source Variants</span>
          <small>{allTrackSelectionActive
            ? `✓ ${symbolicSelection?.total.toLocaleString()} selected`
            : `${variantContigs.length.toLocaleString()} contigs · ${navigationVariantTotal.toLocaleString()}`}</small>
        </div>
        <div className="variant-list variant-tree">
          {variantContigs.map((summary) => {
            const expanded = expandedVariantContigs.includes(summary.contig);
            const loading = variantNavigationLoading.includes(summary.contig);
            const bins = variantBinsByScope[summary.contig] ?? [];
            return (
              <section className={`variant-contig-node${allTrackSelectionActive ? " selected" : ""}${context.contig === summary.contig ? " active" : ""}`} key={summary.contig}>
                <button
                  type="button"
                  className="variant-contig-toggle"
                  aria-expanded={expanded}
                  onClick={() => toggleVariantContig(summary.contig)}
                >
                  <span className="disclosure-mark">{expanded ? "▾" : "▸"}</span>
                  <b>CHR {summary.contig}</b>
                  <small>{summary.total.toLocaleString()}</small>
                </button>
                {expanded && <div className="variant-bin-list">
                  {loading && <div className="variant-navigation-status">Loading occupied regions…</div>}
                  {!loading && renderVariantNavigationBins(bins)}
                </div>}
              </section>
            );
          })}
          {variantContigs.length === 0 && <div className="variant-navigation-status">Loading contigs…</div>}
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
            interactiveAlleleLimit={settings.interactiveAlleleLimit}
            allAllelesSelected={allTrackSelectionActive}
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
              onSelectVariant={(variant) => { void openTrackAllele(activeTrack.id, alleleId(variant)); }}
              onShowDevices={() => {
                onShowDeviceRack();
                setDetailMode("devices");
              }}
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
            onShowDeviceRack={onShowDeviceRack}
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
        {symbolicSelection && <div className="selection-scope-summary">
          <b>{symbolicSelection.total.toLocaleString()} active variant alleles selected across every contig</b>
          <span>{selectedAlleleIds.length.toLocaleString()} are currently shown. Devices receive the complete symbolic selection; Evidence below remains specific to one focused allele.</span>
        </div>}
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
  const [jobsOpen, setJobsOpen] = useState(false);
  const [jobs, setJobs] = useState<BackgroundJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
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

  useEffect(() => {
    if (!jobsOpen || !projectPath) return;
    let disposed = false;
    async function refreshJobs() {
      setJobsLoading(true);
      try {
        const next = await api.listBackgroundJobs(projectPath);
        if (!disposed) setJobs(next);
      } finally {
        if (!disposed) setJobsLoading(false);
      }
    }
    void refreshJobs();
    const timer = window.setInterval(() => { void refreshJobs(); }, 750);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [jobsOpen, projectPath]);

  function closeProject() {
    setSnapshot(undefined);
    setProjectPath("");
    setExportRequest(undefined);
    setHistoryRequest(undefined);
    setDeviceBrowserRequest(0);
    setJobsOpen(false);
    setJobs([]);
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
      onOpenJobs={() => setJobsOpen(true)}
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
          onShowDeviceRack={() => setSettings((current) => ({ ...current, showDeviceRack: true }))}
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
    <JobsDialog
      open={jobsOpen}
      jobs={jobs}
      loading={jobsLoading}
      onRefresh={() => {
        if (!projectPath) return;
        setJobsLoading(true);
        void api.listBackgroundJobs(projectPath).then(setJobs).finally(() => setJobsLoading(false));
      }}
      onCancel={(jobId) => {
        if (!projectPath) return;
        void api.cancelBackgroundJob(projectPath, jobId).then((cancelled) => {
          setJobs((current) => current.map((job) => job.id === cancelled.id ? cancelled : job));
        });
      }}
      onClose={() => setJobsOpen(false)}
    />
    <SettingsDialog open={settingsOpen} settings={settings} onChange={setSettings} onClose={() => setSettingsOpen(false)} />
  </div>;
}
