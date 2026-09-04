import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { confirm as confirmDialog, message as messageDialog, open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api } from "./api";
import { ApplicationMenu, JobsDialog, ProjectTemplateDialog, SettingsDialog, type ExampleProjectId, type ProjectTemplateId } from "./ApplicationChrome";
import {
  TrackDeviceWorkspace,
  type AlleleRandomizerDevice,
  type AlleleRandomizerSettings,
  type GenomeOptimizerDevice,
  type GenomeOptimizerSettings,
  type GenomeMorphDevice,
  type GenomeMorphSettings,
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
  GeneSearchHit,
  GenomeTrack,
  GenomeTrackLane,
  Haplotype,
  OptimizerRequest,
  OptimizerBackgroundResult,
  ProcessProgress,
  ProjectSnapshot,
  RandomizerPreviewResult,
  RandomizerRequest,
  ResourceBundle,
  TrackEvidenceProfileResult,
  TrackMorphPreviewResult,
  TransportCursor,
  TransportTarget,
  TransportTargetKind,
  VariantSelection,
  VariantContigSummary,
  VariantNavigationBin,
  VariantDensity,
  VariantKey,
  VcfInspection,
  WorkspaceSnapshot
} from "./types";
import { chromosomeLabel, filterSamples, haplotypeLabel, parentDirectory, projectSlug, sequenceChunks, sequenceDisplayParts, shortId, variantLabel, variantPhaseLabel } from "./utils";
import { consequenceImpactSignal } from "./trackMeter";
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
import { GenomeOverviewNavigator } from "./GenomeOverviewNavigator";
import { GenomeTransportBar, type TransportState } from "./GenomeTransportBar";
import {
  CONTEXT_HELP_TOPICS,
  DEFAULT_CONTEXT_HELP_KEY
} from "./ContextHelp";
import { ContextHelpPanel } from "./ContextHelpPanel";
import { focusViewport, viewportSpan } from "./genomeViewport";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DEVICE_IDS = {
  consequence: "org.dgw.builtin.variant-consequences",
  dbnsfp: "org.dgw.builtin.dbnsfp",
  clinvar: "org.dgw.builtin.clinvar",
  cosmic: "org.dgw.builtin.cosmic",
  randomizer: "org.dgw.builtin.mutation-generator",
  morph: "org.dgw.builtin.genome-morph",
  optimizer: "org.dgw.builtin.genome-optimizer",
  variantMap: "org.dgw.builtin.variant-map"
} as const;

const LEGACY_SNPEFF_DEVICE_ID = "org.dgw.builtin.snpeff";

function canonicalDeviceId(deviceId: string) {
  return deviceId === LEGACY_SNPEFF_DEVICE_ID ? DEVICE_IDS.consequence : deviceId;
}

function canonicalDeviceMap(devicesByTrack: Record<string, string[]> = {}) {
  return Object.fromEntries(Object.entries(devicesByTrack).map(([trackId, deviceIds]) => [
    trackId,
    [...new Set(deviceIds.map(canonicalDeviceId))]
  ]));
}

const VARIANT_NAVIGATION_BIN_COUNT = 24;
const VARIANT_NAVIGATION_ALLELE_LIMIT = 200;
const VARIANT_NAVIGATION_LEAF_SPAN = 50_001;
const OPTIMIZER_INTERACTIVE_POSITION_LIMIT = 100;

function variantNavigationScope(contig: string, start?: number, end?: number): string {
  return start === undefined || end === undefined ? contig : `${contig}:${start}-${end}`;
}

const optimizerObjectives: OptimizerObjective[] = [
  {
    id: "predictedImpactBurden",
    label: "Weighted annotation burden",
    description: "Compares live exact-allele transcript consequences among non-reference SNV candidates. It does not assume the reference allele is benign, and imported VCF annotations are never used.",
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
  { id: "impact", label: "Impact", sourceDeviceId: DEVICE_IDS.consequence, sourceLabel: "Variant Consequences", description: "Weight of the live transcript-consequence impact result for each exact allele.", min: 0, max: 100, step: 5 }
];

function alleleId(variant: EffectiveVariant) {
  return variantKeyId(variant.key);
}

function variantKeyId(key: VariantKey) {
  return `${key.assembly}:${key.contig}:${key.position}:${key.reference}:${key.alternate}`;
}

const alleleDeviceIds = [DEVICE_IDS.consequence, DEVICE_IDS.dbnsfp, DEVICE_IDS.clinvar, DEVICE_IDS.cosmic];
const rackCompactDeviceIds = [...alleleDeviceIds, DEVICE_IDS.variantMap];
const dgwStarterDeviceIds = [DEVICE_IDS.randomizer, DEVICE_IDS.morph, ...alleleDeviceIds, DEVICE_IDS.optimizer, DEVICE_IDS.variantMap];

type DeviceEvidenceMap = Record<string, EvidenceResult>;

interface MeterEditEvaluation {
  sourceEvidence: DeviceEvidenceMap;
  currentEvidence: DeviceEvidenceMap;
  currentIsReference: boolean;
  evaluatedDeviceIds: string[];
}

type ResettableDeviceSnapshot =
  | { deviceId: typeof DEVICE_IDS.optimizer; value: GenomeOptimizerDevice }
  | { deviceId: typeof DEVICE_IDS.randomizer; value: AlleleRandomizerDevice }
  | { deviceId: typeof DEVICE_IDS.morph; value: GenomeMorphDevice };

type WorkstationAction =
  | { kind: "alleleSelection"; trackId: string; before: string[]; after: string[]; label: string }
  | { kind: "renameTrack"; trackId: string; before: string; after: string }
  | { kind: "editBatch"; trackId: string; editIds: string[]; label: string }
  | { kind: "deviceReset"; trackId: string; before: ResettableDeviceSnapshot; after: ResettableDeviceSnapshot; label: string };

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

interface WorkstationSessionV1 {
  schemaVersion: 1;
  context: FocusContext;
  activeGene?: GeneSearchHit;
  selectedVariant?: VariantKey;
  selectedAlleleIds: string[];
  symbolicSelection?: { selection: VariantSelection; total: number };
  detailMode: "devices" | "allele";
  selectedDeviceId: string;
  hiddenTrackIds: string[];
  appliedDevicesByTrack: Record<string, string[]>;
  bypassedDevicesByTrack: Record<string, string[]>;
  optimizers: Record<string, GenomeOptimizerDevice>;
  randomizers: Record<string, AlleleRandomizerDevice>;
  morphs: Record<string, GenomeMorphDevice>;
  undoActions: WorkstationAction[];
  redoActions: WorkstationAction[];
  transportKind?: TransportTargetKind;
  transportLoop?: boolean;
}

interface ProjectSaveState {
  status: "saving" | "saved" | "error";
  message: string;
  savedAt?: string;
}

interface RecentProject {
  path: string;
  name: string;
  openedAt: string;
}

const RECENT_PROJECTS_STORAGE_KEY = "dgw.recent-projects.v1";

function parseRecentProjects(value: string | null): RecentProject[] {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is RecentProject => Boolean(item)
        && typeof item.path === "string"
        && typeof item.name === "string"
        && typeof item.openedAt === "string").slice(0, 8)
      : [];
  } catch {
    return [];
  }
}

function isWorkstationSession(value: unknown): value is WorkstationSessionV1 {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<WorkstationSessionV1>;
  return session.schemaVersion === 1
    && Boolean(session.context)
    && typeof session.context?.contig === "string"
    && typeof session.context?.start === "number"
    && typeof session.context?.end === "number"
    && session.context.start >= 1
    && session.context.end >= session.context.start;
}

function resumableOptimizer(device: GenomeOptimizerDevice): GenomeOptimizerDevice {
  return { ...device, status: device.status === "running" ? "ready" : device.status, progress: undefined };
}

function resumableRandomizer(device: AlleleRandomizerDevice): AlleleRandomizerDevice {
  return { ...device, status: device.status === "running" ? "ready" : device.status };
}

function resumableMorph(device: GenomeMorphDevice): GenomeMorphDevice {
  return { ...device, status: device.status === "running" ? "ready" : device.status, progress: undefined };
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
    if (evidence.source.startsWith("Variant Consequences")) {
      const hasTranscriptFeature = evidence.records.some((record) => record.effect !== "no_transcript_feature");
      if (!hasTranscriptFeature) return "No overlapping transcript feature";
      return `${evidence.records.length.toLocaleString()} ${evidence.records.length === 1 ? "transcript consequence" : "transcript consequences"}`;
    }
    return `${evidence.records.length.toLocaleString()} exact ${evidence.records.length === 1 ? "result" : "results"}`;
  }
  if (evidence.status === "noExactMatch") return "No exact normalized allele match";
  return evidence.message ?? evidence.status.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
}

function evaluationEvidence(result: EvaluationResult): DeviceEvidenceMap {
  return {
    [DEVICE_IDS.consequence]: result.consequence,
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
      maxEdits: 5,
      maximumPositions: 1_000
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

function defaultMorph(targetTrackId = ""): GenomeMorphDevice {
  return {
    id: DEVICE_IDS.morph,
    name: "Genome Morph",
    bypassed: false,
    status: "ready",
    settings: { targetTrackId, amount: 50, ordering: "genomic", seed: 42 },
    message: "Choose another compatible project track and preview a discrete intermediate state.",
    rackOrder: 7,
    limitation: "Intermediate states are synthetic editing scenarios, not evolutionary generations, ancestors, descendants, offspring, or predictions of biological viability."
  };
}

function sameOptimizerSettings(left: GenomeOptimizerSettings, right: GenomeOptimizerSettings) {
  return left.mode === right.mode
    && left.objectiveId === right.objectiveId
    && left.direction === right.direction
    && left.maxEdits === right.maxEdits
    && left.maximumPositions === right.maximumPositions
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

async function createBundledExampleProject(
  exampleId: ExampleProjectId,
  onStatus?: (message: string, progress?: ProcessProgress) => void
): Promise<{ projectPath: string; snapshot: ProjectSnapshot }> {
  const assembly = exampleId === "alleleEditingB37" || exampleId === "hg00103Wes" ? "b37" : "hg38";
  const fixtureId = exampleId === "hg00103Wes" ? exampleId : "alleleEditing";
  const assemblyLabel = assembly === "hg38" ? "GRCh38" : "GRCh37";
  onStatus?.(`Preparing the ${assemblyLabel} example project…`);
  const [example, bundles] = await Promise.all([
    api.exampleFixture(assembly, fixtureId),
    api.suggestedBundles()
  ]);
  const resourceBundle = bundles.find((candidate) => candidate.assembly === assembly);
  if (!resourceBundle) throw new Error(`The ${assemblyLabel} resource profile required by the example is unavailable.`);

  const created = await api.createProject({
    projectPath: example.projectPath,
    name: example.projectName,
    sourceVcfPath: example.path,
    selectedSample: example.sample,
    resourceBundle
  }, (progress) => onStatus?.(progress.message, progress));
  const sourceTrack = created.tracks.find((track) => track.readOnly);
  if (!sourceTrack) throw new Error("The example project has no source genome track.");

  if (exampleId === "hg00103Wes") {
    const workingTrack = created.tracks.find((track) => !track.readOnly);
    if (!workingTrack) throw new Error("The public exome example has no editable genome track.");
    onStatus?.("Preparing the multi-chromosome exome workspace…");
    const renamed = await api.renameTrack(example.projectPath, workingTrack.id, "HG00103 WES · working track");
    const gene = (await api.searchGenes(example.projectPath, "LDLR", 5))
      .find((candidate) => candidate.symbol.toUpperCase() === "LDLR");
    if (!gene) throw new Error("The GRCh37 gene resource does not contain LDLR.");
    const snapshot = await api.saveWorkspace(example.projectPath, {
      ...renamed.workspace,
      focus: { contig: gene.contig, start: gene.start, end: gene.end }
    });
    onStatus?.("Opening the public exome example…");
    return { projectPath: example.projectPath, snapshot };
  }

  const contig = assembly === "hg38" ? "chr7" : "7";
  const position = assembly === "hg38" ? 140_753_336 : 140_453_136;
  const sourceKey: VariantKey = {
    assembly,
    contig,
    position,
    reference: "A",
    alternate: "T"
  };

  onStatus?.("Creating the example genome tracks…");
  const restored = await api.duplicateTrack(example.projectPath, sourceTrack.id, "BRAF · restore to REF");
  await api.applyEdit(
    example.projectPath,
    restored.activeTrack.headStateId,
    "unphased",
    { kind: "restoreReference", sourceKey },
    [],
    "Example edit: restore the selected BRAF ALT to the reference base and compare its evidence with the source genome.",
    restored.activeTrack.id
  );

  const alternative = await api.duplicateTrack(example.projectPath, sourceTrack.id, "BRAF · alternative ALT");
  await api.applyEdit(
    example.projectPath,
    alternative.activeTrack.headStateId,
    "unphased",
    {
      kind: "setAllele",
      key: { ...sourceKey, alternate: "C" },
      sourceKey
    },
    [],
    "Example edit: replace the source BRAF ALT with another possible SNV allele at the same position.",
    alternative.activeTrack.id
  );

  onStatus?.("Opening the prepared example…");
  const snapshot = await api.selectTrack(example.projectPath, restored.activeTrack.id);
  return { projectPath: example.projectPath, snapshot };
}

function Onboarding({ projectTemplate, onOpened }: { projectTemplate: ProjectTemplateId; onOpened: (path: string, snapshot: ProjectSnapshot, created: boolean, unsavedExample?: boolean) => void }) {
  const [bundles, setBundles] = useState<ResourceBundle[]>([]);
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
    api.suggestedBundles()
      .then((values) => {
        const value = values.find((candidate) => candidate.assembly === "b37") ?? values[0];
        setBundles(values);
        setBundle(value);
        setBundleText(JSON.stringify(value, null, 2));
        setStatus("Choose a reference profile, then select a VCF.");
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
    options?: { preferredSample?: string; projectName?: string; projectPath?: string; example?: boolean; assembly?: string }
  ): Promise<VcfInspection> {
    const assembly = options?.assembly ?? bundle?.assembly;
    if (!assembly) throw new Error("Choose a reference profile before inspecting a VCF.");
    const result = await api.inspectVcf(selected, assembly, receiveProgress);
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
    const selectedBundle = bundles.find((candidate) => candidate.assembly === assembly) ?? bundle;
    if (selectedBundle && result.inputContigStyle !== selectedBundle.contigStyle) {
      nextInputWarnings.push(
        `Input contigs use ${result.inputContigStyle === "chr_prefix" ? "chr-prefixed" : result.inputContigStyle === "no_chr_prefix" ? "unprefixed" : "mixed"} names. DGW will map retained variants to the ${selectedBundle.contigStyle === "chr_prefix" ? "chr-prefixed" : "unprefixed"} reference convention before normalization.`
      );
    }
    setInputWarnings(nextInputWarnings);
    setStatus(
      `${options?.example ? "Example ready · " : ""}${result.supportedRecordCount.toLocaleString()} importable PASS small-variant records of ${result.recordCount.toLocaleString()} total · ${result.nonPassRecordCount.toLocaleString()} non-PASS excluded · ${result.samples.length.toLocaleString()} ${result.samples.length === 1 ? "sample" : "samples"} · input INFO annotations will be ignored`
    );
    return result;
  }

  async function loadExample(exampleId: ExampleProjectId) {
    const assembly = exampleId === "alleleEditingHg38" ? "hg38" : "b37";
    setBusy(true);
    setProcessSteps([]);
    const assemblyLabel = assembly === "hg38" ? "GRCh38" : "GRCh37";
    setStatus(`Opening the prepared ${assemblyLabel} example project…`);
    try {
      const example = await createBundledExampleProject(
        exampleId,
        (message, progress) => {
        setStatus(message);
        if (progress) receiveProgress(progress);
        }
      );
      onOpened(example.projectPath, example.snapshot, true, true);
    } catch (error) {
      setStatus(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function selectReferenceProfile(assembly: string) {
    const next = bundles.find((candidate) => candidate.assembly === assembly);
    if (!next) return;
    setBundle(next);
    setBundleText(JSON.stringify(next, null, 2));
    setWarnings([]);
    setStatus(`${assembly === "hg38" ? "GRCh38 (hg38)" : "GRCh37 (b37/hs37d5)"} selected.`);
    if (!sourcePath) return;
    setBusy(true);
    setProcessSteps([]);
    try {
      await inspectSelectedVcf(sourcePath, { preferredSample: sample, assembly });
    } catch (error) {
      setInspection(undefined);
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
        <h1>Edit and compare genome variants.</h1>
        <p className="lede">
          Load one sample from a VCF and test allele changes on independent tracks without changing the source.
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
          <div><p className="eyebrow">Start a project</p><h2>Open or create a genome workspace</h2><small>{projectTemplate === "standardEvidence" ? "DGW Starter template" : "Empty template"}</small></div>
          <button className="button ghost" onClick={openExisting} disabled={busy}>Open .dgw</button>
        </div>

        <section className="example-projects" aria-label="Example projects">
          <header><b>Open an example</b><small>Start with a fresh, unsaved copy</small></header>
          <div>
            <button type="button" aria-label="Open GRCh37 example project" onClick={() => { void loadExample("alleleEditingB37"); }} disabled={busy}>
              <b>Allele Editing</b><span>GRCh37</span><small>Synthetic · 3 prepared tracks</small>
            </button>
            <button type="button" aria-label="Open GRCh38 example project" onClick={() => { void loadExample("alleleEditingHg38"); }} disabled={busy}>
              <b>Allele Editing</b><span>GRCh38</span><small>Synthetic · 3 prepared tracks</small>
            </button>
            <button type="button" aria-label="Open HG00103 exome example" onClick={() => { void loadExample("hg00103Wes"); }} disabled={busy}>
              <b>HG00103 exome</b><span>GRCh37</span><small>1000 Genomes WES · 19.6K alleles</small>
            </button>
          </div>
        </section>

        <div className="start-divider"><span>or import a VCF</span></div>

        <div className="reference-profile-choice">
          <label htmlFor="reference-profile">Reference profile</label>
          <select id="reference-profile" value={bundle?.assembly ?? ""} disabled={busy} onChange={(event) => { void selectReferenceProfile(event.target.value); }}>
            {bundles.map((candidate) => <option value={candidate.assembly} key={candidate.id}>
              {candidate.assembly === "hg38" ? "GRCh38 (hg38)" : "GRCh37 (b37/hs37d5)"}
            </option>)}
          </select>
          <small>The assembly is pinned when the project is created. DGW does not perform liftover.</small>
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
            <button className="file-picker" onClick={chooseVcf} disabled={busy}>
              <span>{sourcePath || "Choose .vcf or .vcf.gz"}</span><b>Browse</b>
            </button>
            <details className="input-guidance">
              <summary>Input details</summary>
              <small>DGW normalizes a project copy against the configured reference; the source VCF is never changed. Imported INFO annotations are optional and ignored.</small>
            </details>
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
            <label>Project location
              <span className="input-with-action"><input value={projectPath} onChange={(event) => setProjectPath(event.target.value)} /><button onClick={chooseProjectParent}>…</button></span>
              <small className="project-location-note">DGW creates one self-contained <code>.dgw</code> project directory here.</small>
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
        <div className="setup-submit">
          <button className="button primary wide" onClick={create} disabled={busy || !bundle || !inspection || inspection.supportedRecordCount === 0 || !sample || !projectPath}>
            {busy ? "Working…" : "Open genome workspace"}
          </button>
        </div>
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
  consequenceEvidence
}: {
  variant?: EffectiveVariant;
  referenceSequence?: string;
  context: FocusContext;
  consequenceEvidence?: EvidenceResult;
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
  const annotationRows = consequenceEvidence?.status === "found" ? consequenceEvidence.records : [];
  const unique = (key: "effect" | "geneName" | "aminoAcidChange") => [
    ...new Set(annotationRows.map((record) => record[key]).filter(Boolean))
  ];
  const consequence = unique("effect").join(" + ");
  const consequenceDetails = [
    unique("geneName").join(" / "),
    unique("aminoAcidChange").slice(0, 3).join(" / "),
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
        <span>Live transcript prediction</span>
        <b>{consequence || (consequenceEvidence ? evidenceSummary(consequenceEvidence) : "No live result yet")}</b>
        {consequenceDetails.length > 0 && <small>{consequenceDetails.join(" · ")}</small>}
      </div>
    </div>
  );
}

function EvidenceCard({ evidence }: { evidence: EvidenceResult }) {
  const important = evidence.records[0];
  const highlights = important
    ? ["effect", "impact", "geneName", "featureId", "transcriptBiotype", "strand", "dnaChange", "aminoAcidChange", "engine", "engineVersion", "annotationRelease", "hgvsC", "hgvsP", "CADD_phred", "REVEL_score", "SIFT_score", "Polyphen2_HDIV_score", "CLNSIG", "CLNREVSTAT", "GENEINFO", "ONC", "SCI", "id", "CNT"]
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
  consequenceEvidence,
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
  consequenceEvidence?: EvidenceResult;
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
          <VariantChangeLens variant={variant} referenceSequence={focus?.referenceSequence} context={context} consequenceEvidence={consequenceEvidence} />
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
  onShowEvidencePanel,
  onContextHelpVisibilityChange,
  onHistoryStateChange,
  onSessionSaverChange,
  onSaveStateChange
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
  onShowEvidencePanel: () => void;
  onContextHelpVisibilityChange: (visible: boolean) => void;
  onHistoryStateChange: (state: WorkstationHistoryState) => void;
  onSessionSaverChange: (saver?: () => Promise<void>) => void;
  onSaveStateChange: (state: ProjectSaveState) => void;
}) {
  const initial = snapshot.workspace.focus ?? (snapshot.variants[0] ? {
    contig: snapshot.variants[0].key.contig,
    start: Math.max(1, snapshot.variants[0].key.position - 35),
    end: snapshot.variants[0].key.position + 35
  } : { contig: "1", start: 1, end: 80 });
  const [context, setContext] = useState<FocusContext>(initial);
  const initialViewportRef = useRef<FocusContext>(initial);
  const [focus, setFocus] = useState<FocusView>();
  const [contigDensity, setContigDensity] = useState<VariantDensity>();
  const [viewportDensity, setViewportDensity] = useState<VariantDensity>();
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
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>(DEVICE_IDS.consequence);
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
  const [geneQuery, setGeneQuery] = useState("");
  const [geneResults, setGeneResults] = useState<GeneSearchHit[]>([]);
  const [geneSearchLoading, setGeneSearchLoading] = useState(false);
  const [geneSearchError, setGeneSearchError] = useState<string>();
  const [activeGene, setActiveGene] = useState<GeneSearchHit>();
  const [selectedEditId, setSelectedEditId] = useState<string>();
  const [hiddenTrackIds, setHiddenTrackIds] = useState<string[]>([]);
  const [optimizers, setOptimizers] = useState<Record<string, GenomeOptimizerDevice>>({});
  const [randomizers, setRandomizers] = useState<Record<string, AlleleRandomizerDevice>>({});
  const [morphs, setMorphs] = useState<Record<string, GenomeMorphDevice>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("Ready");
  const [sessionHydrated, setSessionHydrated] = useState(false);
  const [detailMode, setDetailMode] = useState<"devices" | "allele">("devices");
  const [transportKind, setTransportKind] = useState<TransportTargetKind>("variants");
  const [transportLoop, setTransportLoop] = useState(false);
  const [transportState, setTransportState] = useState<TransportState>("idle");
  const [transportTarget, setTransportTarget] = useState<TransportTarget>();
  const [contextHelpKey, setContextHelpKey] = useState(DEFAULT_CONTEXT_HELP_KEY);
  const [contextHelpPinned, setContextHelpPinned] = useState(false);
  const [meterEvaluations, setMeterEvaluations] = useState<Record<string, Record<string, MeterEditEvaluation>>>({});
  const [bulkProfiles, setBulkProfiles] = useState<Record<string, TrackEvidenceProfileResult>>({});
  const [trackProfilerRuns, setTrackProfilerRuns] = useState<Record<string, TrackProfilerModel>>({});
  const [trackProfileFingerprints, setTrackProfileFingerprints] = useState<Record<string, string>>({});
  const evaluationGeneration = useRef(0);
  const selectedAlleleEvidenceCache = useRef<SelectedAlleleEvidenceCache>(new Map());
  const evidenceRequests = useRef<Map<string, Promise<EvidenceResult>>>(new Map());
  const automaticEvaluationTimer = useRef<number | undefined>(undefined);
  const automaticProfileTimer = useRef<number | undefined>(undefined);
  const profileRequestsInFlight = useRef<Set<string>>(new Set());
  const focusRefreshGeneration = useRef(0);
  const viewportRefreshTimer = useRef<number | undefined>(undefined);
  const handledExportRequest = useRef(0);
  const handledHistoryRequest = useRef(0);
  const handledDeviceBrowserRequest = useRef(0);
  const transportGeneration = useRef(0);
  const transportLoopRef = useRef(false);
  const transportStartRef = useRef<{ context: FocusContext; selected?: EffectiveVariant; selectedEditId?: string } | undefined>(undefined);
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
  const activeGeneSelection = Boolean(activeGene
    && symbolicSelection?.selection.kind === "interval"
    && symbolicSelection.selection.trackId === activeTrack.id
    && symbolicSelection.selection.contig === activeGene.contig
    && symbolicSelection.selection.start === activeGene.start
    && symbolicSelection.selection.end === activeGene.end);
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
  const workstationSession = useMemo<WorkstationSessionV1>(() => ({
    schemaVersion: 1,
    context,
    activeGene,
    selectedVariant: selected?.key,
    selectedAlleleIds,
    symbolicSelection,
    detailMode,
    selectedDeviceId,
    hiddenTrackIds,
    appliedDevicesByTrack,
    bypassedDevicesByTrack,
    optimizers: Object.fromEntries(Object.entries(optimizers).map(([trackId, device]) => [trackId, resumableOptimizer(device)])),
    randomizers: Object.fromEntries(Object.entries(randomizers).map(([trackId, device]) => [trackId, resumableRandomizer(device)])),
    morphs: Object.fromEntries(Object.entries(morphs).map(([trackId, device]) => [trackId, resumableMorph(device)])),
    undoActions,
    redoActions,
    transportKind,
    transportLoop
  }), [activeGene, appliedDevicesByTrack, bypassedDevicesByTrack, context, detailMode, hiddenTrackIds, morphs, optimizers, randomizers, redoActions, selected, selectedAlleleIds, selectedDeviceId, symbolicSelection, transportKind, transportLoop, undoActions]);
  const workstationSessionJson = useMemo(() => JSON.stringify(workstationSession), [workstationSession]);
  const saveSequenceRef = useRef<Promise<unknown>>(Promise.resolve());
  const persistWorkstationSession = useCallback(async () => {
    if (!sessionHydrated) return;
    const payload = JSON.parse(workstationSessionJson) as WorkstationSessionV1;
    onSaveStateChange({ status: "saving", message: "Saving project…" });
    const operation = saveSequenceRef.current
      .catch(() => undefined)
      .then(() => api.saveWorkstationSession(projectPath, payload));
    saveSequenceRef.current = operation;
    try {
      const savedAt = await operation;
      onSaveStateChange({ status: "saved", message: "All project changes saved", savedAt });
    } catch (error) {
      onSaveStateChange({ status: "error", message: messageOf(error) });
      throw error;
    }
  }, [onSaveStateChange, projectPath, sessionHydrated, workstationSessionJson]);

  useEffect(() => {
    onSessionSaverChange(persistWorkstationSession);
    return () => onSessionSaverChange(undefined);
  }, [onSessionSaverChange, persistWorkstationSession]);

  useEffect(() => {
    if (!sessionHydrated) return;
    const timer = window.setTimeout(() => {
      void persistWorkstationSession().catch(() => undefined);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [persistWorkstationSession, sessionHydrated]);

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
    const query = geneQuery.trim();
    if (!snapshot.manifest.resourceBundle.geneAnnotation || query.length === 0) {
      setGeneResults([]);
      setGeneSearchLoading(false);
      setGeneSearchError(undefined);
      return;
    }
    if (activeGene && (query.toUpperCase() === activeGene.symbol.toUpperCase() || query.toUpperCase() === activeGene.geneId.toUpperCase())) {
      setGeneResults([]);
      setGeneSearchLoading(false);
      setGeneSearchError(undefined);
      return;
    }
    let cancelled = false;
    setGeneSearchLoading(true);
    setGeneSearchError(undefined);
    const timer = window.setTimeout(() => {
      void api.searchGenes(projectPath, query)
        .then((results) => {
          if (!cancelled) setGeneResults(results);
        })
        .catch((error) => {
          if (!cancelled) {
            setGeneResults([]);
            setGeneSearchError(messageOf(error));
          }
        })
        .finally(() => {
          if (!cancelled) setGeneSearchLoading(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeGene, geneQuery, projectPath, snapshot.manifest.resourceBundle.geneAnnotation]);

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
    [DEVICE_IDS.consequence]: deviceEvaluations[DEVICE_IDS.consequence] ?? evaluation?.consequence,
    [DEVICE_IDS.dbnsfp]: deviceEvaluations[DEVICE_IDS.dbnsfp] ?? evaluation?.dbnsfp,
    [DEVICE_IDS.clinvar]: deviceEvaluations[DEVICE_IDS.clinvar] ?? evaluation?.clinvar,
    [DEVICE_IDS.cosmic]: deviceEvaluations[DEVICE_IDS.cosmic] ?? evaluation?.cosmic
  }), [deviceEvaluations, evaluation]);
  const rackDevices = useMemo<RackDeviceView[]>(() => {
    const bundle = snapshot.manifest.resourceBundle;
    const order = new Map<string, number>([
      [DEVICE_IDS.consequence, 10],
      [DEVICE_IDS.dbnsfp, 20],
      [DEVICE_IDS.clinvar, 30],
      [DEVICE_IDS.cosmic, 40],
      [DEVICE_IDS.variantMap, 60]
    ]);
    const activeLane = trackDeck.find((lane) => lane.track.id === activeTrack.id);
    const activeEditCount = activeLane?.edits.filter((edit) => !activeTrack.bypassedEditIds.includes(edit.id)).length ?? 0;
    const visibleVariantCount = activeLane?.variantsTruncated
      ? activeLane.sourceVariantTotal
      : activeLane?.variants.length ?? 0;
    return deviceManifests
      .filter((manifest) => rackCompactDeviceIds.includes(manifest.id as typeof rackCompactDeviceIds[number]))
      .map((manifest) => {
        const evidence = evidenceByDevice[manifest.id];
        const visualization = manifest.id === DEVICE_IDS.variantMap;
        const resource = visualization
          ? "Current track state and Track Monitor results"
          : manifest.id === DEVICE_IDS.consequence
          ? bundle.consequenceAnnotation?.release ?? "Transcript annotation not configured"
          : manifest.id === DEVICE_IDS.dbnsfp
            ? bundle.dbnsfp.release
            : manifest.id === DEVICE_IDS.clinvar
              ? bundle.clinvar.release
              : bundle.cosmic.release;
        const version = manifest.id === DEVICE_IDS.consequence ? `bcftools csq ${bundle.bcftoolsVersion}` : `device ${manifest.version}`;
        const kind = visualization
          ? "visualization"
          : manifest.id === DEVICE_IDS.consequence
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
    const morphManifest = deviceManifests.find((manifest) => manifest.id === DEVICE_IDS.morph);
    return trackDeck.map((lane) => {
      const optimizer = optimizers[lane.track.id] ?? defaultOptimizer(lane.track.id);
      const randomizer = randomizers[lane.track.id] ?? defaultRandomizer();
      const defaultTarget = trackDeck.find((candidate) => candidate.track.id !== lane.track.id)?.track.id ?? "";
      const morph = morphs[lane.track.id] ?? defaultMorph(defaultTarget);
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
        sourceVariantTotal: lane.sourceVariantTotal,
        densityMode: lane.variantsTruncated,
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
        },
        morph: lane.track.readOnly ? undefined : {
          ...morph,
          name: morphManifest?.name ?? morph.name,
          version: morphManifest ? `device ${morphManifest.version}` : morph.version,
          limitation: morphManifest?.scientificLimitations[0] ?? morph.limitation
        }
      } satisfies GenomeTrackModel;
    });
  }, [appliedDevicesByTrack, bypassedDevicesByTrack, context.contig, context.end, context.start, deviceManifests, hiddenTrackIds, morphs, optimizers, randomizers, trackDeck]);
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
      const sourceImpact = consequenceImpactSignal(measured?.sourceEvidence[DEVICE_IDS.consequence]);
      const currentImpact = measured?.currentIsReference
        ? 0
        : consequenceImpactSignal(measured?.currentEvidence[DEVICE_IDS.consequence]);
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
      [DEVICE_IDS.consequence, "Variant Consequences"],
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
        unavailable: bulkCoverage?.unavailable ?? 0,
        errors: bulkCoverage?.errors ?? 0,
        noTranscriptFeature: bulkCoverage?.noTranscriptFeature ?? 0,
        bypassed: activeBypassedDeviceSet.has(deviceId)
      };
    });
    const consequenceEnabled = activeAppliedDeviceSet.has(DEVICE_IDS.consequence) && !activeBypassedDeviceSet.has(DEVICE_IDS.consequence);
    const optimizer = optimizers[activeTrack.id];
    const optimizerResult = optimizer?.result;
    const optimizerEditIds = new Set(optimizer?.generatedEditIds ?? []);
    const activeOptimizerEdits = [...optimizerEditIds]
      .filter((editId) => !activeTrack.bypassedEditIds.includes(editId)).length;
    return {
      evaluatedMutations: consequenceEnabled
        ? bulkProfile?.evaluatedMutations ?? evaluatedItems.reduce((total, item) => total + (item.mutationCount ?? 1), 0)
        : 0,
      activeMutations: activeMutationCount,
      impactDelta: consequenceEnabled && bulkProfile
        ? bulkProfile.impactDelta
        : consequenceEnabled
        && evaluatedItems.reduce((total, item) => total + (item.mutationCount ?? 1), 0) === activeItems.reduce((total, item) => total + (item.mutationCount ?? 1), 0)
        && activeItems.length > 0
        ? evaluatedItems.reduce((sum, item) => sum + (item.impactDelta ?? 0), 0)
        : undefined,
      higherImpactMutations: consequenceEnabled
        ? bulkProfile?.higherImpactMutations ?? itemDistribution?.higher
        : undefined,
      lowerImpactMutations: consequenceEnabled
        ? bulkProfile?.lowerImpactMutations ?? itemDistribution?.lower
        : undefined,
      unchangedImpactMutations: consequenceEnabled
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
  const activeAnalyzerKey = activeAnalyzerDeviceIds.join(",");
  const activeBypassKey = [...activeTrack.bypassedEditIds].sort().join(",");
  const activeProfileFingerprint = trackProfileFingerprints[activeTrack.id];

  useEffect(() => {
    let disposed = false;
    if (trackMeter.activeMutations === 0 || activeAnalyzerDeviceIds.length === 0) {
      setTrackProfileFingerprints((current) => {
        if (current[activeTrack.id] === undefined) return current;
        const next = { ...current };
        delete next[activeTrack.id];
        return next;
      });
      return () => { disposed = true; };
    }
    api.trackProfileInputFingerprint(projectPath, activeTrack.id, activeAnalyzerDeviceIds)
      .then((fingerprint) => {
        if (disposed) return;
        setTrackProfileFingerprints((current) => ({ ...current, [activeTrack.id]: fingerprint }));
        setBulkProfiles((current) => {
          if (current[activeTrack.id]?.profileInputFingerprint === fingerprint) return current;
          const compatible = Object.values(current).find(
            (profile) => profile.profileInputFingerprint === fingerprint
          );
          return compatible
            ? { ...current, [activeTrack.id]: { ...compatible, trackId: activeTrack.id } }
            : current;
        });
      })
      .catch((error) => {
        if (!disposed) setNotice(`Track profile state unavailable: ${messageOf(error)}`);
      });
    return () => { disposed = true; };
  }, [activeAnalyzerKey, activeBypassKey, activeTrack.headStateId, activeTrack.id, projectPath, trackMeter.activeMutations]);

  const storedTrackProfiler = trackProfilerRuns[activeTrack.id];
  const restoredBulkProfile = bulkProfiles[activeTrack.id];
  const currentBulkProfile = restoredBulkProfile
    && activeProfileFingerprint !== undefined
    && restoredBulkProfile.profileInputFingerprint === activeProfileFingerprint
    && restoredBulkProfile.stateId === activeTrack.headStateId
    && restoredBulkProfile.activeMutations === trackMeter.activeMutations
    && activeAnalyzerDeviceIds.every((deviceId) => restoredBulkProfile.deviceCoverage.some((coverage) => coverage.id === deviceId))
    ? restoredBulkProfile
    : undefined;
  const trackProfiler: TrackProfilerModel = storedTrackProfiler
    && storedTrackProfiler.profileInputFingerprint === activeProfileFingerprint
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
        profileInputFingerprint: currentBulkProfile.profileInputFingerprint,
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
        : activeAnalyzerCount === 0
          ? "Apply or enable an Evidence device to profile this track."
          : "Track Profiler will start automatically."
    };

  useEffect(() => {
    if (automaticProfileTimer.current !== undefined) {
      window.clearTimeout(automaticProfileTimer.current);
      automaticProfileTimer.current = undefined;
    }
    if (!activeProfileFingerprint
      || trackMeter.activeMutations === 0
      || activeAnalyzerCount === 0
      || trackProfiler.status !== "idle") {
      return;
    }
    const lane = trackDeck.find((item) => item.track.id === activeTrack.id);
    if (!lane) return;
    automaticProfileTimer.current = window.setTimeout(() => {
      automaticProfileTimer.current = undefined;
      void analyzeTrack(activeTrack.id, lane, "automatic");
    }, 450);
    return () => {
      if (automaticProfileTimer.current !== undefined) {
        window.clearTimeout(automaticProfileTimer.current);
        automaticProfileTimer.current = undefined;
      }
    };
  }, [activeAnalyzerCount, activeProfileFingerprint, activeTrack.id, trackDeck, trackMeter.activeMutations, trackProfiler.status]);

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
    const selection = symbolicSelection.selection;
    const excluded = new Set((selection.kind === "explicit" ? [] : selection.exclusions).map(variantKeyId));
    const visibleIds = lane.variants
      .filter((variant) => selection.kind !== "interval"
        || (variant.key.contig === selection.contig
          && variant.key.position <= selection.end
          && variant.key.position + variant.key.reference.length - 1 >= selection.start))
      .filter((variant) => !excluded.has(variantKeyId(variant.key)))
      .map(alleleId);
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

  function restoreDeviceSnapshot(trackId: string, snapshot: ResettableDeviceSnapshot) {
    if (snapshot.deviceId === DEVICE_IDS.optimizer) {
      setOptimizers((current) => ({ ...current, [trackId]: snapshot.value }));
    } else if (snapshot.deviceId === DEVICE_IDS.randomizer) {
      setRandomizers((current) => ({ ...current, [trackId]: snapshot.value }));
    } else {
      setMorphs((current) => ({ ...current, [trackId]: snapshot.value }));
    }
  }

  function setAlleleSelection(
    nextIds: string[],
    label: string,
    record = true,
    preserveSymbolicSelection = false
  ) {
    interruptTransportForUser();
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
    if (action.kind === "deviceReset") {
      restoreDeviceSnapshot(action.trackId, direction === "undo" ? action.before : action.after);
      setSelectedDeviceId(action.before.deviceId);
      setDetailMode("devices");
      setNotice(`${direction === "undo" ? "Undid" : "Redid"} ${action.label.toLowerCase()}`);
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
        const density = await api.variantDensity(projectPath, activeTrack.id, nextContext);
        if (generation !== focusRefreshGeneration.current) return;
        setViewportDensity(density);
      } catch (error) {
        loadErrors.push(`Track density unavailable: ${messageOf(error)}`);
      }

      try {
        view = await api.focusRegion(projectPath, nextContext);
        if (generation !== focusRefreshGeneration.current) return;
        setFocus(view);
        setContext(nextContext);
        if (selected) {
          const refreshedSelection = view.variants.find((item) => item.key.assembly === selected.key.assembly && variantLabel(item.key) === variantLabel(selected.key));
          setSelected(refreshedSelection ?? view.variants[0] ?? selected);
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
    setNotice(`Loading ${chromosomeLabel(bin.contig)}:${bin.start.toLocaleString()}–${bin.end.toLocaleString()}…`);
    await refresh({ contig: bin.contig, start: bin.start, end: bin.end });
  }

  async function focusGene(gene: GeneSearchHit) {
    const geneSpan = gene.end - gene.start + 1;
    const padding = Math.min(25_000, Math.max(500, Math.round(geneSpan * 0.05)));
    const nextContext = {
      contig: gene.contig,
      start: Math.max(1, gene.start - padding),
      end: gene.end + padding
    };
    setActiveGene(gene);
    setGeneQuery(gene.symbol);
    setGeneResults([]);
    setGeneSearchError(undefined);
    setNotice(`Focusing ${gene.symbol} on ${chromosomeLabel(gene.contig)}…`);
    await refresh(nextContext);
  }

  function selectActiveGeneVariants() {
    if (!activeGene) return;
    if (activeGene.sourceVariantCount === 0) {
      setNotice(`${activeGene.symbol} contains no imported VCF alleles in this sample`);
      return;
    }
    invalidateSelectedAlleleEvaluation();
    const lane = trackDeck.find((item) => item.track.id === activeTrack.id);
    const visibleVariants = (lane?.variants ?? []).filter((variant) =>
      variant.key.contig === activeGene.contig
      && variant.key.position <= activeGene.end
      && variant.key.position + variant.key.reference.length - 1 >= activeGene.start
    );
    const selection: VariantSelection = {
      kind: "interval",
      trackId: activeTrack.id,
      contig: activeGene.contig,
      start: activeGene.start,
      end: activeGene.end,
      exclusions: []
    };
    setSymbolicSelection({ selection, total: activeGene.sourceVariantCount });
    setAlleleSelection(
      visibleVariants.map(alleleId),
      `Select variants in ${activeGene.symbol}`,
      true,
      true
    );
    setSelectedEditId(undefined);
    setDetailMode("devices");
    if (!activeTrack.readOnly) setSelectedDeviceId(DEVICE_IDS.randomizer);
    if (visibleVariants[0]) setSelected(visibleVariants[0]);
    setNotice(`${activeGene.sourceVariantCount.toLocaleString()} imported ${activeGene.sourceVariantCount === 1 ? "allele" : "alleles"} selected in ${activeGene.symbol}`);
  }

  function previewViewport(nextContext: FocusContext) {
    interruptTransportForUser();
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

  function centerSelectedAlt() {
    if (!selected) {
      setNotice("Select an ALT before centering the viewport");
      return;
    }
    const selectedContig = selected.key.contig;
    const next = selectedContig === context.contig
      ? focusViewport(context, selected.key.position, focus?.contigLength, viewportSpan(context))
      : {
        contig: selectedContig,
        start: Math.max(1, selected.key.position - 40),
        end: selected.key.position + 40
      };
    previewViewport(next);
  }

  function resetGenomeViewport() {
    const startingView = initialViewportRef.current;
    setNotice(`Restoring starting view ${startingView.contig}:${startingView.start.toLocaleString()}–${startingView.end.toLocaleString()}…`);
    void refresh(startingView);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let restoredContext = initial;
      let restoredSelectedVariant: VariantKey | undefined;
      try {
        const stored = await api.loadWorkstationSession<WorkstationSessionV1>(projectPath);
        if (cancelled) return;
        if (isWorkstationSession(stored)) {
          restoredContext = stored.context;
          restoredSelectedVariant = stored.selectedVariant;
          initialViewportRef.current = restoredContext;
          setContext(restoredContext);
          setActiveGene(stored.activeGene);
          selectedAlleleIdsRef.current = stored.selectedAlleleIds ?? [];
          setSelectedAlleleIds(stored.selectedAlleleIds ?? []);
          setSymbolicSelection(stored.symbolicSelection);
          setDetailMode(stored.detailMode === "allele" ? "allele" : "devices");
          setSelectedDeviceId(stored.selectedDeviceId
            ? canonicalDeviceId(stored.selectedDeviceId)
            : DEVICE_IDS.consequence);
          setHiddenTrackIds(stored.hiddenTrackIds ?? []);
          setAppliedDevicesByTrack(canonicalDeviceMap(stored.appliedDevicesByTrack));
          setBypassedDevicesByTrack(canonicalDeviceMap(stored.bypassedDevicesByTrack));
          setOptimizers(Object.fromEntries(Object.entries(stored.optimizers ?? {}).map(([trackId, device]) => [trackId, resumableOptimizer(device)])));
          setRandomizers(Object.fromEntries(Object.entries(stored.randomizers ?? {}).map(([trackId, device]) => [trackId, resumableRandomizer(device)])));
          setMorphs(Object.fromEntries(Object.entries(stored.morphs ?? {}).map(([trackId, device]) => [trackId, resumableMorph(device)])));
          setUndoActions(stored.undoActions ?? []);
          setRedoActions(stored.redoActions ?? []);
          setTransportKind(stored.transportKind === "activeEdits" ? "activeEdits" : "variants");
          const restoredLoop = stored.transportLoop === true;
          setTransportLoop(restoredLoop);
          transportLoopRef.current = restoredLoop;
        }
        const restored = await refresh(restoredContext);
        if (cancelled) return;
        if (restoredSelectedVariant && restored?.view) {
          const variant = restored.view.variants.find((candidate) => sameVariant(candidate.key, restoredSelectedVariant!));
          if (variant) setSelected(variant);
          else setDetailMode("devices");
        }
        setSessionHydrated(true);
        onSaveStateChange({ status: "saved", message: stored ? "Project session restored" : "Project is ready" });
      } catch (error) {
        if (cancelled) return;
        await refresh(restoredContext);
        if (cancelled) return;
        setSessionHydrated(true);
        onSaveStateChange({ status: "error", message: `Session restore failed: ${messageOf(error)}` });
      }
    })();
    return () => { cancelled = true; };
  }, [projectPath]);

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
    interruptTransportForUser();
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
          void analyzeTrack(nextSnapshot.activeTrack.id, lane, "automatic");
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
    interruptTransportForUser();
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
      const sourceProfileFingerprint = trackProfileFingerprints[trackId];
      const sourceProfile = bulkProfiles[trackId];
      const sourceProfilerRun = trackProfilerRuns[trackId];
      if (sourceProfileFingerprint) {
        setTrackProfileFingerprints((current) => ({
          ...current,
          [nextSnapshot.activeTrack.id]: sourceProfileFingerprint
        }));
        if (sourceProfile?.profileInputFingerprint === sourceProfileFingerprint) {
          setBulkProfiles((current) => ({
            ...current,
            [nextSnapshot.activeTrack.id]: { ...sourceProfile, trackId: nextSnapshot.activeTrack.id }
          }));
        }
        if (sourceProfilerRun?.profileInputFingerprint === sourceProfileFingerprint) {
          setTrackProfilerRuns((current) => ({
            ...current,
            [nextSnapshot.activeTrack.id]: { ...sourceProfilerRun }
          }));
        }
        if (meterEvaluations[trackId]) {
          setMeterEvaluations((current) => ({
            ...current,
            [nextSnapshot.activeTrack.id]: { ...meterEvaluations[trackId] }
          }));
        }
      }
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
      if (morphs[trackId]) {
        setMorphs((current) => ({
          ...current,
          [nextSnapshot.activeTrack.id]: {
            ...morphs[trackId],
            bypassed: false,
            status: "ready",
            settings: { ...morphs[trackId].settings, targetTrackId: trackId },
            preview: undefined,
            generatedEditIds: [],
            progress: undefined,
            message: `Ready to morph toward ${source.name}.`
          }
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
    setBusy(true);
    try {
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
      setMorphs((current) => {
        const next = { ...current };
        delete next[trackId];
        for (const [candidateId, morph] of Object.entries(next)) {
          if (morph.settings.targetTrackId !== trackId) continue;
          next[candidateId] = {
            ...morph,
            settings: { ...morph.settings, targetTrackId: "" },
            preview: undefined,
            progress: undefined,
            status: "ready",
            message: "The previous target was archived. Choose another target track."
          };
        }
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
      setTrackProfileFingerprints((current) => {
        const next = { ...current };
        delete next[trackId];
        return next;
      });
      setBulkProfiles((current) => {
        const next = { ...current };
        delete next[trackId];
        return next;
      });
      setTrackProfilerRuns((current) => {
        const next = { ...current };
        delete next[trackId];
        return next;
      });
      setMeterEvaluations((current) => {
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

  function resetRackDevice(trackId: string, deviceId: string) {
    if (deviceId === DEVICE_IDS.optimizer) {
      const before = optimizers[trackId] ?? defaultOptimizer(trackId);
      const defaults = defaultOptimizer(trackId);
      const after: GenomeOptimizerDevice = {
        ...defaults,
        bypassed: before.bypassed,
        generatedEditIds: before.generatedEditIds,
        message: before.generatedEditIds?.length
          ? `Factory controls restored. ${before.generatedEditIds.length.toLocaleString()} applied mutation ${before.generatedEditIds.length === 1 ? "block remains" : "blocks remain"} on the track.`
          : defaults.message
      };
      setOptimizers((current) => ({ ...current, [trackId]: after }));
      recordAction({
        kind: "deviceReset",
        trackId,
        before: { deviceId: DEVICE_IDS.optimizer, value: before },
        after: { deviceId: DEVICE_IDS.optimizer, value: after },
        label: "Reset Genome Optimizer"
      });
      setNotice("Genome Optimizer controls reset. Existing track edits were not changed.");
      return;
    }
    if (deviceId === DEVICE_IDS.randomizer) {
      const before = randomizers[trackId] ?? defaultRandomizer();
      const defaults = defaultRandomizer();
      const after: AlleleRandomizerDevice = {
        ...defaults,
        bypassed: before.bypassed,
        generatedEditIds: before.generatedEditIds,
        message: before.generatedEditIds?.length
          ? `Factory controls restored. ${before.generatedEditIds.length.toLocaleString()} applied mutation ${before.generatedEditIds.length === 1 ? "block remains" : "blocks remain"} on the track.`
          : defaults.message
      };
      setRandomizers((current) => ({ ...current, [trackId]: after }));
      recordAction({
        kind: "deviceReset",
        trackId,
        before: { deviceId: DEVICE_IDS.randomizer, value: before },
        after: { deviceId: DEVICE_IDS.randomizer, value: after },
        label: "Reset Mutation Generator"
      });
      setNotice("Mutation Generator controls reset. Existing track edits were not changed.");
      return;
    }
    if (deviceId === DEVICE_IDS.morph) {
      const fallbackTarget = trackDeck.find((candidate) => candidate.track.id !== trackId)?.track.id ?? "";
      const before = morphs[trackId] ?? defaultMorph(fallbackTarget);
      const defaults = defaultMorph(fallbackTarget);
      const after: GenomeMorphDevice = {
        ...defaults,
        bypassed: before.bypassed,
        generatedEditIds: before.generatedEditIds,
        message: before.generatedEditIds?.length
          ? `Factory controls restored. ${before.generatedEditIds.length.toLocaleString()} applied morph ${before.generatedEditIds.length === 1 ? "block remains" : "blocks remain"} on the track.`
          : defaults.message
      };
      setMorphs((current) => ({ ...current, [trackId]: after }));
      recordAction({
        kind: "deviceReset",
        trackId,
        before: { deviceId: DEVICE_IDS.morph, value: before },
        after: { deviceId: DEVICE_IDS.morph, value: after },
        label: "Reset Genome Morph"
      });
      setNotice("Genome Morph controls reset. Existing track edits were not changed.");
    }
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
          `Mutation Generator applied ${preview.generatedEdits.toLocaleString()} changes as one reversible layer; Track Profiler will start automatically`
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
        && lane
        && trackEvidenceDeviceIds(trackId).length > 0) {
        void analyzeTrack(trackId, lane, "automatic");
        setNotice(`Mutation Generator added ${result.generatedEditIds.length.toLocaleString()} reversible blocks; Track Profiler is starting in the background`);
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

  function changeMorph(trackId: string, settings: GenomeMorphSettings) {
    setMorphs((current) => ({
      ...current,
      [trackId]: {
        ...(current[trackId] ?? defaultMorph(settings.targetTrackId)),
        settings,
        status: "ready",
        preview: undefined,
        progress: undefined,
        message: "Morph controls changed. Preview the new intermediate state."
      }
    }));
  }

  async function previewMorph(trackId: string) {
    const lane = trackDeck.find((candidate) => candidate.track.id === trackId);
    const fallbackTarget = trackDeck.find((candidate) => candidate.track.id !== trackId)?.track.id ?? "";
    const device = morphs[trackId] ?? defaultMorph(fallbackTarget);
    const target = trackDeck.find((candidate) => candidate.track.id === device.settings.targetTrackId);
    if (!lane || lane.track.readOnly) {
      setNotice("Duplicate the read-only source track before using Genome Morph");
      return;
    }
    if (!target || target.track.id === trackId) {
      setNotice("Choose another project track as the Genome Morph target");
      return;
    }
    setMorphs((current) => ({
      ...current,
      [trackId]: {
        ...(current[trackId] ?? device),
        status: "running",
        progress: 0,
        preview: undefined,
        message: `Submitting ${lane.track.name} → ${target.track.name} comparison…`
      }
    }));
    setNotice(`Genome Morph is comparing ${lane.track.name} with ${target.track.name}`);
    try {
      const workerThreads = settings.workerThreads === "auto"
        ? Math.max(1, (navigator.hardwareConcurrency || 2) - 1)
        : settings.workerThreads;
      let job = await api.startTrackMorphPreviewJob(
        projectPath,
        trackId,
        target.track.id,
        {
          amount: device.settings.amount,
          ordering: device.settings.ordering,
          seed: device.settings.seed
        },
        workerThreads
      );
      while (job.status === "queued" || job.status === "running") {
        setMorphs((current) => ({
          ...current,
          [trackId]: {
            ...(current[trackId] ?? device),
            status: "running",
            progress: job.progress,
            preview: undefined,
            message: job.message
          }
        }));
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        job = await api.backgroundJob<TrackMorphPreviewResult>(projectPath, job.id);
      }
      if (job.status !== "completed" || !job.result) {
        throw new Error(job.error ?? job.message ?? `Genome Morph preview ${job.status}`);
      }
      const preview = job.result;
      setMorphs((current) => ({
        ...current,
        [trackId]: {
          ...(current[trackId] ?? device),
          status: "ready",
          progress: 100,
          preview,
          message: preview.noOpReason ?? `${preview.selectedPositions.toLocaleString()} positions are ready as one reversible layer.`
        }
      }));
      setNotice(preview.noOpReason ?? `Genome Morph preview: ${preview.amount}% · ${preview.selectedPositions.toLocaleString()} positions · ${preview.generatedEdits.toLocaleString()} changes`);
    } catch (error) {
      setMorphs((current) => ({
        ...current,
        [trackId]: {
          ...(current[trackId] ?? device),
          status: "error",
          progress: undefined,
          preview: undefined,
          message: messageOf(error)
        }
      }));
      setNotice(messageOf(error));
    }
  }

  async function applyMorph(trackId: string) {
    const fallbackTarget = trackDeck.find((candidate) => candidate.track.id !== trackId)?.track.id ?? "";
    const device = morphs[trackId] ?? defaultMorph(fallbackTarget);
    const preview = device.preview;
    if (!preview?.compoundLayerId || preview.generatedEdits === 0) return;
    setBusy(true);
    setMorphs((current) => ({
      ...current,
      [trackId]: {
        ...(current[trackId] ?? device),
        status: "running",
        progress: undefined,
        message: "Applying the previewed morph state…"
      }
    }));
    try {
      const applied = await api.applyCompoundMutationLayer(projectPath, trackId, preview.compoundLayerId);
      const generatedEditIds = [applied.generatedEditId];
      setSnapshot(applied.snapshot);
      recordAction({
        kind: "editBatch",
        trackId,
        editIds: generatedEditIds,
        label: `Morph ${preview.amount}% toward target · ${preview.selectedPositions.toLocaleString()} positions`
      });
      setMorphs((current) => ({
        ...current,
        [trackId]: {
          ...(current[trackId] ?? device),
          bypassed: false,
          status: "ready",
          generatedEditIds: [...new Set([...(device.generatedEditIds ?? []), ...generatedEditIds])],
          preview: undefined,
          progress: undefined,
          message: `${preview.generatedEdits.toLocaleString()} changes applied as one reversible morph layer.`
        }
      }));
      setSelectedEditId(applied.generatedEditId);
      setEvaluation(undefined);
      setDeviceEvaluations({});
      const refreshed = await refresh(context);
      const refreshedLane = refreshed?.lanes?.find((candidate) => candidate.track.id === trackId);
      if (refreshedLane && trackEvidenceDeviceIds(trackId).length > 0) {
        void analyzeTrack(trackId, refreshedLane, "automatic");
        setNotice(`Genome Morph applied ${preview.selectedPositions.toLocaleString()} positions; Track Profiler is running in the background`);
      } else {
        setNotice(`Genome Morph applied ${preview.selectedPositions.toLocaleString()} positions to the selected track`);
      }
    } catch (error) {
      setMorphs((current) => ({
        ...current,
        [trackId]: {
          ...(current[trackId] ?? device),
          status: "error",
          progress: undefined,
          message: messageOf(error)
        }
      }));
      setNotice(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function bypassMorph(trackId: string, bypassed: boolean) {
    const fallbackTarget = trackDeck.find((candidate) => candidate.track.id !== trackId)?.track.id ?? "";
    const device = morphs[trackId] ?? defaultMorph(fallbackTarget);
    if (!device.generatedEditIds?.length) {
      setMorphs((current) => ({ ...current, [trackId]: { ...(current[trackId] ?? device), bypassed } }));
      return;
    }
    setBusy(true);
    try {
      const nextSnapshot = await api.setTrackEditsBypass(projectPath, trackId, device.generatedEditIds, bypassed);
      setSnapshot(nextSnapshot);
      setMorphs((current) => ({
        ...current,
        [trackId]: { ...(current[trackId] ?? device), bypassed, preview: undefined }
      }));
      await refresh(context);
      setNotice(`${bypassed ? "Bypassed" : "Enabled"} Genome Morph mutation layers`);
    } catch (error) {
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
    const maximumPositions = Math.max(1, Math.min(100_000, Math.trunc(device.settings.maximumPositions || 1_000)));
    const selection = symbolicSelection?.selection.trackId === trackId
      ? symbolicSelection.selection
      : undefined;
    const selectedCount = selection
      ? symbolicSelection?.total ?? 0
      : selectedAlleleIdsRef.current.length;
    if (selectedCount > maximumPositions) {
      setNotice(`${selectedCount.toLocaleString()} positions are selected. Raise Genome Optimizer's Maximum positions to at least ${selectedCount.toLocaleString()}, or narrow the selection.`);
      return;
    }
    let selectedVariants: VariantKey[];
    try {
      selectedVariants = selection
        ? []
        : await selectedVariantKeysForDevice(trackId, maximumPositions, "Genome Optimizer");
    } catch (error) {
      setNotice(messageOf(error));
      return;
    }
    if (!selection && device.settings.mode === "saturation" && device.generatedEditIds?.length) {
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
    if (selectedCount === 0 || (!selection && selectedVariants.length === 0)) {
      setNotice("Select at least one active allele before running Genome Optimizer.");
      return;
    }
    if (device.settings.mode === "saturation" && !activeEvidenceDeviceIds.includes(DEVICE_IDS.consequence)) {
      setNotice("Saturation requires applied, active Variant Consequences.");
      return;
    }
    if ((device.settings.mode === "saturation" || device.settings.direction === "maximize")
      && !activeEvidenceDeviceIds.includes(DEVICE_IDS.clinvar)) {
      setNotice("This optimizer run requires an applied, active ClinVar device for the fixed Pathogenic/Likely pathogenic guard.");
      return;
    }
    const background = selectedCount > Math.min(settings.interactiveAlleleLimit, OPTIMIZER_INTERACTIVE_POSITION_LIMIT);
    setOptimizers((current) => ({
      ...current,
      [trackId]: {
        ...(current[trackId] ?? defaultOptimizer(trackId)),
        status: "running",
        progress: background ? 0 : undefined,
        message: device.settings.mode === "saturation"
          ? `${background ? "Submitting background evaluation for" : "Evaluating three possible non-reference bases at"} ${selectedCount.toLocaleString()} selected ${selectedCount === 1 ? "position" : "positions"}…`
          : "Preparing a bounded candidate from source-sample alleles…"
      }
    }));
    if (!background) setBusy(true);
    setNotice(device.settings.mode === "saturation"
      ? `Genome Optimizer is annotating up to ${(selectedCount * 3).toLocaleString()} candidate alleles${background ? " in the background" : ""}…`
      : "Genome Optimizer is scoring independent source alleles…");
    try {
      if (device.generatedEditIds?.length) {
        setSnapshot(await api.setTrackEditsBypass(projectPath, trackId, device.generatedEditIds, true));
      }
      const optimizerSettings = device.settings;
      const objective = optimizerObjectives.find((item) => item.id === (optimizerSettings.mode === "saturation"
        ? "predictedImpactBurden"
        : optimizerSettings.objectiveId));
      const effectiveWeights = effectiveScoringWeights(
        optimizerSettings.weights,
        objective,
        optimizerWeights,
        new Set(bypassedDevicesByTrack[trackId] ?? []),
        new Set(appliedDevicesByTrack[trackId] ?? initialAppliedDeviceIds)
      );
      const request: OptimizerRequest = {
        mode: optimizerSettings.mode,
        objective: optimizerSettings.mode === "saturation"
          ? "predictedImpactBurden"
          : optimizerSettings.objectiveId as OptimizerRequest["objective"],
        direction: optimizerSettings.direction,
        maxEdits: Math.max(1, Math.min(optimizerSettings.maxEdits, selectedCount, 100_000)),
        weights: {
          impact: effectiveWeights.impact ?? 0,
          clinvar: 0,
          sourceEvidence: optimizerSettings.mode === "saturation" ? 0 : effectiveWeights.sourceEvidence ?? 0
        },
        selectedVariants,
        evidenceDeviceIds: activeEvidenceDeviceIds
      };
      if (background) {
        const workerThreads = settings.workerThreads === "auto"
          ? Math.max(1, (navigator.hardwareConcurrency || 2) - 1)
          : settings.workerThreads;
        let job = await api.startOptimizerJob(
          projectPath,
          trackId,
          context,
          request,
          selection,
          selection ? maximumPositions : undefined,
          workerThreads
        );
        while (job.status === "queued" || job.status === "running") {
          setOptimizers((current) => ({
            ...current,
            [trackId]: {
              ...(current[trackId] ?? device),
              status: "running",
              progress: job.progress,
              message: job.message
            }
          }));
          await new Promise((resolve) => window.setTimeout(resolve, 500));
          job = await api.backgroundJob<OptimizerBackgroundResult>(projectPath, job.id);
        }
        if (job.status !== "completed" || !job.result) {
          throw new Error(job.error ?? job.message ?? `Background Genome Optimizer ${job.status}`);
        }
        const backgroundResult = job.result;
        let generatedEditIds: string[] = [];
        if (backgroundResult.compoundLayerId && backgroundResult.generatedEdits > 0) {
          const applied = await api.applyCompoundMutationLayer(
            projectPath,
            trackId,
            backgroundResult.compoundLayerId
          );
          generatedEditIds = [applied.generatedEditId];
          setSnapshot(applied.snapshot);
          recordAction({
            kind: "editBatch",
            trackId,
            editIds: generatedEditIds,
            label: `Optimize ${backgroundResult.changedPositions.toLocaleString()} positions`
          });
          setSelectedEditId(applied.generatedEditId);
        }
        setOptimizers((current) => ({
          ...current,
          [trackId]: {
            ...(current[trackId] ?? device),
            bypassed: false,
            status: "ready",
            progress: undefined,
            generatedEditIds,
            message: backgroundResult.noOpReason ?? `${backgroundResult.generatedEdits.toLocaleString()} changes applied as one reversible optimizer layer.`,
            result: {
              generatedEdits: backgroundResult.generatedEdits,
              changedPositions: backgroundResult.changedPositions,
              consideredPositions: backgroundResult.consideredPositions,
              evaluatedCandidates: backgroundResult.evaluatedCandidates,
              excludedPositions: backgroundResult.excludedPositions,
              improvingPositions: backgroundResult.improvingPositions,
              unchangedOrTiedPositions: backgroundResult.unchangedOrTiedPositions,
              deferredByChangeLimit: backgroundResult.deferredByChangeLimit,
              beforeScore: backgroundResult.scoreBefore,
              afterScore: backgroundResult.scoreAfter,
              scoreUnit: "model units",
              summary: `${backgroundResult.scoreDescription} ${backgroundResult.limitation}`,
              candidateComparisons: []
            }
          }
        }));
        setEvaluation(undefined);
        setDeviceEvaluations({});
        const refreshed = await refresh(context);
        const refreshedLane = refreshed?.lanes?.find((item) => item.track.id === trackId);
        if (generatedEditIds.length > 0 && refreshedLane && trackEvidenceDeviceIds(trackId).length > 0) {
          void analyzeTrack(trackId, refreshedLane, "automatic");
          setNotice(`Genome Optimizer applied ${backgroundResult.changedPositions.toLocaleString()} positions as one layer; Track Profiler is starting in the background`);
        } else {
          setNotice(backgroundResult.noOpReason ?? "Background Genome Optimizer completed without changes");
        }
        return;
      }
      const result = await api.runOptimizer(projectPath, trackId, context, request);
      setSnapshot(result.snapshot);
      if (optimizerSettings.mode === "saturation") {
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
      const changedPositions = new Set(result.plan.proposals.map((proposal) => variantKeyId(proposal.sourceVariant))).size;
      const excludedPositions = new Set(result.plan.exclusions.map((exclusion) => variantKeyId(exclusion.sourceVariant))).size;
      const improvingPositions = new Set(result.plan.candidateComparisons
        .filter((comparison) => comparison.selected && !comparison.current)
        .map((comparison) => variantKeyId(comparison.sourceVariant))).size;
      setOptimizers((current) => ({
        ...current,
        [trackId]: {
          ...(current[trackId] ?? device),
          bypassed: false,
          status: "ready",
          progress: undefined,
          generatedEditIds: result.generatedEditIds,
          message: result.plan.noOpReason ?? `${result.generatedEditIds.length} reversible edit blocks generated.`,
          result: {
            generatedEdits: result.generatedEditIds.length,
            changedPositions,
            consideredPositions: result.plan.consideredVariants,
            evaluatedCandidates: result.plan.candidateComparisons.length,
            excludedPositions,
            improvingPositions,
            unchangedOrTiedPositions: Math.max(0, result.plan.consideredVariants - excludedPositions - improvingPositions),
            deferredByChangeLimit: Math.max(0, improvingPositions - changedPositions),
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
        void analyzeTrack(trackId, lane, "automatic");
        setNotice(`Genome Optimizer added ${result.generatedEditIds.length} edit blocks; Track Profiler is starting in the background`);
      } else {
        setNotice(result.plan.noOpReason ?? `Genome Optimizer added ${result.generatedEditIds.length} edit blocks`);
      }
    } catch (error) {
      setOptimizers((current) => ({
        ...current,
        [trackId]: {
          ...(current[trackId] ?? device),
          status: "error",
          progress: undefined,
          message: messageOf(error)
        }
      }));
      setNotice(messageOf(error));
    } finally {
      if (!background) setBusy(false);
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
    let profileInputFingerprint: string;
    try {
      profileInputFingerprint = await api.trackProfileInputFingerprint(projectPath, trackId, activeDeviceIds);
    } catch (error) {
      setNotice(messageOf(error));
      return;
    }
    const existingRun = trackProfilerRuns[trackId];
    if (existingRun?.status === "running" && existingRun.profileInputFingerprint === profileInputFingerprint) return;
    const profileRequestKey = `${trackId}:${profileInputFingerprint}`;
    if (profileRequestsInFlight.current.has(profileRequestKey)) return;
    if (operations.length > 0) {
      profileRequestsInFlight.current.add(profileRequestKey);
      const totalBulkMutations = operations.reduce(
        (total, operation) => total + editMutationCount(operation),
        0
      );
      setTrackProfilerRuns((current) => ({
        ...current,
        [trackId]: {
          status: "running",
          profileInputFingerprint,
          processedMutations: 0,
          totalMutations: totalBulkMutations,
          activeAnalyzers: activeDeviceIds.length,
          activeDeviceIds: [...activeDeviceIds],
          message: `Submitting ${totalBulkMutations.toLocaleString()} mutations to the background Evidence profiler…`
        }
      }));
      setNotice(`${trigger === "automatic" ? "Track Profiler started automatically" : "Track Profiler started"} for ${totalBulkMutations.toLocaleString()} mutations`);
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
              profileInputFingerprint,
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
            profileInputFingerprint: result.profileInputFingerprint,
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
            profileInputFingerprint,
            processedMutations: 0,
            totalMutations: totalBulkMutations,
            activeAnalyzers: activeDeviceIds.length,
            activeDeviceIds: [...activeDeviceIds],
            message: messageOf(error)
          }
        }));
        setNotice(messageOf(error));
      } finally {
        profileRequestsInFlight.current.delete(profileRequestKey);
      }
      return;
    }

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
    if (transportState === "playing") {
      return;
    }
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
  }, [activeAnalyzerSignature, activeTrack.id, selectedEditId, selectedEvidenceKey, selectedEvaluationRevision, transportState]);

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

  function currentTransportSelection(): { selection: VariantSelection; label: string } {
    if (symbolicSelection && symbolicSelection.selection.trackId === activeTrack.id) {
      const label = symbolicSelection.selection.kind === "allTrack"
        ? `Selection · ${symbolicSelection.total.toLocaleString()} alleles`
        : activeGeneSelection && activeGene
          ? `${activeGene.symbol} · ${symbolicSelection.total.toLocaleString()} alleles`
          : `Selection · ${symbolicSelection.total.toLocaleString()} alleles`;
      return { selection: symbolicSelection.selection, label };
    }
    const lane = trackDeck.find((item) => item.track.id === activeTrack.id);
    const explicit = (lane?.variants ?? [])
      .filter((variant) => selectedAlleleIdsRef.current.includes(alleleId(variant)))
      .map((variant) => variant.sourceKey ?? variant.key);
    if (explicit.length > 0) {
      return {
        selection: { kind: "explicit", trackId: activeTrack.id, variants: explicit },
        label: `Selection · ${explicit.length.toLocaleString()} ${explicit.length === 1 ? "allele" : "alleles"}`
      };
    }
    if (activeGene?.sourceVariantCount) {
      return {
        selection: {
          kind: "interval",
          trackId: activeTrack.id,
          contig: activeGene.contig,
          start: activeGene.start,
          end: activeGene.end,
          exclusions: []
        },
        label: `${activeGene.symbol} · ${activeGene.sourceVariantCount.toLocaleString()} alleles`
      };
    }
    return {
      selection: {
        kind: "interval",
        trackId: activeTrack.id,
        contig: context.contig,
        start: context.start,
        end: context.end,
        exclusions: []
      },
      label: `View · ${viewportDensity?.total.toLocaleString() ?? "…"} alleles`
    };
  }

  async function showTransportTarget(target: TransportTarget) {
    const span = viewportSpan(context);
    const nextContext = target.sourceKey.contig === context.contig
      ? focusViewport(context, target.sourceKey.position, focus?.contigLength, span)
      : {
        contig: target.sourceKey.contig,
        start: Math.max(1, target.sourceKey.position - Math.floor(span / 2)),
        end: target.sourceKey.position + Math.ceil(span / 2)
      };
    await refresh(nextContext);
    setTransportTarget(target);
    setSelected(target.currentVariant);
    setSelectedEditId(target.editId);
    setEvaluation(undefined);
    setDeviceEvaluations({});
    setNotice(`${target.sourceKey.contig}:${target.sourceKey.position.toLocaleString()} · ${transportKind === "variants" ? "variant" : "edit"} ${target.ordinal.toLocaleString()} of ${target.total.toLocaleString()}`);
  }

  async function evaluateTransportTarget(target: TransportTarget, playbackGeneration: number) {
    if (!target.currentVariant || activeAnalyzerDeviceIds.length === 0) return;
    const generation = ++evaluationGeneration.current;
    const deviceIds = [...activeAnalyzerDeviceIds];
    setRunningDeviceId("all");
    setNotice(`Reviewing ${target.currentVariant.key.contig}:${target.currentVariant.key.position.toLocaleString()} with ${deviceIds.length} active Evidence ${deviceIds.length === 1 ? "device" : "devices"}…`);
    let timeout: number | undefined;
    try {
      const evidence = await Promise.race([
        collectDeviceEvidence(target.currentVariant.key, deviceIds, true),
        new Promise<never>((_, reject) => {
          timeout = window.setTimeout(() => reject(new Error("Evidence review exceeded 30 seconds")), 30_000);
        })
      ]);
      if (playbackGeneration !== transportGeneration.current || generation !== evaluationGeneration.current) return;
      setDeviceEvaluations(evidence);
    } finally {
      if (timeout !== undefined) window.clearTimeout(timeout);
      if (generation === evaluationGeneration.current) setRunningDeviceId(undefined);
    }
  }

  async function manualTransport(action: "previous" | "next") {
    transportGeneration.current += 1;
    transportStartRef.current = undefined;
    setTransportState("idle");
    const { selection } = currentTransportSelection();
    try {
      const result = await api.transportTarget(projectPath, {
        selection,
        targetKind: transportKind,
        action,
        cursor: transportTarget?.cursor ?? (selected ? {
          sourceKey: selected.sourceKey ?? selected.key,
          editId: selectedEditId
        } : undefined),
        wrap: transportLoop
      });
      if (!result.target) {
        setNotice(`No ${transportKind === "variants" ? "variants" : "active edits"} in this review scope`);
        return;
      }
      await showTransportTarget(result.target);
    } catch (error) {
      setNotice(`Transport failed: ${messageOf(error)}`);
    }
  }

  async function playTransport() {
    if (transportState === "playing") {
      transportGeneration.current += 1;
      setTransportState("paused");
      setNotice("Genome review paused");
      return;
    }
    if (transportState === "idle") {
      transportStartRef.current = { context, selected, selectedEditId };
    }
    onShowEvidencePanel();
    const generation = ++transportGeneration.current;
    setTransportState("playing");
    const { selection } = currentTransportSelection();
    let cursor: TransportCursor | undefined = transportTarget?.cursor ?? (selected ? {
      sourceKey: selected.sourceKey ?? selected.key,
      editId: selectedEditId
    } : undefined);
    try {
      let result = await api.transportTarget(projectPath, {
        selection,
        targetKind: transportKind,
        action: cursor ? "locate" : "first",
        cursor,
        wrap: transportLoopRef.current
      });
      while (generation === transportGeneration.current && result.target) {
        await showTransportTarget(result.target);
        if (generation !== transportGeneration.current) return;
        await evaluateTransportTarget(result.target, generation);
        if (generation !== transportGeneration.current) return;
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        if (generation !== transportGeneration.current) return;
        cursor = result.target.cursor;
        const next = await api.transportTarget(projectPath, {
          selection,
          targetKind: transportKind,
          action: "next",
          cursor,
          wrap: transportLoopRef.current
        });
        if (!next.target || (!next.target.wrapped && next.target.cursor.sourceKey.assembly === cursor.sourceKey.assembly
          && variantLabel(next.target.cursor.sourceKey) === variantLabel(cursor.sourceKey)
          && next.target.cursor.editId === cursor.editId)) {
          setTransportState("paused");
          setNotice("Genome review reached the end of the scope");
          return;
        }
        result = next;
      }
      if (generation === transportGeneration.current) setTransportState("paused");
    } catch (error) {
      if (generation === transportGeneration.current) {
        setTransportState("paused");
        setNotice(`Genome review paused: ${messageOf(error)}`);
      }
    }
  }

  async function stopTransport() {
    transportGeneration.current += 1;
    setTransportState("idle");
    const start = transportStartRef.current;
    transportStartRef.current = undefined;
    if (!start) return;
    await refresh(start.context);
    setSelected(start.selected);
    setSelectedEditId(start.selectedEditId);
    setTransportTarget(undefined);
    setNotice("Returned to the review start");
  }

  function changeTransportLoop(enabled: boolean) {
    transportLoopRef.current = enabled;
    setTransportLoop(enabled);
  }

  function interruptTransportForUser() {
    if (transportState === "idle") return;
    transportGeneration.current += 1;
    setTransportState("paused");
  }

  function updateContextHelp(target: EventTarget | null) {
    if (contextHelpPinned || !(target instanceof Element)) return;
    if (target.closest("[data-context-help-ignore]")) return;
    const key = target.closest<HTMLElement>("[data-context-help]")?.dataset.contextHelp;
    if (key && CONTEXT_HELP_TOPICS[key]) setContextHelpKey(key);
  }

  useEffect(() => {
    function transportShortcut(event: KeyboardEvent) {
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, select, button, [contenteditable='true'], [role='dialog']")) return;
      if (event.code === "Space") {
        event.preventDefault();
        if (event.shiftKey) void stopTransport();
        else void playTransport();
      } else if (event.key === "[") {
        event.preventDefault();
        void manualTransport("previous");
      } else if (event.key === "]") {
        event.preventDefault();
        void manualTransport("next");
      } else if (event.key.toLowerCase() === "l") {
        event.preventDefault();
        changeTransportLoop(!transportLoopRef.current);
      }
    }
    window.addEventListener("keydown", transportShortcut);
    return () => window.removeEventListener("keydown", transportShortcut);
  });

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
      ?? (deviceId === DEVICE_IDS.optimizer ? "Genome Optimizer" : deviceId === DEVICE_IDS.randomizer ? "Mutation Generator" : deviceId === DEVICE_IDS.morph ? "Genome Morph" : "Device");
    if (scoringDeviceContributes(trackId, deviceId)) {
      invalidateOptimizerScoringInputs(trackId, `${name} was added to the track. Generate again to use its configured contribution.`);
    }
    setSelectedDeviceId(deviceId);
    setDetailMode("devices");
    setNotice(`Added ${name} to the selected Genome Track`);
  }

  function removeRackDevice(trackId: string, deviceId: string) {
    const name = deviceManifests.find((manifest) => manifest.id === deviceId)?.name
      ?? (deviceId === DEVICE_IDS.optimizer ? "Genome Optimizer" : deviceId === DEVICE_IDS.randomizer ? "Mutation Generator" : deviceId === DEVICE_IDS.morph ? "Genome Morph" : "Device");
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
    if (deviceId === DEVICE_IDS.morph) {
      setMorphs((current) => {
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

  const activeConsequenceEvidence = !activeAppliedDeviceSet.has(DEVICE_IDS.consequence) || activeBypassedDeviceSet.has(DEVICE_IDS.consequence)
    ? undefined
    : evidenceByDevice[DEVICE_IDS.consequence];
  const visibleEvidence = alleleDeviceIds
    .filter((deviceId) => activeAppliedDeviceSet.has(deviceId) && !activeBypassedDeviceSet.has(deviceId))
    .map((deviceId) => evidenceByDevice[deviceId])
    .filter((result): result is EvidenceResult => Boolean(result));
  const activeGeneVisible = Boolean(activeGene
    && activeGene.contig === context.contig
    && activeGene.start <= context.end
    && activeGene.end >= context.start);
  const activeGeneLeft = activeGeneVisible && activeGene
    ? Math.max(0, ((Math.max(activeGene.start, context.start) - context.start) / Math.max(1, context.end - context.start + 1)) * 100)
    : 0;
  const activeGeneWidth = activeGeneVisible && activeGene
    ? Math.max(0.5, ((Math.min(activeGene.end, context.end) - Math.max(activeGene.start, context.start) + 1) / Math.max(1, context.end - context.start + 1)) * 100)
    : 0;

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
    <main
      className={`workstation${settings.showVariantBrowser ? "" : " hide-variants"}${settings.showEvidenceInspector ? "" : " hide-evidence"}`}
      onMouseOver={(event) => updateContextHelp(event.target)}
      onFocusCapture={(event) => updateContextHelp(event.target)}
    >
      <header className="app-header">
        <div className="mini-brand"><img src="/dgw-mark.svg" alt="" /></div>
        <div><strong title={projectPath}>{snapshot.manifest.name}</strong><span>{snapshot.manifest.selectedSample} · {snapshot.manifest.assembly}</span></div>
        <div className="header-spacer" />
        <div className={`worker-state${busy || runningDeviceId ? " processing" : ""}`}>
          <span className={busy || runningDeviceId ? "pulse" : "status-dot"} />
          {busy || runningDeviceId ? <><b>Processing</b><i>·</i></> : null}{notice}
        </div>
      </header>

      <aside className="variant-browser" data-context-help="source-variants">
        <div className="section-title">
          <span>Source Variants</span>
          <small>{allTrackSelectionActive
            ? `✓ ${symbolicSelection?.total.toLocaleString()} selected`
            : `${variantContigs.length.toLocaleString()} contigs · ${navigationVariantTotal.toLocaleString()}`}</small>
        </div>
        <div className="gene-locator" data-context-help="gene-search">
          <label htmlFor="gene-search">Go to gene</label>
          <div className="gene-search-field">
            <input
              id="gene-search"
              value={geneQuery}
              disabled={!snapshot.manifest.resourceBundle.geneAnnotation}
              placeholder={snapshot.manifest.resourceBundle.geneAnnotation ? "Symbol or Ensembl ID" : "Gene resource unavailable"}
              autoComplete="off"
              onChange={(event) => {
                setGeneQuery(event.target.value);
                if (activeGene && event.target.value !== activeGene.symbol) setActiveGene(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && geneResults[0]) {
                  event.preventDefault();
                  void focusGene(geneResults[0]);
                }
              }}
            />
            {geneSearchLoading && <span className="gene-search-spinner" aria-label="Searching genes" />}
            {activeGene && <button type="button" title="Clear the active gene" onClick={() => { setActiveGene(undefined); setGeneQuery(""); }}>×</button>}
          </div>
          {geneResults.length > 0 && <div className="gene-search-results">
            {geneResults.map((gene) => <button
              type="button"
              key={`${gene.geneId}:${gene.contig}:${gene.start}`}
              onClick={() => { void focusGene(gene); }}
            >
              <b>{gene.symbol}</b>
              <span>{chromosomeLabel(gene.contig)}:{gene.start.toLocaleString()}–{gene.end.toLocaleString()}</span>
              <small>{gene.geneId} · {gene.sourceVariantCount.toLocaleString()} imported</small>
            </button>)}
          </div>}
          {!geneSearchLoading && geneQuery.trim() && geneResults.length === 0 && !activeGene && <small className={geneSearchError ? "gene-search-error" : "gene-search-empty"}>{geneSearchError ?? "No matching genes"}</small>}
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
                  <b>{chromosomeLabel(summary.contig).toUpperCase()}</b>
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
        <div className="genome-navigation-stack" aria-label="Genome review and navigation">
          <GenomeTransportBar
            contig={context.contig}
            start={context.start}
            end={context.end}
            target={transportTarget}
            targetKind={transportKind}
            state={transportState}
            loop={transportLoop}
            scopeLabel={currentTransportSelection().label}
            evidenceDeviceLabel={activeAnalyzerDeviceIds
              .map((deviceId) => deviceManifests.find((device) => device.id === deviceId)?.name ?? deviceId)
              .join(", ")}
            evidenceRunning={Boolean(runningDeviceId)}
            disabled={busy}
            onTargetKindChange={(kind) => {
              transportGeneration.current += 1;
              setTransportState("idle");
              setTransportTarget(undefined);
              setTransportKind(kind);
            }}
            onPrevious={() => { void manualTransport("previous"); }}
            onPlayPause={() => { void playTransport(); }}
            onStop={() => { void stopTransport(); }}
            onNext={() => { void manualTransport("next"); }}
            onLoopChange={changeTransportLoop}
            onGo={(contig, start, end) => {
              if (!contig || start < 1 || end < start) {
                setNotice("Enter a valid 1-based genomic interval");
                return;
              }
              transportGeneration.current += 1;
              setTransportState("idle");
              setTransportTarget(undefined);
              void refresh({ contig, start, end });
            }}
          />

          {contigDensity && focus?.contigLength && <GenomeOverviewNavigator
            density={contigDensity}
            region={context}
            contigLength={focus.contigLength}
            disabled={busy}
            canCenterVariant={Boolean(selected)}
            onCenterVariant={centerSelectedAlt}
            onResetView={resetGenomeViewport}
            onViewportChange={previewViewport}
          />}
        </div>

        {activeGene && <section className={`gene-focus-strip${activeGeneVisible ? "" : " offscreen"}`} aria-label={`Active gene ${activeGene.symbol}`}>
          <div className="gene-focus-heading">
            <span><b>{activeGene.symbol}</b><small>{activeGene.geneId} · {chromosomeLabel(activeGene.contig)}:{activeGene.start.toLocaleString()}–{activeGene.end.toLocaleString()} · {activeGene.strand} strand</small></span>
            <span className="gene-focus-actions">
              {!activeGeneVisible && <button type="button" onClick={() => { void focusGene(activeGene); }}>Focus gene</button>}
              <button type="button" className={activeGeneSelection ? "selected" : "primary"} disabled={activeGene.sourceVariantCount === 0} onClick={selectActiveGeneVariants}>
                {activeGeneSelection ? `${activeGene.sourceVariantCount.toLocaleString()} gene ${activeGene.sourceVariantCount === 1 ? "allele" : "alleles"} selected ✓` : `Select ${activeGene.sourceVariantCount.toLocaleString()} ${activeGene.sourceVariantCount === 1 ? "allele" : "alleles"} in gene`}
              </button>
            </span>
          </div>
          <div className="gene-focus-rail" title={`${activeGene.symbol} gene interval`}>
            {activeGeneVisible && <i style={{ left: `${activeGeneLeft}%`, width: `${activeGeneWidth}%` }}><span>{activeGene.strand === "-" ? "←" : "→"}</span></i>}
          </div>
        </section>}

        <div className="track-workspace-shell" data-context-help="tracks">
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
            variantDensity={viewportDensity}
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
              consequenceEvidence={activeConsequenceEvidence}
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
            onMorphChange={changeMorph}
            onMorphPreview={previewMorph}
            onMorphApply={applyMorph}
            onMorphBypass={bypassMorph}
            onSelectDevice={(_trackId, deviceId) => { setSelectedDeviceId(deviceId); setDetailMode("devices"); }}
            onToggleDevice={toggleRackDevice}
            onRunDevice={runRackDevice}
            onAddDevice={addRackDevice}
            onRemoveDevice={removeRackDevice}
            onResetDevice={resetRackDevice}
            onAnalyzeTrack={(trackId) => { void analyzeTrack(trackId); }}
          />
        </div>
      </section>

      <aside className="inspector" data-context-help="evidence-panel">
        <div className="evidence-inspector-content">
          <div className="section-title"><span>Evidence</span><small>selected allele only</small></div>
          {symbolicSelection && <div className="selection-scope-summary">
            <b>{symbolicSelection.total.toLocaleString()} active variant alleles selected {symbolicSelection.selection.kind === "interval" && activeGeneSelection ? `in ${activeGene?.symbol}` : "across every contig"}</b>
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
        </div>
        <ContextHelpPanel
          topic={CONTEXT_HELP_TOPICS[contextHelpKey] ?? CONTEXT_HELP_TOPICS[DEFAULT_CONTEXT_HELP_KEY]}
          expanded={settings.showContextHelp}
          pinned={contextHelpPinned}
          onExpandedChange={onContextHelpVisibilityChange}
          onPinnedChange={setContextHelpPinned}
        />
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
  const [projectSaveState, setProjectSaveState] = useState<ProjectSaveState>();
  const [projectNeedsSaveAs, setProjectNeedsSaveAs] = useState(false);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>(() => parseRecentProjects(localStorage.getItem(RECENT_PROJECTS_STORAGE_KEY)));
  const sessionSaverRef = useRef<(() => Promise<void>) | undefined>(undefined);

  useEffect(() => {
    function suppressWebviewContextMenu(event: MouseEvent) {
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, [contenteditable='true']")) return;
      event.preventDefault();
    }

    document.addEventListener("contextmenu", suppressWebviewContextMenu);
    return () => document.removeEventListener("contextmenu", suppressWebviewContextMenu);
  }, []);

  useEffect(() => {
    localStorage.setItem(USER_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolved = settings.colorTheme === "system"
        ? systemTheme.matches ? "dark" : "light"
        : settings.colorTheme;
      document.documentElement.dataset.dgwTheme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };
    applyTheme();
    if (settings.colorTheme !== "system") return;
    systemTheme.addEventListener("change", applyTheme);
    return () => systemTheme.removeEventListener("change", applyTheme);
  }, [settings.colorTheme]);

  useEffect(() => {
    localStorage.setItem(RECENT_PROJECTS_STORAGE_KEY, JSON.stringify(recentProjects));
  }, [recentProjects]);

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

  function rememberProject(path: string, opened: ProjectSnapshot) {
    const recent = { path, name: opened.manifest.name, openedAt: new Date().toISOString() };
    setRecentProjects((current) => [recent, ...current.filter((item) => item.path !== path)].slice(0, 8));
  }

  function enterProject(path: string, opened: ProjectSnapshot, created: boolean, template = projectTemplate, unsavedExample = false) {
    setProjectPath(path);
    setProjectNeedsSaveAs(unsavedExample);
    setInitialAppliedDeviceIds(created && template === "empty" ? [] : [...dgwStarterDeviceIds]);
    setSnapshot(opened);
    setHistoryState(EMPTY_HISTORY_STATE);
    setProjectSaveState({
      status: "saved",
      message: unsavedExample ? "Unsaved example · temporary autosave" : created ? "Project created and autosaved" : "Project opened"
    });
    if (!unsavedExample) rememberProject(path, opened);
  }

  function resetProject() {
    setSnapshot(undefined);
    setProjectPath("");
    setProjectNeedsSaveAs(false);
    setExportRequest(undefined);
    setHistoryRequest(undefined);
    setDeviceBrowserRequest(0);
    setJobsOpen(false);
    setJobs([]);
    setHistoryState(EMPTY_HISTORY_STATE);
    setProjectSaveState(undefined);
    sessionSaverRef.current = undefined;
  }

  async function saveCurrentProject() {
    if (!snapshot || !sessionSaverRef.current) return;
    await sessionSaverRef.current();
  }

  async function saveProject() {
    if (!snapshot || !projectPath) return;
    if (!projectNeedsSaveAs) {
      await saveCurrentProject();
      return;
    }

    const selected = await save({
      title: "Save Example as a DGW Project",
      defaultPath: `${projectSlug(snapshot.manifest.name)}.dgw`,
      filters: [{ name: "DGW Project", extensions: ["dgw"] }]
    });
    if (typeof selected !== "string") return;
    const destination = selected.toLowerCase().endsWith(".dgw") ? selected : `${selected}.dgw`;
    try {
      await saveCurrentProject();
      setProjectSaveState({ status: "saving", message: "Saving example as a project…" });
      const saved = await api.saveProjectCopy(projectPath, destination);
      setProjectPath(saved.projectPath);
      setSnapshot(saved.snapshot);
      setProjectNeedsSaveAs(false);
      setHistoryState(EMPTY_HISTORY_STATE);
      rememberProject(saved.projectPath, saved.snapshot);
      setProjectSaveState({ status: "saved", message: `Project saved: ${saved.projectPath}` });
    } catch (error) {
      setProjectSaveState({ status: "error", message: `Save failed: ${messageOf(error)}` });
    }
  }

  async function closeProject(): Promise<boolean> {
    try {
      await saveCurrentProject();
      resetProject();
      return true;
    } catch (error) {
      setProjectSaveState({ status: "error", message: `Close failed because the project could not be saved: ${messageOf(error)}` });
      return false;
    }
  }

  async function openProjectAt(path: string) {
    try {
      await saveCurrentProject();
      setProjectSaveState({ status: "saving", message: "Opening project…" });
      const opened = await api.openProject(path);
      enterProject(path, opened, false);
    } catch (error) {
      setProjectSaveState({ status: "error", message: `Open failed: ${messageOf(error)}` });
    }
  }

  async function chooseExistingProject() {
    const selected = await open({ directory: true, multiple: false, title: "Open DGW Project" });
    if (typeof selected === "string") await openProjectAt(selected);
  }

  async function openExampleProject(exampleId: ExampleProjectId) {
    const assemblyLabel = exampleId === "alleleEditingB37" || exampleId === "hg00103Wes" ? "GRCh37" : "GRCh38";
    try {
      await saveCurrentProject();
      setProjectSaveState({ status: "saving", message: `Creating ${assemblyLabel} example…` });
      const example = await createBundledExampleProject(exampleId, (message) => {
        setProjectSaveState({ status: "saving", message });
      });
      enterProject(example.projectPath, example.snapshot, true, "standardEvidence", true);
    } catch (error) {
      const detail = messageOf(error);
      setProjectSaveState({ status: "error", message: `Example failed: ${detail}` });
      await messageDialog(detail, { title: `Could not open ${assemblyLabel} example`, kind: "error" });
    }
  }

  async function saveProjectCopy() {
    if (!snapshot || !projectPath) return;
    const selected = await save({
      title: "Save a Copy of the DGW Project",
      defaultPath: `${projectSlug(snapshot.manifest.name)}-copy.dgw`,
      filters: [{ name: "DGW Project", extensions: ["dgw"] }]
    });
    if (typeof selected !== "string") return;
    const destination = selected.toLowerCase().endsWith(".dgw") ? selected : `${selected}.dgw`;
    try {
      await saveCurrentProject();
      setProjectSaveState({ status: "saving", message: "Creating project copy…" });
      const copied = await api.saveProjectCopy(projectPath, destination);
      rememberProject(copied.projectPath, copied.snapshot);
      setProjectSaveState({ status: "saved", message: `Copy saved: ${copied.projectPath}` });
    } catch (error) {
      setProjectSaveState({ status: "error", message: `Copy failed: ${messageOf(error)}` });
    }
  }

  function requestExport(kind: ExportKind) {
    setExportRequest((current) => ({ id: (current?.id ?? 0) + 1, kind }));
  }

  function requestHistory(direction: HistoryDirection) {
    setHistoryRequest((current) => ({ id: (current?.id ?? 0) + 1, direction }));
  }

  async function beginNewProject(template: ProjectTemplateId) {
    if (!await closeProject()) return;
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
      await saveCurrentProject();
      const created = await api.createProjectFromCurrent(projectPath, template);
      enterProject(created.projectPath, created.snapshot, true, template);
      setProjectTemplateDialogOpen(false);
    } catch (error) {
      setTemplateCreationError(messageOf(error));
    } finally {
      setTemplateCreationBusy(false);
    }
  }

  const registerSessionSaver = useCallback((saver?: () => Promise<void>) => {
    sessionSaverRef.current = saver;
  }, []);

  useEffect(() => {
    function projectShortcut(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "s" && snapshot) {
        event.preventDefault();
        void saveProject();
      } else if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        void chooseExistingProject();
      }
    }
    window.addEventListener("keydown", projectShortcut);
    return () => window.removeEventListener("keydown", projectShortcut);
  }, [snapshot, projectPath]);

  return <div className={`application-shell${settings.reduceMotion ? " reduce-motion" : ""}${settings.uiScale >= 1.3 ? " large-interface" : ""}`}>
    <ApplicationMenu
      projectOpen={Boolean(snapshot)}
      projectName={snapshot?.manifest.name}
      projectPath={snapshot ? projectPath : undefined}
      projectNeedsSaveAs={projectNeedsSaveAs}
      resourceBundle={snapshot?.manifest.resourceBundle}
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
      onOpenProject={() => { void chooseExistingProject(); }}
      onOpenExampleProject={(assembly) => { void openExampleProject(assembly); }}
      recentProjects={recentProjects}
      onOpenRecent={(path) => { void openProjectAt(path); }}
      onSaveProject={() => { void saveProject(); }}
      onSaveProjectCopy={() => { void saveProjectCopy(); }}
      saveStatus={projectSaveState?.status}
      saveMessage={projectSaveState?.message}
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
      onCloseProject={() => { void closeProject(); }}
    />
    <div className="application-stage">
      {snapshot
        ? <Workstation
          key={`${snapshot.manifest.projectId}:${projectPath}`}
          projectPath={projectPath}
          snapshot={snapshot}
          setSnapshot={setSnapshot}
          settings={settings}
          exportRequest={exportRequest}
          historyRequest={historyRequest}
          deviceBrowserRequest={deviceBrowserRequest}
          initialAppliedDeviceIds={initialAppliedDeviceIds}
          onShowDeviceRack={() => setSettings((current) => ({ ...current, showDeviceRack: true }))}
          onShowEvidencePanel={() => setSettings((current) => current.showEvidenceInspector
            ? current
            : { ...current, showEvidenceInspector: true })}
          onContextHelpVisibilityChange={(visible) => setSettings((current) => ({
            ...current,
            showEvidenceInspector: visible ? true : current.showEvidenceInspector,
            showContextHelp: visible
          }))}
          onHistoryStateChange={setHistoryState}
          onSessionSaverChange={registerSessionSaver}
          onSaveStateChange={setProjectSaveState}
        />
        : <Onboarding projectTemplate={projectTemplate} key={projectSetupKey} onOpened={(path, opened, created, unsavedExample) => {
          enterProject(path, opened, created, projectTemplate, unsavedExample);
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
      onDeleteFinished={() => {
        if (!projectPath) return;
        const finishedCount = jobs.filter((job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled").length;
        if (finishedCount === 0) return;
        void (async () => {
          const confirmed = await confirmDialog(
            `Delete ${finishedCount.toLocaleString()} finished background ${finishedCount === 1 ? "job" : "jobs"}? Running and queued jobs will remain.`,
            { title: "Delete Finished Jobs", kind: "warning", okLabel: "Delete finished", cancelLabel: "Cancel" }
          );
          if (!confirmed) return;
          setJobsLoading(true);
          try {
            await api.deleteFinishedBackgroundJobs(projectPath);
            setJobs((current) => current.filter((job) => job.status === "queued" || job.status === "running"));
          } finally {
            setJobsLoading(false);
          }
        })();
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
