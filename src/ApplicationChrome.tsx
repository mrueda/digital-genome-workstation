import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_USER_SETTINGS,
  UI_SCALES,
  type UiScale,
  type UserSettings
} from "./userSettings";

function closeMenu(event: React.MouseEvent<HTMLElement>) {
  event.currentTarget.closest("details")?.removeAttribute("open");
}

export function ApplicationMenu({
  projectOpen,
  projectName,
  settings,
  onSettingsChange,
  onOpenSettings,
  onExportTrackVcf,
  onExportFocusFasta,
  onCloseProject
}: {
  projectOpen: boolean;
  projectName?: string;
  settings: UserSettings;
  onSettingsChange: (settings: UserSettings) => void;
  onOpenSettings: () => void;
  onExportTrackVcf: () => void;
  onExportFocusFasta: () => void;
  onCloseProject: () => void;
}) {
  const navRef = useRef<HTMLElement>(null);
  const [aboutOpen, setAboutOpen] = useState(false);

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
      <div className="application-menu-brand"><img src="/dgw-logo.png" alt="" /><b>DGW</b></div>
      <details>
        <summary>File</summary>
        <div className="application-menu-popover">
          <p>{projectOpen ? projectName : "No project open"}</p>
          <button type="button" disabled={!projectOpen} onClick={(event) => { closeMenu(event); onExportTrackVcf(); }}><span>Export VCF…</span><small>Current genome track</small></button>
          <button type="button" disabled={!projectOpen} onClick={(event) => { closeMenu(event); onExportFocusFasta(); }}><span>Export FASTA…</span><small>Focused region</small></button>
          <hr />
          <button type="button" disabled={!projectOpen} onClick={(event) => { closeMenu(event); onCloseProject(); }}>Close project</button>
        </div>
      </details>
      <details>
        <summary>View</summary>
        <div className="application-menu-popover view-menu">
          <button type="button" className={settings.showVariantBrowser ? "is-selected" : ""} onClick={() => onSettingsChange({ ...settings, showVariantBrowser: !settings.showVariantBrowser })}>Variants panel</button>
          <button type="button" className={settings.showEvidenceInspector ? "is-selected" : ""} onClick={() => onSettingsChange({ ...settings, showEvidenceInspector: !settings.showEvidenceInspector })}>Evidence panel</button>
          <button type="button" className={settings.showMasterMeter ? "is-selected" : ""} onClick={() => onSettingsChange({ ...settings, showMasterMeter: !settings.showMasterMeter })}>Master Meter</button>
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
      <button type="button" className="application-menu-button" onClick={onOpenSettings}>Settings</button>
      <details>
        <summary>Help</summary>
        <div className="application-menu-popover">
          <button type="button" onClick={(event) => { closeMenu(event); setAboutOpen(true); }}>About DGW</button>
        </div>
      </details>
      <span className="application-menu-context">{projectOpen ? projectName : "Project setup"}</span>
    </nav>
    {aboutOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAboutOpen(false); }}>
      <section className="settings-dialog about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <header><div><p className="eyebrow">Digital Genome Workstation</p><h2 id="about-title">DGW 0.1.0</h2></div><button type="button" className="dialog-close" onClick={() => setAboutOpen(false)} aria-label="Close">×</button></header>
        <p>Build and compare reversible genome-track scenarios, then evaluate each changed allele against configured biological resources.</p>
        <dl><div><dt>Author</dt><dd>Manuel Rueda</dd></div><div><dt>License</dt><dd>Apache-2.0</dd></div></dl>
      </section>
    </div>}
  </>;
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

      <label className="settings-check"><input type="checkbox" checked={settings.showVariantBrowser} onChange={(event) => onChange({ ...settings, showVariantBrowser: event.target.checked })} /><span><b>Show Variants panel</b><small>Keep the allele browser visible when a project opens.</small></span></label>
      <label className="settings-check"><input type="checkbox" checked={settings.showEvidenceInspector} onChange={(event) => onChange({ ...settings, showEvidenceInspector: event.target.checked })} /><span><b>Show Evidence panel</b><small>Keep selected-allele results visible at the right.</small></span></label>
      <label className="settings-check"><input type="checkbox" checked={settings.showMasterMeter} onChange={(event) => onChange({ ...settings, showMasterMeter: event.target.checked })} /><span><b>Show Master Meter</b><small>Keep the selected track's source-relative output fixed at the right of its device rack.</small></span></label>
      <label className="settings-check"><input type="checkbox" checked={settings.reduceMotion} onChange={(event) => onChange({ ...settings, reduceMotion: event.target.checked })} /><span><b>Reduce motion</b><small>Disable interface transitions and status animations.</small></span></label>

      <footer>
        <button type="button" className="button ghost" onClick={() => onChange({ ...DEFAULT_USER_SETTINGS })}>Restore defaults</button>
        <button type="button" className="button primary" onClick={onClose}>Done</button>
      </footer>
    </section>
  </div>;
}
