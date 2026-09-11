import { useEffect, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Check, FolderOpen, LoaderCircle } from "lucide-react";

type SetupInfo = { platform: string; version: string; suggestedParent: string };
export function UserSetup() {
  const [info, setInfo] = useState<SetupInfo>();
  const [parent, setParent] = useState("");
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [installed, setInstalled] = useState("");
  const [error, setError] = useState("");
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [launchRequested, setLaunchRequested] = useState(false);
  useEffect(() => { void invoke<SetupInfo>("user_setup_info").then(value => { setInfo(value); setParent(value.suggestedParent); }).catch(error => setError(String(error))); }, []);
  async function choose() {
    try {
      const folder = await open({ directory: true, multiple: false, title: "Install DGW in a folder you own", defaultPath: parent });
      if (typeof folder === "string") setParent(folder);
    } catch (error) { setError(String(error)); }
  }
  async function install() {
    setBusy(true); setError(""); setSteps(["Preparing your installation…"]);
    const progress = new Channel<string>();
    progress.onmessage = message => setSteps(previous => [...previous, message]);
    try { setInstalled(await invoke<string>("install_for_user", { parent, replaceExisting, onProgress: progress })); }
    catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  }
  async function launch() {
    setBusy(true); setError("");
    try { await invoke("launch_user_install"); setLaunchRequested(true); setBusy(false); }
    catch (error) { setError(String(error)); setBusy(false); }
  }
  return <main className="user-setup">
    <header><img src="/dgw-mark.svg" alt="DGW" /><div><p>Digital Genome Workstation</p><h1>{installed ? "DGW is installed" : "Install DGW for your user"}</h1></div></header>
    <p>Step 1 of 2 · Install the application. No administrator access required.</p>
    {!installed ? <>
      <label htmlFor="install-parent">Installation folder</label>
      <div className="setup-folder"><input id="install-parent" value={parent} onChange={event => setParent(event.target.value)} disabled={busy || !info} /><button onClick={() => { void choose(); }} disabled={busy || !info} aria-label="Choose installation folder"><FolderOpen aria-hidden="true" /></button></div>
      <small>DGW {info?.version ?? "…"} will be placed in its own folder here.</small>
      <label className="setup-replace"><input type="checkbox" checked={replaceExisting} disabled={busy} onChange={event => setReplaceExisting(event.target.checked)} />Replace existing installation and shortcut</label>
      <small>The previous application and shortcut are backed up. Projects and genome resources are not changed. Close DGW before replacing it.</small>
      <div className="setup-summary"><Check aria-hidden="true" /><span>{info?.platform === "macos" ? "Copy the complete application bundle, preserving its signature" : "Copy DGW and add an applications-menu shortcut"}</span></div>
    </> : <p className="setup-installed-path">{installed}</p>}
    {steps.length > 0 && <ol aria-label="Installation progress" aria-live="polite">{steps.map((step, index) => <li key={`${index}:${step}`}>{busy && index === steps.length - 1 ? <LoaderCircle className="setup-spinner" aria-hidden="true" /> : <Check aria-hidden="true" />}<span>{step}</span></li>)}</ol>}
    <footer><p>Step 2 · Set up genome resources inside DGW. Your projects and resources stay separate from the application.</p>
      {error && <p role="alert">{error}</p>}
      {launchRequested && <p role="status">DGW has been asked to open. Close this installer once the DGW window appears. If it does not appear, launch DGW from your applications menu.</p>}
      <button className="button primary" disabled={busy || launchRequested || !info || !parent.trim()} onClick={() => { void (installed ? launch() : install()); }}>{busy ? "Working…" : launchRequested ? "Launch requested" : installed ? "Continue to genome setup" : replaceExisting ? "Install / Replace" : "Install"}</button></footer>
  </main>;
}
