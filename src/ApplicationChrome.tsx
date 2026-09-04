import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_USER_SETTINGS,
  UI_SCALES,
  type UiScale,
  type UserSettings
} from "./userSettings";
import { api } from "./api";
import type { BackgroundJob, ProjectResourceHealth, ResourceBundle, ResourceHealthStatus } from "./types";

function closeMenu(event: React.MouseEvent<HTMLElement>) {
  event.currentTarget.closest("nav")?.querySelectorAll("details[open]").forEach((details) => details.removeAttribute("open"));
}

export type ProjectTemplateId = "standardEvidence" | "empty";
export type ExampleProjectId = "alleleEditingB37" | "alleleEditingHg38" | "hg00103Wes";

export function ApplicationMenu({
  projectOpen,
  projectName,
  projectPath,
  resourceBundle,
  settings,
  canUndo,
  canRedo,
  undoLabel,
  redoLabel,
  onNewProject,
  onNewFromTemplate,
  onOpenProject,
  onOpenExampleProject,
  recentProjects,
  onOpenRecent,
  onSaveProject,
  onSaveProjectCopy,
  saveStatus,
  saveMessage,
  onSettingsChange,
  onUndo,
  onRedo,
  onAddDevice,
  onOpenJobs,
  onOpenSettings,
  onExportTrackVcf,
  onExportFocusFasta,
  onCloseProject
}: {
  projectOpen: boolean;
  projectName?: string;
  projectPath?: string;
  resourceBundle?: ResourceBundle;
  settings: UserSettings;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
  onNewProject: () => void;
  onNewFromTemplate: () => void;
  onOpenProject: () => void;
  onOpenExampleProject: (exampleId: ExampleProjectId) => void;
  recentProjects: Array<{ path: string; name: string; openedAt: string }>;
  onOpenRecent: (path: string) => void;
  onSaveProject: () => void;
  onSaveProjectCopy: () => void;
  saveStatus?: "saving" | "saved" | "error";
  saveMessage?: string;
  onSettingsChange: (settings: UserSettings) => void;
  onUndo: () => void;
  onRedo: () => void;
  onAddDevice: () => void;
  onOpenJobs: () => void;
  onOpenSettings: () => void;
  onExportTrackVcf: () => void;
  onExportFocusFasta: () => void;
  onCloseProject: () => void;
}) {
  const navRef = useRef<HTMLElement>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [resourceHealth, setResourceHealth] = useState<ProjectResourceHealth>();
  const [resourceHealthError, setResourceHealthError] = useState<string>();
  const [resourceHealthLoading, setResourceHealthLoading] = useState(false);
  const pathName = (path?: string) => path?.split(/[\\/]/).filter(Boolean).at(-1) ?? "Not configured";
  const registeredResources = resourceBundle ? [
    {
      id: "reference",
      name: "Reference FASTA",
      release: `${resourceBundle.assembly} · ${pathName(resourceBundle.referencePath)}`,
      detail: "Sequence reconstruction and normalization",
      path: resourceBundle.referencePath,
      configured: Boolean(resourceBundle.referencePath)
    },
    {
      id: "consequence",
      name: "Variant consequences",
      release: resourceBundle.consequenceAnnotation?.release ?? "Not configured",
      detail: "Ensembl GFF3 · bcftools csq",
      path: resourceBundle.consequenceAnnotation?.path,
      configured: Boolean(resourceBundle.consequenceAnnotation)
    },
    {
      id: "genes",
      name: "Gene navigation",
      release: resourceBundle.geneAnnotation?.release ?? "Not configured",
      detail: "Ensembl GTF and DGW gene index",
      path: resourceBundle.geneAnnotation?.path,
      configured: Boolean(resourceBundle.geneAnnotation)
    },
    {
      id: "dbnsfp",
      name: "dbNSFP",
      release: resourceBundle.dbnsfp.release || "Release not specified",
      detail: resourceBundle.dbnsfp.licenseLabel,
      path: resourceBundle.dbnsfp.path,
      configured: Boolean(resourceBundle.dbnsfp.path)
    },
    {
      id: "clinvar",
      name: "ClinVar",
      release: resourceBundle.clinvar.release || "Release not specified",
      detail: resourceBundle.clinvar.licenseLabel,
      path: resourceBundle.clinvar.path,
      configured: Boolean(resourceBundle.clinvar.path)
    },
    {
      id: "cosmic",
      name: "COSMIC",
      release: resourceBundle.cosmic.release || "Release not specified",
      detail: resourceBundle.cosmic.licenseLabel,
      path: resourceBundle.cosmic.path,
      configured: Boolean(resourceBundle.cosmic.path)
    }
  ] : [];

  const healthLabel = (status?: ResourceHealthStatus) => status === "ready"
    ? "Ready"
    : status === "notConfigured"
      ? "Optional"
      : status === "warning"
        ? "Warning"
        : status === "missing"
          ? "Missing"
          : status === "error"
            ? "Error"
            : resourceHealthLoading
              ? "Checking…"
              : "Registered";

  useEffect(() => {
    if (!aboutOpen || !projectPath) {
      setResourceHealth(undefined);
      setResourceHealthError(undefined);
      setResourceHealthLoading(false);
      return;
    }
    let disposed = false;
    setResourceHealthLoading(true);
    setResourceHealthError(undefined);
    api.projectResourceHealth(projectPath)
      .then((report) => {
        if (!disposed) setResourceHealth(report);
      })
      .catch((error) => {
        if (!disposed) setResourceHealthError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!disposed) setResourceHealthLoading(false);
      });
    return () => { disposed = true; };
  }, [aboutOpen, projectPath]);

  useEffect(() => {
    function closeMenus(event: PointerEvent) {
      if (!navRef.current?.contains(event.target as Node)) {
        navRef.current?.querySelectorAll("details[open]").forEach((details) => details.removeAttribute("open"));
      }
    }
    window.addEventListener("pointerdown", closeMenus);
    return () => window.removeEventListener("pointerdown", closeMenus);
  }, []);

  return <>
    <nav className="application-menu" aria-label="Application menu" ref={navRef}>
      <div className="application-menu-brand"><img src="/dgw-mark.svg" alt="" /><b>DGW</b></div>
      <details>
        <summary>File</summary>
        <div className="application-menu-popover file-menu-popover">
          {projectOpen
            ? <div className="file-menu-project"><b>{projectName}</b><span title={projectPath}>{projectPath}</span><small>All changes are saved automatically in this .dgw project folder.</small></div>
            : <p>No project open</p>}
          <button type="button" onClick={(event) => { closeMenu(event); onNewProject(); }}><span>New Project…</span><small>Default setup</small></button>
          <button type="button" onClick={(event) => { closeMenu(event); onNewFromTemplate(); }}><span>New from Template…</span><small>Choose setup</small></button>
          <button type="button" onClick={(event) => { closeMenu(event); onOpenProject(); }}><span>Open Project…</span><kbd>⌘ O</kbd></button>
          <details className="file-menu-submenu">
            <summary><span>Open Example Project</span><small>›</small></summary>
            <div className="file-menu-submenu-options">
              <button type="button" onClick={(event) => { closeMenu(event); onOpenExampleProject("alleleEditingB37"); }}>
                <span>Allele Editing — GRCh37</span><small>Synthetic · 3 tracks</small>
              </button>
              <button type="button" onClick={(event) => { closeMenu(event); onOpenExampleProject("alleleEditingHg38"); }}>
                <span>Allele Editing — GRCh38</span><small>Synthetic · 3 tracks</small>
              </button>
              <button type="button" onClick={(event) => { closeMenu(event); onOpenExampleProject("hg00103Wes"); }}>
                <span>HG00103 exome — GRCh37</span><small>1000 Genomes WES · 19.6K alleles</small>
              </button>
            </div>
          </details>
          {recentProjects.length > 0 && <>
            <p>Open Recent</p>
            {recentProjects.slice(0, 5).map((project) => <button type="button" className="recent-project-item" title={project.path} onClick={(event) => { closeMenu(event); onOpenRecent(project.path); }} key={project.path}>
              <span>{project.name}</span><small>{project.path}</small>
            </button>)}
          </>}
          <hr />
          <button type="button" disabled={!projectOpen || saveStatus === "saving"} onClick={(event) => { closeMenu(event); onSaveProject(); }}><span>{saveStatus === "saving" ? "Saving Project…" : "Save Project"}</span><kbd>⌘ S</kbd></button>
          <button type="button" disabled={!projectOpen || saveStatus === "saving"} onClick={(event) => { closeMenu(event); onSaveProjectCopy(); }}><span>Save a Copy…</span><small>Complete .dgw project</small></button>
          <hr />
          <button type="button" disabled={!projectOpen} onClick={(event) => { closeMenu(event); onExportTrackVcf(); }}><span>Export VCF…</span><small>Current genome track</small></button>
          <button type="button" disabled={!projectOpen} onClick={(event) => { closeMenu(event); onExportFocusFasta(); }}><span>Export FASTA…</span><small>Focused region</small></button>
          <hr />
          <button type="button" disabled={!projectOpen} onClick={(event) => { closeMenu(event); onCloseProject(); }}>Close project</button>
        </div>
      </details>
      <details>
        <summary>Edit</summary>
        <div className="application-menu-popover">
          <button type="button" disabled={!projectOpen || !canUndo} title={undoLabel} onClick={(event) => { closeMenu(event); onUndo(); }}>
            <span>{undoLabel ? `Undo ${undoLabel}` : "Undo"}</span><kbd>⌘ Z</kbd>
          </button>
          <button type="button" disabled={!projectOpen || !canRedo} title={redoLabel} onClick={(event) => { closeMenu(event); onRedo(); }}>
            <span>{redoLabel ? `Redo ${redoLabel}` : "Redo"}</span><kbd>⇧ ⌘ Z</kbd>
          </button>
        </div>
      </details>
      <details>
        <summary>Create</summary>
        <div className="application-menu-popover">
          <button type="button" disabled={!projectOpen} onClick={(event) => { closeMenu(event); onAddDevice(); }}>
            <span>Add Device…</span><small>Selected track</small>
          </button>
        </div>
      </details>
      <details>
        <summary>View</summary>
        <div className="application-menu-popover view-menu">
          <button type="button" className={settings.showVariantBrowser ? "is-selected" : ""} onClick={() => onSettingsChange({ ...settings, showVariantBrowser: !settings.showVariantBrowser })}>Variants panel</button>
          <button type="button" className={settings.showEvidenceInspector ? "is-selected" : ""} onClick={() => onSettingsChange({ ...settings, showEvidenceInspector: !settings.showEvidenceInspector })}>Evidence panel</button>
          <button type="button" className={settings.showEvidenceInspector && settings.showContextHelp ? "is-selected" : ""} onClick={() => {
            const visible = settings.showEvidenceInspector && settings.showContextHelp;
            onSettingsChange({
              ...settings,
              showEvidenceInspector: visible ? settings.showEvidenceInspector : true,
              showContextHelp: !visible
            });
          }}>Context Help</button>
          <button type="button" className={settings.showDeviceRack ? "is-selected" : ""} onClick={() => onSettingsChange({ ...settings, showDeviceRack: !settings.showDeviceRack })}>Device Rack</button>
          <button type="button" className={settings.showTrackMonitor ? "is-selected" : ""} onClick={() => onSettingsChange({ ...settings, showTrackMonitor: !settings.showTrackMonitor })}>Track Monitor</button>
          <hr />
          <p>Interface scale</p>
          {UI_SCALES.map((scale) => <button
            type="button"
            className={settings.uiScale === scale ? "is-selected" : ""}
            onClick={() => onSettingsChange({ ...settings, uiScale: scale })}
            key={scale}
          >{Math.round(scale * 100)}%</button>)}
        </div>
      </details>
      <button type="button" className="application-menu-button" disabled={!projectOpen} onClick={onOpenJobs}>Jobs</button>
      <button type="button" className="application-menu-button" onClick={onOpenSettings}>Settings</button>
      <details>
        <summary>Help</summary>
        <div className="application-menu-popover">
          <button type="button" onClick={(event) => { closeMenu(event); setAboutOpen(true); }}>About DGW</button>
        </div>
      </details>
      <span className={`application-menu-context${saveStatus ? ` is-${saveStatus}` : ""}`}>{projectOpen ? `${projectName} · ${saveMessage ?? "autosaved"}` : "Project setup"}</span>
    </nav>
    {aboutOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAboutOpen(false); }}>
      <section className="settings-dialog about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <header><div><p className="eyebrow">Digital Genome Workstation</p><h2 id="about-title">DGW 0.1.0</h2></div><button type="button" className="dialog-close" onClick={() => setAboutOpen(false)} aria-label="Close">×</button></header>
        <p>Build and compare reversible genome-track scenarios, then evaluate each changed allele against configured biological resources.</p>
        <dl className="about-project"><div><dt>Author</dt><dd>Manuel Rueda</dd></div><div><dt>License</dt><dd>Apache-2.0</dd></div></dl>
        <section className="about-resources" aria-label="Tools and resources">
          <header>
            <div><h3>Tools and resources</h3><p>{resourceBundle ? "Registered by the current project" : "Open a project to inspect its resource profile"}</p></div>
            {resourceBundle && <span>{resourceBundle.id} · {resourceBundle.assembly}{resourceHealth && <> · <b className={`health-${resourceHealth.status}`}>{healthLabel(resourceHealth.status)}</b></>}</span>}
          </header>
          {resourceBundle ? <div className="about-resource-list">
            <article title={resourceHealth?.items.find((item) => item.id === "toolchain")?.summary ?? resourceBundle.bcftoolsPath}>
              <div><b>bcftools toolchain</b><small>bcftools · bgzip · tabix</small></div>
              <strong>{resourceBundle.bcftoolsVersion ? `v${resourceBundle.bcftoolsVersion}` : "Version not specified"}</strong>
              {(() => {
                const status = resourceHealth?.items.find((item) => item.id === "toolchain")?.status;
                return <span className={`health-${status ?? "registered"}`}>{healthLabel(status)}</span>;
              })()}
            </article>
            {registeredResources.map((resource) => {
              const health = resourceHealth?.items.find((item) => item.id === resource.id);
              return <article title={health?.summary ?? resource.path} key={resource.name}>
              <div><b>{resource.name}</b><small>{resource.detail}</small></div>
              <strong>{resource.release}</strong>
              <span className={`health-${health?.status ?? (resource.configured ? "registered" : "notConfigured")}`}>{healthLabel(health?.status ?? (resource.configured ? undefined : "notConfigured"))}</span>
            </article>})}
            {resourceHealthError && <p className="about-resource-error">Health check failed: {resourceHealthError}</p>}
          </div> : <p className="about-resource-empty">Resource versions are pinned per <code>.dgw</code> project.</p>}
          <footer>External tools and datasets are not redistributed with DGW and retain their own licenses and terms.</footer>
        </section>
      </section>
    </div>}
  </>;
}

export function JobsDialog({
  open,
  jobs,
  loading,
  onRefresh,
  onDeleteFinished,
  onCancel,
  onClose
}: {
  open: boolean;
  jobs: BackgroundJob[];
  loading: boolean;
  onRefresh: () => void;
  onDeleteFinished: () => void;
  onCancel: (jobId: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open]);

  if (!open) return null;
  const finishedCount = jobs.filter((job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled").length;
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="settings-dialog jobs-dialog" role="dialog" aria-modal="true" aria-labelledby="jobs-title">
      <header>
        <div><p className="eyebrow">Compute</p><h2 id="jobs-title">Background jobs</h2></div>
        <button type="button" className="dialog-close" onClick={onClose} aria-label="Close jobs">×</button>
      </header>
      <div className="jobs-toolbar">
        <p>Persistent device operations for this project.</p>
        <span>
          <button type="button" className="danger" onClick={onDeleteFinished} disabled={loading || finishedCount === 0}>Delete finished{finishedCount > 0 ? ` (${finishedCount})` : ""}</button>
          <button type="button" onClick={onRefresh} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>
        </span>
      </div>
      <div className="jobs-list">
        {jobs.length === 0 ? <p className="jobs-empty">No background jobs in this project.</p> : jobs.map((job) => <article className={`job-row is-${job.status}`} key={job.id}>
          <header><div><b>{job.deviceId.includes("mutation-generator") ? "Mutation Generator" : job.deviceId.includes("genome-morph") ? "Genome Morph" : job.deviceId.includes("track-profiler") ? "Track Profiler" : job.deviceId}</b><small>{job.operation} · thread limit {job.workerThreads}</small></div><span>{job.status}</span></header>
          <div className="job-progress"><i style={{ width: `${job.progress}%` }} /></div>
          <p>{job.progress}% · {job.message}</p>
          <footer><small>{new Date(job.updatedAt).toLocaleString()}</small>{(job.status === "queued" || job.status === "running") && <button type="button" onClick={() => onCancel(job.id)}>Cancel</button>}</footer>
        </article>)}
      </div>
    </section>
  </div>;
}

export function ProjectTemplateDialog({
  open,
  currentProjectOpen,
  busy,
  error,
  onSelect,
  onClose
}: {
  open: boolean;
  currentProjectOpen: boolean;
  busy: boolean;
  error?: string;
  onSelect: (template: ProjectTemplateId) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open]);

  if (!open) return null;
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="settings-dialog project-template-dialog" role="dialog" aria-modal="true" aria-labelledby="project-template-title">
      <header><div><p className="eyebrow">New project</p><h2 id="project-template-title">Choose a template</h2></div><button type="button" className="dialog-close" onClick={onClose} aria-label="Close">×</button></header>
      <p className="project-template-help">{currentProjectOpen
        ? "Create a new project from this project's imported source genome. Existing edits are not copied."
        : "A template chooses the devices applied to new tracks. Next, choose your VCF or open the bundled example."}</p>
      {error && <p className="project-template-error">{error}</p>}
      <div className="project-template-options">
        <button type="button" disabled={busy} onClick={() => onSelect("standardEvidence")}>
          <b>DGW Starter</b>
          <span>{busy ? "Creating project…" : "Start with Mutation Generator, Genome Morph, the four Evidence devices, Genome Optimizer, and Variant Map applied."}</span>
        </button>
        <button type="button" disabled={busy} onClick={() => onSelect("empty")}>
          <b>Empty</b>
          <span>{busy ? "Creating project…" : "Start with no devices applied; add them later from Create."}</span>
        </button>
      </div>
    </section>
  </div>;
}

export function SettingsDialog({
  open,
  settings,
  onChange,
  onClose
}: {
  open: boolean;
  settings: UserSettings;
  onChange: (settings: UserSettings) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open]);

  if (!open) return null;
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header>
        <div><p className="eyebrow">Preferences</p><h2 id="settings-title">User settings</h2></div>
        <button type="button" className="dialog-close" onClick={onClose} aria-label="Close settings">×</button>
      </header>

      <div className="settings-section">
        <div><h3>Interface scale</h3><p>Scale text and controls together. At 140–150%, hide a side panel from View when you need more room for the genome workspace.</p></div>
        <div className="settings-scale-options" role="group" aria-label="Interface scale">
          {UI_SCALES.map((scale) => <button
            type="button"
            aria-pressed={settings.uiScale === scale}
            className={settings.uiScale === scale ? "active" : ""}
            onClick={() => onChange({ ...settings, uiScale: scale as UiScale })}
            key={scale}
          >{Math.round(scale * 100)}%</button>)}
        </div>
      </div>

      <div className="settings-section">
        <div><h3>Appearance</h3><p>Use the system appearance or choose a theme for DGW.</p></div>
        <div className="settings-theme-options" role="group" aria-label="Colour theme">
          {(["system", "dark", "light"] as const).map((theme) => <button
            type="button"
            aria-pressed={settings.colorTheme === theme}
            className={settings.colorTheme === theme ? "active" : ""}
            onClick={() => onChange({ ...settings, colorTheme: theme })}
            key={theme}
          >{theme[0].toUpperCase() + theme.slice(1)}</button>)}
        </div>
      </div>

      <div className="settings-section settings-compute">
        <div><h3>Compute</h3><p>Bulk device operations run as background jobs. Auto reserves one logical CPU for the workstation interface; each engine uses the limit when it supports parallel workers.</p></div>
        <label>
          <span>Worker threads</span>
          <select value={settings.workerThreads} onChange={(event) => onChange({
            ...settings,
            workerThreads: event.target.value === "auto" ? "auto" : Number(event.target.value)
          })}>
            <option value="auto">Auto ({Math.max(1, (navigator.hardwareConcurrency || 2) - 1)})</option>
            {Array.from({ length: Math.max(1, navigator.hardwareConcurrency || 4) }, (_, index) => index + 1)
              .map((threads) => <option value={threads} key={threads}>{threads}</option>)}
          </select>
        </label>
        <label>
          <span>Interactive allele limit</span>
          <input
            type="number"
            min="100"
            max="1000"
            step="100"
            value={settings.interactiveAlleleLimit}
            onChange={(event) => onChange({
              ...settings,
              interactiveAlleleLimit: Math.max(100, Math.min(1_000, Number(event.target.value) || 1_000))
            })}
          />
          <small>Larger selections run in the background and apply as one compact, reversible mutation layer.</small>
        </label>
      </div>

      <label className="settings-check"><input type="checkbox" checked={settings.showVariantBrowser} onChange={(event) => onChange({ ...settings, showVariantBrowser: event.target.checked })} /><span><b>Show Variants panel</b><small>Keep the allele browser visible when a project opens.</small></span></label>
      <label className="settings-check"><input type="checkbox" checked={settings.showEvidenceInspector} onChange={(event) => onChange({ ...settings, showEvidenceInspector: event.target.checked })} /><span><b>Show Evidence panel</b><small>Keep selected-allele results visible at the right.</small></span></label>
      <label className="settings-check"><input type="checkbox" checked={settings.showContextHelp} onChange={(event) => onChange({
        ...settings,
        showEvidenceInspector: event.target.checked ? true : settings.showEvidenceInspector,
        showContextHelp: event.target.checked
      })} /><span><b>Expand Context Help</b><small>Explain the control under the pointer or keyboard focus at the bottom of the Inspector.</small></span></label>
      <label className="settings-check"><input type="checkbox" checked={settings.showDeviceRack} onChange={(event) => onChange({ ...settings, showDeviceRack: event.target.checked })} /><span><b>Show Device Rack</b><small>Keep editing and analysis devices below the genome tracks.</small></span></label>
      <label className="settings-check"><input type="checkbox" checked={settings.showTrackMonitor} onChange={(event) => onChange({ ...settings, showTrackMonitor: event.target.checked })} /><span><b>Show Track Monitor</b><small>Keep the selected track's additive profile and device coverage at the far right.</small></span></label>
      <label className="settings-check"><input type="checkbox" checked={settings.reduceMotion} onChange={(event) => onChange({ ...settings, reduceMotion: event.target.checked })} /><span><b>Reduce motion</b><small>Disable interface transitions and status animations.</small></span></label>

      <footer>
        <button type="button" className="button ghost" onClick={() => onChange({ ...DEFAULT_USER_SETTINGS })}>Restore defaults</button>
        <button type="button" className="button primary" onClick={onClose}>Done</button>
      </footer>
    </section>
  </div>;
}
