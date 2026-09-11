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
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  async function refresh() {
    try { setInventory(await api.resourceInventory()); }
    catch (reason) { setError(String(reason)); }
  }
  useEffect(() => { void refresh(); }, []);
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError(undefined); setProgress(undefined);
    try {
      await action();
      await refresh();
      window.dispatchEvent(new Event("dgw-resources-changed"));
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
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
  return <section className="resources-panel" aria-label="Resources">
    <h3>Genome resources</h3>
    <p>Choose the reference genome used by your VCF. DGW includes the matching tools automatically.</p>
    {!inventory && !error && <p role="status">Checking installed resources…</p>}
    {inventory && <>
      {inventory.issues.map((issue) => <p className="warning" key={issue}>{issue}</p>)}
      <fieldset disabled={busy} className="resource-genome-choice"><legend>1. Choose genome</legend>
        {(["b37", "hg38"] as const).map(value => <label key={value}>
          <input type="radio" name="resource-genome" value={value} checked={assembly === value} onChange={() => setAssembly(value)} />
          {value === "b37" ? "GRCh37" : "GRCh38"}
        </label>)}
      </fieldset>
      <h4>2. Choose storage folder</h4>
      <p className="resource-location">{inventory.directory}</p>
      <button type="button" className="button secondary" disabled={busy} onClick={() => void chooseDirectory()}>Choose location</button>
      <small>You can use another drive. Existing resources are not moved.</small>
      <h4>3. Install resources</h4>
      {ready ? <p role="status">{assembly === "b37" ? "GRCh37" : "GRCh38"} is ready to use.</p> : release ? <>
        <p>{size(downloadBytes)} download{release.files.every(file => file.unpackedBytes !== undefined) ? ` · At least ${size(storageBytes)} for archives and installed files, plus temporary working space` : ""}</p>
        <button type="button" className="button primary" disabled={busy} onClick={() => void run(() => api.installResourceRelease(release.id, setProgress))}>Download and install</button>
      </> : <p>Downloads are not available for this genome on this computer. Use existing resources or downloaded files below.</p>}
      {installed.filter(entry => !entry.ready).map(entry => <p className="warning" key={entry.descriptor}>{entry.message}</p>)}
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
    {busy && !progress && <p role="status">Checking resources…</p>}
    {progress && <div role="status" aria-live="polite">
      <p>{progress.message}</p>
      <progress max={Math.max(1, progress.totalBytes)} value={progress.completedBytes} />
      <small>{size(progress.completedBytes)} / {size(progress.totalBytes)}</small>
    </div>}
    {error && <p role="alert" className="warning">{error}</p>}
    <p><small>Interrupted installations reuse verified complete files. A partially downloaded file restarts when you retry.</small></p>
    <details>
      <summary>Optional resources</summary>
      <p>COSMIC is optional and distributed separately. DGW does not need it for editing or consequence prediction. To use it, register a compatible resource bundle containing your separately obtained COSMIC data.</p>
    </details>
  </section>;
}
