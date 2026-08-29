export const UI_SCALES = [0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5] as const;

export type UiScale = typeof UI_SCALES[number];

export interface UserSettings {
  uiScale: UiScale;
  showVariantBrowser: boolean;
  showEvidenceInspector: boolean;
  showDeviceRack: boolean;
  showTrackMonitor: boolean;
  reduceMotion: boolean;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  uiScale: 1.1,
  showVariantBrowser: true,
  showEvidenceInspector: true,
  showDeviceRack: true,
  showTrackMonitor: true,
  reduceMotion: false
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
      showVariantBrowser: typeof candidate.showVariantBrowser === "boolean"
        ? candidate.showVariantBrowser
        : DEFAULT_USER_SETTINGS.showVariantBrowser,
      showEvidenceInspector: typeof candidate.showEvidenceInspector === "boolean"
        ? candidate.showEvidenceInspector
        : DEFAULT_USER_SETTINGS.showEvidenceInspector,
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
        : DEFAULT_USER_SETTINGS.reduceMotion
    };
  } catch {
    return { ...DEFAULT_USER_SETTINGS };
  }
}
