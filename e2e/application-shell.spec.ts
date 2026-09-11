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

test("installs a matching resource release and recovers from an installation error", async ({ page }) => {
  await page.evaluate(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: {
      invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown>
    } }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    let attempts = 0;
    internals.invoke = async (name, args) => {
      if (name === "resource_inventory") return {
        directory: "/synthetic/resources", platform: "linux-aarch64", issues: [],
        releases: [{ id: "test-b37-linux-aarch64", name: "GRCh37 resources", version: "r1",
          assembly: "b37", platform: "linux-aarch64", files: [{ bytes: 1125563187 }, { bytes: 7754857 }] }],
        installed: attempts > 1 ? [{ descriptor: "/synthetic/resources/dgw-bundle.json",
          bundle: { id: "test-b37-linux-aarch64", assembly: "b37" }, ready: true, message: "Ready" }] : []
      };
      if (name === "install_resource_release") {
        if (args?.releaseId !== "test-b37-linux-aarch64") throw new Error("Wrong release selected");
        attempts += 1;
        if (attempts === 1) throw new Error("Connection interrupted. Retry installation.");
        return null;
      }
      return original(name, args);
    };
  });
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "User settings" });
  await dialog.getByRole("button", { name: "Resources", exact: true }).click();
  const install = dialog.getByRole("button", { name: "Install resources", exact: true });
  await expect(install).toHaveCount(1);
  await expect(dialog).toContainText("1.1 GB");
  await install.click();
  await expect(dialog.getByRole("alert")).toContainText("Connection interrupted");
  await expect(install).toBeEnabled();
  await install.click();
  await expect(dialog).toContainText("Ready · test-b37-linux-aarch64");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
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

test("keeps the edited locus through replacement, undo, redo and reference restoration", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await page.evaluate(async () => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string) => Promise<unknown> } }).__TAURI_INTERNALS__;
    await internals.invoke("test_enable_mutable_edits");
  });
  const mark = page.getByRole("button", { name: "Edit candidate allele 7:140453112 G to A", exact: true }).first();
  await mark.click();
  const editor = page.getByLabel("Selected allele editor");
  const position = editor.locator(".locked-position");
  await expect(position).toContainText("140,453,112 G→A");
  const comparison = editor.getByRole("region", { name: "Allele comparison" });
  await expect(comparison.getByText("Saved on track").locator("..").locator("code")).toHaveText("A");
  await editor.getByLabel("ALT", { exact: true }).fill("C");
  await expect(comparison.getByText("Proposal · not saved").locator("..").locator("code")).toHaveText("C");
  await comparison.screenshot({ path: testInfo.outputPath("allele-comparison.png") });
  await expect(comparison.getByText("Saved on track").locator("..").locator("code")).toHaveText("A");
  await page.getByRole("button", { name: "Reset view", exact: true }).click();
  await expect(editor.getByLabel("ALT", { exact: true })).toHaveValue("C");
  await editor.getByRole("button", { name: "Add mutation block to track", exact: true }).click();
  await expect(position).toContainText("140,453,112 G→C");
  await expect(comparison.getByText("Saved on track").locator("..").locator("code")).toHaveText("C");
  await expect(page.getByRole("button", { name: "Edit candidate allele 7:140453112 G to C", exact: true })).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect(position).toContainText("140,453,112 G→A");
  await page.keyboard.press("Control+Shift+z");
  await expect(position).toContainText("140,453,112 G→C");
  await editor.getByRole("button", { name: "Use reference", exact: true }).click();
  await editor.getByRole("button", { name: "Add mutation block to track", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit candidate allele 7:140453112 G to C", exact: true })).toHaveCount(0);
  await expect(comparison.getByText("Saved on track").locator("..").locator("code")).toHaveText("G");
  await expect(editor.getByRole("button", { name: "Add mutation block to track", exact: true })).toBeDisabled();
  await expect(position).toContainText("140,453,112");
  await page.getByRole("button", { name: "Bypass C→G edit", exact: true }).click();
  await expect(position).toContainText("140,453,112 G→C");
  await page.getByRole("button", { name: "Enable C→G edit", exact: true }).click();
  await expect(position).toContainText("140,453,112");
  await expect(page.getByRole("button", { name: "Inspect source allele 7:140453112 G to A", exact: true })).toHaveCount(1);
  await page.getByText("File", { exact: true }).click();
  await page.getByRole("button", { name: "Close project", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Edit and compare genome variants." })).toBeVisible();
  await page.getByRole("button", { name: "Open .dgw", exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(position).toContainText("140,453,112");
  await expect(comparison.getByText("Saved on track").locator("..").locator("code")).toHaveText("G");
  await expect(editor.getByRole("button", { name: "Add mutation block to track", exact: true })).toBeDisabled();
  // History and edit selection survive unmounting/reopening the workstation.
  await page.keyboard.press("Control+z");
  await expect(position).toContainText("140,453,112 G→C");
  await expect(comparison.getByText("Saved on track").locator("..").locator("code")).toHaveText("C");
});

test("keeps the project open when saving its session fails", async ({ page }) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await expect.poll(() => page.evaluate(async () => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
    return Boolean(await internals.invoke("load_workstation_session", { projectPath: "/synthetic/DGW-Allele-Editing-Demo.dgw" }));
  })).toBe(true);
  await page.evaluate(async () => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string) => Promise<unknown> } }).__TAURI_INTERNALS__;
    await internals.invoke("test_fail_next_session_save");
  });
  await page.getByText("File", { exact: true }).click();
  await page.getByRole("button", { name: "Close project", exact: true }).click();
  await expect(page.getByText(/Close failed because the project could not be saved/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Edit and compare genome variants." })).toHaveCount(0);
  await page.getByText("File", { exact: true }).click();
  await page.getByRole("button", { name: "Close project", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Edit and compare genome variants." })).toBeVisible();
});

test("compares source and candidate predictions and navigates back to editing", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await page.evaluate(async () => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string) => Promise<unknown> } }).__TAURI_INTERNALS__;
    await internals.invoke("test_enable_mutable_edits");
  });
  await page.getByRole("button", { name: "Edit candidate allele 7:140453112 G to A", exact: true }).first().click();
  const editor = page.getByLabel("Selected allele editor");
  await editor.getByLabel("ALT", { exact: true }).fill("C");
  await editor.getByRole("button", { name: "Add mutation block to track", exact: true }).click();
  await expect(editor.locator(".locked-position")).toContainText("G→C");
  await page.getByRole("button", { name: "Compare source and candidate", exact: true }).click();
  const comparison = page.getByRole("region", { name: "Compare source and candidate", exact: true });
  await expect(comparison.getByText(/loaded region only, not the whole track/)).toBeVisible();
  const row = comparison.getByRole("row").filter({ hasText: "7:140,453,112" });
  await expect(row.getByRole("cell").nth(1)).toHaveText("A");
  await expect(row.getByRole("cell").nth(2)).toHaveText("C");
  await comparison.getByRole("button", { name: "Compare predictions", exact: true }).click();
  await expect(row).toContainText("Same prediction");
  await comparison.getByLabel("Comparison filter", { exact: true }).selectOption("missing");
  await expect(row).toHaveCount(0);
  await comparison.getByLabel("Comparison filter", { exact: true }).selectOption("same");
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "Compare allele 7:140453112", exact: true }).click();
  await expect(comparison.getByRole("region", { name: "Source and current evidence" })).toContainText("stop_gained");
  await page.screenshot({ path: testInfo.outputPath("comparison-workspace.png") });
  await row.getByRole("button", { name: "Open allele 7:140453112", exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(editor.locator(".locked-position")).toContainText("G→C");
});

test("pages whole-track DNA comparison without rendering all loci", async ({ page }, testInfo) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await page.evaluate(async () => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string) => Promise<unknown> } }).__TAURI_INTERNALS__;
    await internals.invoke("test_large_comparison");
  });
  await page.getByRole("button", { name: "Compare source and candidate", exact: true }).click();
  await page.getByRole("button", { name: "Whole track DNA", exact: true }).click();
  const comparison = page.getByRole("region", { name: "Whole track DNA comparison" });
  await expect(comparison.getByText(/1–200 of 205 loci/)).toBeVisible();
  await expect(comparison.getByRole("row")).toHaveCount(201);
  await page.evaluate(async () => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string) => Promise<unknown> } }).__TAURI_INTERNALS__;
    await internals.invoke("test_fail_next_comparison");
  });
  await comparison.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(comparison.getByRole("alert")).toContainText("Synthetic comparison read failure");
  await comparison.getByRole("button", { name: "Retry comparison", exact: true }).click();
  await expect(comparison.getByText(/201–205 of 205 loci/)).toBeVisible();
  await expect(comparison.getByRole("row")).toHaveCount(6);
  await page.screenshot({ path: testInfo.outputPath("whole-track-comparison.png") });
  await comparison.getByLabel("Changed loci on this page").check();
  await expect(comparison.getByRole("row")).toHaveCount(2);
  await expect(comparison).toContainText("No ALT at this locus");
  await comparison.getByRole("button", { name: "Previous page", exact: true }).click();
  await expect(comparison.getByText("No matching loci on this page.")).toBeVisible();
  await expect(comparison.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
});

test("makes every transcript evidence record accessible without changing the allele", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await page.getByText("View", { exact: true }).click();
  // Evidence is initially hidden by the default settings in some saved profiles.
  const evidenceMenu = page.getByRole("button", { name: /Evidence panel$/ });
  if (!(await evidenceMenu.getAttribute("class"))?.includes("is-selected")) await evidenceMenu.click();
  await page.keyboard.press("Escape");
  const card = page.getByRole("article", { name: "Variant Consequences evidence" });
  const selector = card.getByLabel("Variant Consequences record");
  await expect(selector).toHaveCount(1);
  await selector.selectOption("1");
  await expect(card.locator("dl")).toContainText("ENST00000479537");
  await expect(card.locator("dl")).toContainText("synonymous");
  await card.getByText("Raw matched record", { exact: true }).click();
  await expect(card).toContainText("Synthetic second transcript record");
  await selector.selectOption("0");
  await expect(card.locator("dl")).toContainText("ENST00000288602");
});
