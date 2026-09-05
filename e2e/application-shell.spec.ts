import { expect, test } from "@playwright/test";
import { installTauriShellMock } from "./tauri-shell-mock";

test.beforeEach(async ({ page }) => {
  await installTauriShellMock(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Edit and compare genome variants." })).toBeVisible();
});

test("keeps the project purpose and primary starting actions visible", async ({ page }) => {
  await expect(page.getByText("Load one sample from a VCF and test allele changes on independent tracks without changing the source.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open .dgw" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open GRCh37 example project" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open GRCh38 example project" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open HG00103 exome example" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open GRCh37 example project" })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Open genome workspace" })).toBeVisible();
});

test("icon controls retain accessible names and tooltips", async ({ page }) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  const duplicate = page.getByRole("button", { name: "Duplicate track", exact: true }).first();
  await expect(duplicate).toBeVisible();
  await expect(duplicate).toHaveAttribute("title", "Duplicate track");
  await expect(duplicate.locator("svg")).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("button", { name: "Zoom in", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reset selected", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove selected device", exact: true })).toBeVisible();
});

test("compact track toolbar leaves room for tracks", async ({ page }, testInfo) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  const heading = page.locator(".dgw-track-deck-header");
  await expect(heading.locator(".dgw-edit-target")).not.toBeEmpty();
  await expect(heading.locator("details")).not.toHaveAttribute("open", "");
  const bounds = await heading.boundingBox();
  expect(bounds?.height).toBeLessThan(170);
  const tracks = await page.locator(".dgw-track-list").boundingBox();
  expect(tracks?.height).toBeGreaterThan(70);
  await page.screenshot({ path: testInfo.outputPath("compact-workspace.png") });
});

test("monitor separates impact, coverage and supporting detail", async ({ page }) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  const meter = page.getByRole("region", { name: "Track Meter", exact: true });
  await expect(meter.getByLabel("Mutation evaluation coverage")).toContainText("1 / 1 mutations evaluated");
  await expect(meter.getByText("Mean Δ per mutation", { exact: true })).toBeVisible();
  await expect(meter.getByText("Lower than source", { exact: true })).toBeVisible();
  await meter.getByText("How to read this", { exact: true }).click();
  await expect(meter.getByText(/Mean Δ is the total source-relative/)).toBeVisible();
});

test("opens the template chooser from the File menu", async ({ page }) => {
  await page.getByText("File", { exact: true }).click();
  await page.getByRole("button", { name: /New from Template/ }).click();

  const dialog = page.getByRole("dialog", { name: "Choose a template" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: /DGW Starter/ })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Empty/ })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("applies and persists appearance preferences", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "User settings" });
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Light" }).click();
  await dialog.getByRole("button", { name: "150%" }).click();
  await expect(dialog.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("button", { name: "150%" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveAttribute("data-dgw-theme", "light");

  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-dgw-theme", "light");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("dialog", { name: "User settings" }).getByRole("button", { name: "150%" })).toHaveAttribute("aria-pressed", "true");
});

test("shows verified downloaded-package installation in resource settings", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "User settings" });
  await dialog.getByRole("button", { name: "Resources", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Genome resources" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Install downloaded packages" })).toBeVisible();
  await expect(dialog).toContainText("one assembly data archive and the tool archive for this computer");
  await expect(dialog).toContainText("Automatic download is not available in this build");
  await expect(dialog.getByRole("button", { name: "Use existing resources" })).not.toBeVisible();
  await dialog.getByText("Advanced", { exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Use existing resources" })).toBeVisible();
});

test("presents authorship and software identity in About DGW", async ({ page }) => {
  await page.getByText("Help", { exact: true }).click();
  await page.getByRole("button", { name: "About DGW" }).click();

  const dialog = page.getByRole("dialog", { name: "DGW 0.1.0" });
  await expect(dialog).toContainText("Manuel Rueda");
  await expect(dialog).toContainText("Apache-2.0");
  await expect(dialog).toContainText("Open a project to inspect its resource profile");
});

test("opens the synthetic example into the complete genome workspace", async ({ page }) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();

  await expect(page.getByLabel("Genome tracks and device rack")).toBeVisible();
  await expect(page.locator(".app-header strong")).toHaveText("DGW Allele Editing Demo");
  await expect(page.getByLabel("Track Monitor")).toBeVisible();
  await expect(page.getByLabel("Mutation Generator")).toBeVisible();
  await expect(page.locator(".application-menu-context")).toContainText("unsaved example");

  await page.getByText("File", { exact: true }).click();
  await expect(page.getByRole("button", { name: /Save Example as Project/ })).toBeVisible();
  await expect(page.getByText("Changes are retained temporarily")).toBeVisible();
});

test("opens the public GRCh37 exome example directly from the landing page", async ({ page }) => {
  await page.getByRole("button", { name: "Open HG00103 exome example" }).click();

  await expect(page.getByLabel("Genome tracks and device rack")).toBeVisible();
  await expect(page.locator(".app-header strong")).toHaveText("HG00103 exome — GRCh37");
  await expect(page.getByLabel("Track Monitor").getByText("HG00103 WES · working track", { exact: true })).toBeVisible();
});

test("selects the visible alleles and clears the selection", async ({ page }) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();

  const selection = page.getByLabel("Allele selection controls");
  await selection.getByRole("button", { name: "Select visible" }).click();
  await expect(selection).toContainText("6alleles selected");

  await selection.getByRole("button", { name: "Clear" }).click();
  await expect(selection).toContainText("0alleles selected");
});

test("undoes and redoes an allele selection", async ({ page }) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();

  const selection = page.getByLabel("Allele selection controls");
  await selection.getByRole("button", { name: "Select visible" }).click();
  await expect(selection).toContainText("6alleles selected");

  await page.keyboard.press("Control+z");
  await expect(selection).toContainText("0alleles selected");

  await page.keyboard.press("Control+Shift+z");
  await expect(selection).toContainText("6alleles selected");
});

test("opens a mutation block in the Allele Roll", async ({ page }) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();

  await page.locator(".dgw-edit-block").first().click();
  await expect(page.getByLabel("Selected allele editor")).toBeVisible();
  await expect(page.getByLabel("FASTA-aligned Allele Roll")).toBeVisible();
  await expect(page.getByRole("button", { name: "Change ALT", exact: true })).toBeVisible();
});

test("resets changed Mutation Generator controls", async ({ page }) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();

  const mutationGenerator = page.getByLabel("Mutation Generator");
  await mutationGenerator.getByRole("button", { name: /Mutation Generator/ }).first().click();
  const seed = mutationGenerator.getByLabel("Seed");
  await seed.fill("9876");
  await expect(seed).toHaveValue("9876");

  await page.getByRole("button", { name: "Reset selected" }).click();
  await expect(seed).toHaveValue("42");
  await expect(page.getByText("Mutation Generator controls reset. Existing track edits were not changed.")).toBeVisible();
});
