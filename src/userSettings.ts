export const UI_SCALES = [0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5] as const;

export type UiScale = typeof UI_SCALES[number];
export type ColorTheme = "system" | "dark" | "light";

export interface UserSettings {
  uiScale: UiScale;
  colorTheme: ColorTheme;
  showVariantBrowser: boolean;
  showEvidenceInspector: boolean;
  showContextHelp: boolean;
  showDeviceRack: boolean;
  showTrackMonitor: boolean;
  reduceMotion: boolean;
  workerThreads: "auto" | number;
  interactiveAlleleLimit: number;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  uiScale: 1.1,
  colorTheme: "system",
  showVariantBrowser: true,
  showEvidenceInspector: true,
  showContextHelp: true,
  showDeviceRack: true,
  showTrackMonitor: true,
  reduceMotion: false,
  workerThreads: "auto",
  interactiveAlleleLimit: 1_000
};

export const USER_SETTINGS_STORAGE_KEY = "dgw.user-settings.v2";

export function parseUserSettings(value: string | null): UserSettings {
  if (!value) return { ...DEFAULT_USER_SETTINGS };
  try {
    const candidate = JSON.parse(value) as Partial<UserSettings> & { showMasterMeter?: unknown };
    return {
      uiScale: UI_SCALES.includes(candidate.uiScale as UiScale)
        ? candidate.uiScale as UiScale
        : DEFAULT_USER_SETTINGS.uiScale,
      colorTheme: candidate.colorTheme === "dark" || candidate.colorTheme === "light" || candidate.colorTheme === "system"
        ? candidate.colorTheme
        : DEFAULT_USER_SETTINGS.colorTheme,
      showVariantBrowser: typeof candidate.showVariantBrowser === "boolean"
        ? candidate.showVariantBrowser
        : DEFAULT_USER_SETTINGS.showVariantBrowser,
      showEvidenceInspector: typeof candidate.showEvidenceInspector === "boolean"
        ? candidate.showEvidenceInspector
        : DEFAULT_USER_SETTINGS.showEvidenceInspector,
      showContextHelp: typeof candidate.showContextHelp === "boolean"
        ? candidate.showContextHelp
        : DEFAULT_USER_SETTINGS.showContextHelp,
      showDeviceRack: typeof candidate.showDeviceRack === "boolean"
        ? candidate.showDeviceRack
        : DEFAULT_USER_SETTINGS.showDeviceRack,
      showTrackMonitor: typeof candidate.showTrackMonitor === "boolean"
        ? candidate.showTrackMonitor
        : typeof candidate.showMasterMeter === "boolean"
          ? candidate.showMasterMeter
          : DEFAULT_USER_SETTINGS.showTrackMonitor,
      reduceMotion: typeof candidate.reduceMotion === "boolean"
        ? candidate.reduceMotion
        : DEFAULT_USER_SETTINGS.reduceMotion,
      workerThreads: candidate.workerThreads === "auto"
        ? "auto"
        : typeof candidate.workerThreads === "number" && Number.isFinite(candidate.workerThreads)
          ? Math.max(1, Math.min(256, Math.trunc(candidate.workerThreads)))
          : DEFAULT_USER_SETTINGS.workerThreads,
      interactiveAlleleLimit: typeof candidate.interactiveAlleleLimit === "number" && Number.isFinite(candidate.interactiveAlleleLimit)
        ? Math.max(100, Math.min(1_000, Math.trunc(candidate.interactiveAlleleLimit)))
        : DEFAULT_USER_SETTINGS.interactiveAlleleLimit
    };
  } catch {
    return { ...DEFAULT_USER_SETTINGS };
  }
}
