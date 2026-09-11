import { expect, test } from "@playwright/test";
import { installTauriShellMock } from "./tauri-shell-mock";

test.beforeEach(async ({ page }) => {
  await installTauriShellMock(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Edit and compare genome variants." })).toBeVisible();
});

test("keeps the project purpose and primary starting actions visible", async ({ page }, testInfo) => {
  await expect(page.getByText("Load one sample from a VCF and test allele changes on independent tracks without changing the source.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open .dgw" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open GRCh37 example project" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open GRCh38 example project" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open HG00103 exome example" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open GRCh37 example project" })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Open genome workspace" })).toBeVisible();
  const helperSizes = await page.locator(".setup-panel small").evaluateAll(elements => elements.map(el => getComputedStyle(el).fontSize));
  expect(new Set(helperSizes).size).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("landing-typography.png") });
});

test("icon controls retain accessible names and tooltips", async ({ page }) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  const duplicate = page.getByRole("button", { name: "Duplicate track", exact: true }).first();
  await expect(duplicate).toBeVisible();
  await expect(duplicate).toHaveAttribute("title", "Duplicate track");
  await expect(duplicate.locator("svg")).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("button", { name: "Zoom in", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reset Mutation Generator to defaults", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mutation Generator options", exact: true })).toBeVisible();
});

test("graphical user setup recovers from an unwritable destination", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 740, height: 640 });
  await page.goto("/?setup");
  await expect(page.getByRole("heading", { name: "Install DGW for your user" })).toBeVisible();
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(740);
  await expect(page.getByRole("button", { name: "Choose installation folder" })).toBeInViewport();
  const folder = page.getByLabel("Installation folder", { exact: true });
  await expect(folder).toHaveValue("/synthetic/user/apps");
  await folder.fill("/unwritable");
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("choose one you own");
  await folder.fill("/synthetic/my apps");
  await page.screenshot({ path: testInfo.outputPath("user-setup.png") });
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await expect(page.getByRole("heading", { name: "DGW is installed" })).toBeVisible();
  await expect(page.getByText("/synthetic/my apps/DGW-0.1.0/DGW.AppImage", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to genome setup" })).toBeEnabled();
});

test("setup supports explicit replacement and remains open after a failed launch", async ({ page }) => {
  await page.goto("/?setup");
  await page.getByLabel("Installation folder", { exact: true }).fill("/existing");
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Replace existing installation");
  await page.getByRole("checkbox", { name: "Replace existing installation and shortcut" }).check();
  await page.getByRole("button", { name: "Install / Replace" }).click();
  await page.evaluate(() => localStorage.setItem("test-launch-failure", "1"));
  const launch = page.getByRole("button", { name: "Continue to genome setup" });
  await launch.click();
  await expect(page.getByRole("alert")).toContainText("setup-launch.log");
  await expect(launch).toBeEnabled();
  await page.evaluate(() => localStorage.removeItem("test-launch-failure"));
  await launch.click();
  await expect(page.getByRole("status")).toContainText("Close this installer once the DGW window appears");
  await expect(page.getByRole("heading", { name: "DGW is installed" })).toBeVisible();
});

test("fresh installation explains required resources and routes examples back to setup", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("test-no-resources", "1"));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Set up genome resources", exact: true })).toBeVisible();
  await page.getByText("Other installation options", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Install downloaded packages" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use existing resources" })).toBeVisible();
  await page.getByRole("button", { name: "Set up later" }).click();
  await expect(page.getByRole("button", { name: "Open GRCh37 example project" })).toContainText("Requires GRCh37 resources");
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await expect(page.getByRole("heading", { name: "Set up genome resources", exact: true })).toBeVisible();
  await page.evaluate(() => {
    localStorage.removeItem("test-no-resources");
    window.dispatchEvent(new Event("dgw-resources-changed"));
  });
  await page.getByRole("button", { name: "Continue to examples" }).click();
  await expect(page.getByRole("button", { name: "Open GRCh37 example project" })).toContainText("Synthetic");
});

test("compact track toolbar leaves room for tracks", async ({ page }, testInfo) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  const heading = page.locator(".dgw-track-deck-header");
  await expect(heading.locator(".dgw-edit-target")).not.toBeEmpty();
  await expect(heading.locator("details")).not.toHaveAttribute("open", "");
  await expect(heading.getByRole("button", { name: "Select all variants · all chromosomes", exact: true })).toBeVisible();
  const bounds = await heading.boundingBox();
  expect(bounds?.height).toBeLessThan(170);
  const tracks = await page.locator(".dgw-track-list").boundingBox();
  expect(tracks?.height).toBeGreaterThan(70);
  await page.screenshot({ path: testInfo.outputPath("compact-workspace.png") });
});

test("scrolls the device rack with a persistent draggable scrollbar and Shift-wheel", async ({ page }) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  const chain = page.locator(".dgw-device-chain");
  await expect.poll(() => chain.evaluate(el => el.scrollWidth - el.clientWidth)).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Scroll devices right", exact: true })).toHaveCount(0);
  const bar = page.getByRole("scrollbar", { name: "Scroll device rack" });
  await expect(bar).toBeVisible();
  const geometry = (await bar.boundingBox())!;
  expect(geometry.y + geometry.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  const thumb = (await bar.locator("span").boundingBox())!;
  const x = thumb.x + thumb.width / 2;
  const y = thumb.y + thumb.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 100, y, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => chain.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
  await chain.evaluate(el => { el.scrollLeft = 0; });
  await chain.locator("section").first().dispatchEvent("wheel", { deltaY: 200, shiftKey: true, bubbles: true, cancelable: true });
  await expect.poll(() => chain.evaluate(el => el.scrollLeft)).toBe(200);
  await chain.locator("section").first().dispatchEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true });
  await expect.poll(() => chain.evaluate(el => el.scrollLeft)).toBe(200);
  await chain.evaluate(el => { el.scrollLeft = 0; });
  const device = chain.locator("section").first();
  await expect.poll(() => device.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
  await device.hover();
  await page.mouse.wheel(0, 1000);
  await expect.poll(() => device.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
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
  const optionalNote = dialog.getByText("COSMIC is optional and distributed separately.", { exact: false });
  await expect(optionalNote).not.toBeVisible();
  await dialog.getByText("Optional resources", { exact: true }).click();
  await expect(optionalNote).toBeVisible();
  await dialog.getByText("Other installation options", { exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Install downloaded packages" })).toBeVisible();
  await expect(dialog).toContainText("one assembly data archive and the tool archive for this computer");
  await expect(dialog).toContainText("Downloads are not available for this genome on this computer");
  await expect(dialog.getByRole("button", { name: "Use existing resources" })).toBeVisible();
  await dialog.getByText("Advanced", { exact: true }).click();
  await expect(dialog).toContainText("Relative paths are resolved from its folder");
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
  const install = dialog.getByRole("button", { name: "Download and install", exact: true });
  await expect(install).toHaveCount(1);
  await expect(dialog).toContainText("1.1 GB");
  await install.click();
  await expect(dialog.getByRole("alert")).toContainText("Connection interrupted");
  await expect(install).toBeEnabled();
  await install.click();
  await expect(dialog).toContainText("GRCh37 is ready to use.");
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
  await expect(page.getByLabel("Mutation Generator", { exact: true })).toBeVisible();
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
  const seed = mutationGenerator.getByLabel("Seed");
  await seed.fill("9876");
  await expect(seed).toHaveValue("9876");

  await expect(page.getByRole("button", { name: "Reset selected", exact: true })).toHaveCount(0);
  await mutationGenerator.getByRole("button", { name: "Reset Mutation Generator to defaults", exact: true }).click();
  await expect(seed).toHaveValue("42");
  await expect(page.getByText("Mutation Generator controls reset. Existing track edits were not changed.")).toBeVisible();
  await mutationGenerator.getByRole("button", { name: "Mutation Generator options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Remove Mutation Generator from rack", exact: true }).click();
  await expect(page.locator(".dgw-device-chain").getByLabel("Mutation Generator", { exact: true })).toHaveCount(0);
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
  await comparison.getByLabel("Changed loci across track").check();
  await expect(comparison.getByRole("row")).toHaveCount(2);
  await expect(comparison).toContainText("1 changed across 205 imported loci");
  await expect(comparison).toContainText("No ALT at this locus");
  await expect(comparison.getByRole("button", { name: "Previous page", exact: true })).toBeDisabled();
  await comparison.getByLabel("Changed loci across track").uncheck();
  await expect(comparison.getByRole("row")).toHaveCount(201);
  await expect(comparison.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
});

test("opens the exact allele from whole-track comparison", async ({ page }) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await page.getByRole("button", { name: "Compare source and candidate", exact: true }).click();
  await page.getByRole("button", { name: "Whole track DNA", exact: true }).click();
  await page.getByRole("button", { name: "Focus locus 7:140453148", exact: true }).click();
  const editor = page.getByLabel("Selected allele editor");
  await expect(editor).toBeVisible();
  await expect(editor.locator(".locked-position")).toContainText("140,453,148");
});

test("runs a whole-track prediction job, filters saved results and marks stale input", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await page.getByRole("button", { name: "Compare source and candidate", exact: true }).click();
  await page.getByRole("button", { name: "Whole track predictions", exact: true }).click();
  const view = page.getByRole("region", { name: "Whole track prediction comparison" });
  await view.getByRole("button", { name: "Compare track predictions", exact: true }).click();
  await expect(view).toContainText("Prediction comparison ready");
  await expect(view.getByRole("row")).toHaveCount(5);
  await view.getByLabel("Prediction result filter").selectOption("different");
  await expect(view.getByRole("row")).toHaveCount(2);
  await view.getByRole("button", { name: "Evidence", exact: true }).click();
  await expect(view.getByRole("region", { name: "source prediction evidence" })).toContainText("TEST_TRANSCRIPT");
  await expect(view.getByRole("region", { name: "current prediction evidence" })).toContainText("TEST_TRANSCRIPT");
  await page.screenshot({ path: testInfo.outputPath("whole-track-predictions.png") });
  await page.evaluate(async () => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string) => Promise<unknown> } }).__TAURI_INTERNALS__;
    await internals.invoke("test_stale_prediction");
  });
  await view.getByLabel("Prediction result filter").selectOption("same");
  await expect(view.getByRole("alert")).toContainText("Results are outdated");
  await expect(view.getByRole("region", { name: "source prediction evidence" })).toHaveCount(0);
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
