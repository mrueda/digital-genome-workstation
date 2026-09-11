import { expect, test } from "@playwright/test";
import { installTauriShellMock } from "./tauri-shell-mock";

const imageDirectory = "docs-site/static/img";

test.beforeEach(async ({ page }) => {
  await installTauriShellMock(page);
  await page.addInitScript(() => {
    localStorage.setItem("dgw.user-settings.v2", JSON.stringify({
      uiScale: 1,
      colorTheme: "dark",
      showVariantBrowser: true,
      showEvidenceInspector: true,
      showContextHelp: false,
      showDeviceRack: true,
      showTrackMonitor: true,
      reduceMotion: true,
      workerThreads: "auto",
      interactiveAlleleLimit: 1000
    }));
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Edit and compare genome variants." })).toBeVisible();
});

test("capture documentation interface set", async ({ page }) => {
  await page.screenshot({
    path: `${imageDirectory}/dgw-project-setup.png`,
    animations: "disabled"
  });

  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await expect(page.getByLabel("Genome tracks and device rack")).toBeVisible();
  await expect(page.getByRole("region", { name: "Mutation Generator", exact: true })).toBeVisible();
  await expect(page.locator(".app-header strong")).toHaveText("DGW Allele Editing Demo");
  await expect(page.getByText(/Background profile completed for 1 mutation/)).toBeVisible();
  await page.screenshot({
    path: `${imageDirectory}/dgw-workspace.png`,
    animations: "disabled"
  });
  await page.locator(".evidence-inspector-content").screenshot({
    path: `${imageDirectory}/dgw-evidence-inspector.png`,
    animations: "disabled"
  });

  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.locator(".dgw-edit-block").first().click();
  await expect(page.getByLabel("Selected allele editor")).toBeVisible();
  await expect(page.getByLabel("FASTA-aligned Allele Roll")).toBeVisible();
  await page.screenshot({
    path: `${imageDirectory}/dgw-allele-roll.png`,
    animations: "disabled"
  });
});
