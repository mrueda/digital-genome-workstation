import { useEffect, useRef, useState } from "react";
import { api } from "./api";

export function UpdateDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(true);
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.checkAppUpdates>>>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    let active = true;
    setBusy(true); setError(undefined); setResult(undefined);
    api.checkAppUpdates().then(value => { if (active) setResult(value); })
      .catch(reason => { if (active) setError(String(reason)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [attempt]);
  return <dialog ref={dialog} className="settings-dialog update-dialog" aria-labelledby="update-title" onCancel={onClose}>
    <header><div><p className="eyebrow">DGW releases</p><h2 id="update-title">Check for updates</h2></div>
      <button type="button" className="dialog-close" onClick={onClose} aria-label="Close update check">×</button></header>
    <div className="update-dialog-body">
      <p role="status" aria-live="polite">{busy ? "Checking GitHub releases…" : result?.message}</p>
      {result && <p>Installed: {result.currentVersion}{result.latestVersion && <> · Latest stable: {result.latestVersion}</>}</p>}
      {error && <p role="alert">{error}</p>}
      <p>Stable releases only. This check does not detect replaced preview installers with the same version. No project or genome data is sent, and nothing is installed automatically.</p>
    </div>
    <footer><button type="button" disabled={busy} onClick={() => setAttempt(value => value + 1)}>Check again</button>
      <button type="button" onClick={() => void api.openAppReleases().catch(reason => setError(String(reason)))}>Open GitHub releases</button></footer>
  </dialog>;
}
