import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, type ResourceInventory, type ResourceInstallProgress } from "./api";

function size(bytes: number) {
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

export function ResourcesPanel({ onBusyChange }: { onBusyChange?: (busy: boolean) => void } = {}) {
  const [inventory, setInventory] = useState<ResourceInventory>();
  const [progress, setProgress] = useState<ResourceInstallProgress>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [assembly, setAssembly] = useState("b37");
  const [cosmicProfile, setCosmicProfile] = useState("");
  const [cosmicPath, setCosmicPath] = useState("");
  const [cosmicRelease, setCosmicRelease] = useState("");
  const [cosmicConfirmed, setCosmicConfirmed] = useState(false);
  const [cosmicSaved, setCosmicSaved] = useState(false);
  const [cosmicBusy, setCosmicBusy] = useState(false);
  const [cosmicError, setCosmicError] = useState<string>();
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  async function refresh() {
    try { setInventory(await api.resourceInventory()); }
    catch (reason) { setError(String(reason)); }
  }
  useEffect(() => { void refresh(); }, []);
  async function run(action: () => Promise<unknown>, cosmic = false) {
    setBusy(true); setError(undefined); setProgress(undefined);
    if (cosmic) { setCosmicBusy(true); setCosmicError(undefined); setCosmicSaved(false); }
    try {
      await action();
      await refresh();
      window.dispatchEvent(new Event("dgw-resources-changed"));
    } catch (reason) { if (cosmic) setCosmicError(String(reason)); else setError(String(reason)); }
    finally { setBusy(false); setCosmicBusy(false); }
  }
  async function chooseDirectory() {
    const path = await open({ directory: true, multiple: false, title: "Resource installation folder" });
    if (typeof path === "string") await run(() => api.setResourceDirectory(path));
  }
  async function register() {
    const path = await open({ multiple: false, title: "Choose an existing DGW resource descriptor", filters: [{ name: "DGW resources", extensions: ["json"] }] });
    if (typeof path === "string") await run(() => api.registerResourceBundle(path));
  }
  async function installDownloaded() {
    const paths = await open({ multiple: true, title: "Choose a DGW data package and tool package", filters: [{ name: "DGW packages", extensions: ["gz"] }] });
    if (Array.isArray(paths) && paths.length) await run(() => api.installDownloadedPackages(paths, setProgress));
  }
  const release = inventory?.releases.find(entry => entry.assembly === assembly && entry.platform === inventory.platform);
  const installed = inventory?.installed.filter(entry => entry.bundle.assembly === assembly) ?? [];
  const ready = installed.some(entry => entry.ready);
  const downloadBytes = release?.files.reduce((sum, file) => sum + file.bytes, 0) ?? 0;
  const storageBytes = release?.files.reduce((sum, file) => sum + file.bytes + (file.unpackedBytes ?? 0), 0) ?? 0;
  const cosmicMissing = [
    !cosmicProfile && "choose a reference profile",
    !cosmicPath && "choose a COSMIC VCF",
    !cosmicRelease.trim() && "enter the COSMIC release",
    !cosmicConfirmed && "confirm the assembly"
  ].filter(Boolean);
  return <section className="resources-panel" aria-label="Resources">
    <header className="resource-heading"><h3>Genome resources</h3>
    <p>Reference data and tools for your VCF's assembly.</p></header>
    {!inventory && !error && <p role="status">Checking installed resources…</p>}
    {inventory && <>
      {inventory.issues.map((issue) => <p className="warning" key={issue}>{issue}</p>)}
      <fieldset disabled={busy} className="resource-genome-choice"><legend>Reference genome</legend>
        {(["b37", "hg38"] as const).map(value => <label key={value}>
          <input type="radio" name="resource-genome" value={value} checked={assembly === value} onChange={() => setAssembly(value)} />
          {value === "b37" ? "GRCh37" : "GRCh38"}
        </label>)}
      </fieldset>
      <div className="resource-storage-row"><div><h4>Storage folder</h4>
      <p className="resource-location">{inventory.directory}</p>
      <small>Existing resources are not moved.</small></div>
      <button type="button" className="button secondary" disabled={busy} onClick={() => void chooseDirectory()}>Choose location</button>
      </div>
      <div className="resource-install-status" data-ready={ready}><h4>{assembly === "b37" ? "GRCh37" : "GRCh38"} resources</h4>
      {ready ? <p role="status"><span className="resource-ready-dot" aria-hidden="true" />{assembly === "b37" ? "GRCh37" : "GRCh38"} is ready to use.</p> : release ? <>
        <p>{size(downloadBytes)} download{release.files.every(file => file.unpackedBytes !== undefined) ? ` · At least ${size(storageBytes)} for archives and installed files, plus temporary working space` : ""}</p>
        <button type="button" className="button primary" disabled={busy} onClick={() => void run(() => api.installResourceRelease(release.id, setProgress))}>Download and install</button>
      </> : <p>Downloads are not available for this genome on this computer. Use existing resources or downloaded files below.</p>}
      {installed.filter(entry => !entry.ready).map(entry => <p className="warning" key={entry.descriptor}>{entry.message}</p>)}
      </div>
      <details><summary>Other installation options</summary>
        <p>Select one assembly data archive and the tool archive for this computer. DGW verifies them before installation.</p>
        <button type="button" className="button secondary" disabled={busy} onClick={() => void installDownloaded()}>Install downloaded packages</button>
        <p>Choose the JSON descriptor for resources already on your computer. No data is copied.</p>
        <button type="button" className="button secondary" disabled={busy} onClick={() => void register()}>Use existing resources</button>
      </details>
      <details>
        <summary>Advanced</summary>
        <p>Register resources you already have using their DGW JSON descriptor. Relative paths are resolved from its folder.</p>
        <p>Computer: {inventory.platform}</p>
        {installed.map(entry => <p key={entry.descriptor}>{entry.ready ? "Ready" : "Needs attention"} · {entry.bundle.id}</p>)}
      </details>
    </>}
    {busy && !progress && !cosmicBusy && <p role="status">Checking resources…</p>}
    {progress && <div role="status" aria-live="polite">
      <p>{progress.message}</p>
      <progress max={Math.max(1, progress.totalBytes)} value={progress.completedBytes} />
      <small>{size(progress.completedBytes)} / {size(progress.totalBytes)}</small>
    </div>}
    {error && <p role="alert" className="warning">{error}</p>}
    <p><small>Interrupted installations reuse verified complete files. A partially downloaded file restarts when you retry.</small></p>
    <details>
      <summary>Optional resources · COSMIC</summary>
      <p>Add your separately obtained COSMIC VCF. It is not required for editing or consequence prediction.</p>
      <fieldset disabled={busy} className="cosmic-setup">
        <legend>COSMIC setup</legend>
        <label>Reference profile<select value={cosmicProfile} onChange={event => { setCosmicProfile(event.target.value); setCosmicConfirmed(false); setCosmicSaved(false); }}>
          <option value="">Choose an installed profile</option>
          {inventory?.installed.filter(entry => entry.ready).map(entry => <option key={entry.descriptor} value={entry.descriptor}>{entry.bundle.assembly === "b37" ? "GRCh37" : "GRCh38"} · {entry.bundle.id}</option>)}
        </select></label>
        <button type="button" className="button secondary" onClick={() => void (async () => {
          const path = await open({ multiple: false, title: "Choose COSMIC VCF (.vcf.gz)", filters: [{ name: "Compressed VCF", extensions: ["gz"] }] });
          if (typeof path === "string") { setCosmicPath(path); setCosmicConfirmed(false); setCosmicSaved(false); }
        })().catch(reason => setCosmicError(String(reason)))}>Choose COSMIC VCF…</button>
        {cosmicPath && <small className="resource-location">{cosmicPath}</small>}
        <small>A matching .tbi or .csi index must be beside the VCF. TSV exports are not supported.</small>
        <label>COSMIC release<input value={cosmicRelease} placeholder="For example, v103" maxLength={120} onChange={event => { setCosmicRelease(event.target.value); setCosmicSaved(false); }} /></label>
        <label className="cosmic-confirm"><input type="checkbox" checked={cosmicConfirmed} onChange={event => setCosmicConfirmed(event.target.checked)} />I confirm that this COSMIC file uses the same assembly as the selected profile.</label>
        <small>DGW checks the VCF header and index. These checks cannot establish the assembly; use the build stated by the data provider.</small>
        {inventory && !inventory.installed.some(entry => entry.ready) && <p className="warning">No ready reference profile is registered. Install genome resources or use “Use existing resources” above first.</p>}
        {!cosmicBusy && !cosmicSaved && cosmicMissing.length > 0 && <small id="cosmic-required-fields">To enable validation: {cosmicMissing.join("; ")}.</small>}
        <button type="button" className="button primary" aria-describedby={cosmicMissing.length && !cosmicBusy && !cosmicSaved ? "cosmic-required-fields" : undefined} disabled={busy || cosmicMissing.length > 0} onClick={() => void run(async () => { await api.addCosmicResource(cosmicProfile, cosmicPath, cosmicRelease); setCosmicSaved(true); }, true)}>{cosmicBusy ? "Validating COSMIC…" : "Validate and add COSMIC"}</button>
      </fieldset>
      {cosmicBusy && <p role="status">Checking the COSMIC VCF header, index and reference profile…</p>}
      {cosmicError && <p role="alert" className="warning">{cosmicError}</p>}
      {cosmicSaved && <p role="status">COSMIC profile added. Select it when creating a new project.</p>}
      <p><small>Files stay where they are. This creates a new resource profile; existing projects and their recorded evidence resources are unchanged.</small></p>
    </details>
  </section>;
}
