import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, type ResourceInventory, type ResourceInstallProgress } from "./api";

function size(bytes: number) {
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

export function ResourcesPanel() {
  const [inventory, setInventory] = useState<ResourceInventory>();
  const [progress, setProgress] = useState<ResourceInstallProgress>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
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
  return <section className="resources-panel" aria-label="Resources">
    <h3>Genome resources</h3>
    <p>Install the reference and supporting data for the assembly you use. Existing projects keep their recorded resource versions.</p>
    {!inventory && !error && <p role="status">Checking installed resources…</p>}
    {inventory && <>
      {inventory.issues.map((issue) => <p className="warning" key={issue}>{issue}</p>)}
      <div className="resource-assembly-cards">
        {(["b37", "hg38"] as const).map((assembly) => {
          const installed = inventory.installed.filter((entry) => entry.bundle.assembly === assembly);
          const releases = inventory.releases.filter((entry) => entry.assembly === assembly && entry.platform === inventory.platform);
          return <article key={assembly}>
            <h4>{assembly === "b37" ? "GRCh37" : "GRCh38"}</h4>
            {installed.map((entry) => <div key={entry.descriptor}>
              <b>{entry.ready ? "Ready" : "Needs attention"} · {entry.bundle.id}</b>
              <p>{entry.message}</p>
            </div>)}
            {!installed.length && <p>Not installed</p>}
            {releases.map((release) => <div key={release.id}>
              <p>{release.name} · {release.version} · {size(release.files.reduce((sum, file) => sum + file.bytes, 0))}</p>
              <button type="button" className="button primary" disabled={busy} onClick={() => void run(() => api.installResourceRelease(release.id, setProgress))}>
                Install resources
              </button>
            </div>)}
            {!releases.length && <small>Automatic download is not available in this build. You can install downloaded packages below.</small>}
          </article>;
        })}
      </div>
      <p>Already downloaded the packages? Select one assembly data archive and the tool archive for this computer ({inventory.platform}). DGW checks both before installing.</p>
      <button type="button" className="button primary" disabled={busy} onClick={() => void installDownloaded()}>Install downloaded packages</button>
      <p>Install location: <span className="resource-location">{inventory.directory}</span></p>
      <button type="button" className="button secondary" disabled={busy} onClick={() => void chooseDirectory()}>Choose location</button>
      <small>Changing this location affects future installations. Existing resources are not moved.</small>
      <details>
        <summary>Advanced</summary>
        <p>Register resources you already have using their DGW JSON descriptor. Relative paths are resolved from its folder.</p>
        <button type="button" className="button secondary" disabled={busy} onClick={() => void register()}>Use existing resources</button>
        <p>Computer: {inventory.platform}</p>
      </details>
    </>}
    {busy && !progress && <p role="status">Checking resources…</p>}
    {progress && <div role="status" aria-live="polite">
      <p>{progress.message}</p>
      <progress max={Math.max(1, progress.totalBytes)} value={progress.completedBytes} />
      <small>{size(progress.completedBytes)} / {size(progress.totalBytes)}</small>
    </div>}
    {error && <p role="alert" className="warning">{error}</p>}
    <p><small>Interrupted installations reuse verified complete files. A partially downloaded file restarts when you retry. COSMIC is not included.</small></p>
  </section>;
}
