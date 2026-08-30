import { describe, expect, it } from "vitest";
import { DEFAULT_USER_SETTINGS, parseUserSettings } from "./userSettings";

describe("user settings", () => {
  it("uses safe defaults for missing or malformed storage", () => {
    expect(parseUserSettings(null)).toEqual(DEFAULT_USER_SETTINGS);
    expect(parseUserSettings("not json")).toEqual(DEFAULT_USER_SETTINGS);
  });

  it("keeps valid preferences and repairs invalid fields", () => {
    expect(parseUserSettings(JSON.stringify({
      uiScale: 1.5,
      showVariantBrowser: false,
      showEvidenceInspector: true,
      showDeviceRack: false,
      showTrackMonitor: false,
      reduceMotion: true,
      workerThreads: 8,
      interactiveAlleleLimit: 800
    }))).toEqual({
      uiScale: 1.5,
      showVariantBrowser: false,
      showEvidenceInspector: true,
      showDeviceRack: false,
      showTrackMonitor: false,
      reduceMotion: true,
      workerThreads: 8,
      interactiveAlleleLimit: 800
    });

    expect(parseUserSettings(JSON.stringify({ uiScale: 7, defaultWorkspace: "allele" }))).toMatchObject({ uiScale: 1.1 });
  });

  it("repairs invalid compute limits", () => {
    expect(parseUserSettings(JSON.stringify({ workerThreads: 999, interactiveAlleleLimit: 2 }))).toMatchObject({
      workerThreads: 256,
      interactiveAlleleLimit: 100
    });
  });

  it("migrates the former Mixer visibility preference", () => {
    expect(parseUserSettings(JSON.stringify({ showMasterMeter: false })).showTrackMonitor).toBe(false);
  });
});
