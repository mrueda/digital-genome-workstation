import { expect, test } from "@playwright/test";
import { installTauriShellMock } from "./tauri-shell-mock";

test.beforeEach(async ({ page }) => {
  await installTauriShellMock(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Edit and compare genome variants." })).toBeVisible();
});

test("gene filter limits the navigator and clearing restores all chromosomes", async ({ page }) => {
  await page.evaluate(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    internals.invoke = async (name, args = {}) => {
      if (name === "search_genes") return [{ geneId: "ENSG00000157764", symbol: "BRAF", contig: "7", start: 140453100, end: 140453170, strand: "-", biotype: "protein_coding", sourceVariantCount: 5 }];
      if (name === "variant_navigation_bins" && args.start === 140453100) {
        localStorage.setItem("test-gene-navigation", JSON.stringify(args));
        return [{ contig: "7", start: 140453100, end: 140453170, total: 5 }];
      }
      return original(name, args);
    };
  });
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  const browser = page.locator(".variant-browser");
  await expect(browser.locator(".variant-contig-node")).toHaveCount(2);
  await page.getByRole("button", { name: "Select all variants · all chromosomes", exact: true }).click();
  await page.getByLabel("Go to gene", { exact: true }).fill("BRAF");
  await page.locator(".gene-search-results").getByRole("button", { name: /BRAF/ }).click();
  await expect(browser.locator(".variant-contig-node")).toHaveCount(1);
  await expect(browser.locator(".section-title")).toContainText("BRAF · 5 alleles");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("test-gene-navigation") ?? "null")?.end)).toBe(140453170);
  await expect(browser.locator(".variant-item")).not.toHaveCount(0);
  const positions = await browser.locator(".variant-item > span").allTextContents();
  expect(positions.every(value => { const position = Number(value.replaceAll(",", "")); return position >= 140453100 && position <= 140453170; })).toBe(true);
  await browser.getByRole("button", { name: "Clear gene filter — show all chromosomes" }).click();
  await expect(browser.locator(".variant-contig-node")).toHaveCount(2);
  await expect(browser.locator(".section-title")).toContainText("10 selected");
});

test("landing processing labels do not overlap descriptions at larger text sizes", async ({ page }, testInfo) => {
  await page.evaluate(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    internals.invoke = async (name, args = {}) => {
      if (name === "create_project") {
        const channel = args.onProgress as { onmessage: (progress: unknown) => void };
        channel.onmessage({ operation: "import", step: 2, totalSteps: 5, message: "Normalizing the selected sample and validating reference alleles against the configured reference genome" });
        return new Promise(() => {});
      }
      return original(name, args);
    };
  });
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  const panel = page.getByRole("region", { name: "Processing progress" });
  await expect(panel).toBeVisible();
  for (const size of [12, 20]) {
    await page.locator(".setup-panel").evaluate((node, size) => (node as HTMLElement).style.setProperty("--setup-detail", `${size}px`), size);
    const label = (await panel.locator("li.current > span").boundingBox())!;
    const message = (await panel.locator("li.current > b").boundingBox())!;
    const counter = (await panel.locator("li.current > small").boundingBox())!;
    expect(label.x + label.width).toBeLessThan(message.x);
    expect(message.x + message.width).toBeLessThan(counter.x);
  }
  await page.screenshot({ path: testInfo.outputPath("landing-processing.png") });
});

test("menus support keyboard navigation, nested scale and platform shortcut labels", async ({ page }) => {
  const nav = page.getByRole("navigation", { name: "Application menu" });
  const file = nav.locator("summary").filter({ hasText: /^File$/ });
  await file.focus();
  await page.keyboard.press("ArrowDown");
  await expect(nav.getByRole("button", { name: /New Project/ })).toBeFocused();
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
  await expect(nav.getByRole("button", { name: /Open DGW Project/ }).locator("kbd")).toHaveText(mac ? "⌘ O" : "Ctrl O");
  await page.keyboard.press("ArrowRight");
  await expect(nav.locator("summary").filter({ hasText: /^Edit$/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(nav.locator("details[open]")).toHaveCount(0);
  await nav.getByText("View", { exact: true }).click();
  await expect(nav.getByRole("button", { name: "100%", exact: true })).not.toBeVisible();
  await nav.locator("summary").filter({ hasText: "Interface scale" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(nav.getByRole("button", { name: "90%", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(nav.locator("summary").filter({ hasText: "Interface scale" })).toBeFocused();
});

test("Help opens documentation and an accessible shortcuts dialog", async ({ page }) => {
  await page.getByText("Help", { exact: true }).click();
  await page.getByRole("button", { name: "DGW documentation" }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("test-docs-opened"))).toBe("1");
  await page.getByText("Help", { exact: true }).click();
  await page.getByRole("button", { name: "Keyboard shortcuts…" }).click();
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("all chromosomes");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("File opens DGW projects from the workspace and rejects unrelated folders", async ({ page }) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await page.evaluate(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    let attempts = 0;
    internals.invoke = async (name, args) => {
      if (name === "plugin:dialog|open") {
        localStorage.setItem("project-picker-options", JSON.stringify(args));
        return ++attempts === 1 ? "/synthetic/unrelated-folder" : "/synthetic/DGW-Allele-Editing-Demo.dgw";
      }
      if (name === "plugin:dialog|message") {
        localStorage.setItem("project-picker-warning", JSON.stringify(args));
        return null;
      }
      if (name === "open_project") localStorage.setItem("project-picker-opened", JSON.stringify(args));
      return original(name, args);
    };
  });
  const nav = page.getByRole("navigation", { name: "Application menu" });
  await nav.getByText("File", { exact: true }).click();
  await nav.getByRole("button", { name: /Open DGW Project/ }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("project-picker-warning"))).toContain("Select a .dgw project folder");
  expect(await page.evaluate(() => localStorage.getItem("project-picker-opened"))).toBeNull();
  await expect(page.getByLabel("Genome tracks and device rack")).toBeVisible();
  await nav.getByText("File", { exact: true }).click();
  await nav.getByRole("button", { name: /Open DGW Project/ }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("project-picker-opened"))).toContain("DGW-Allele-Editing-Demo.dgw");
  await expect(page.locator(".application-menu-context")).not.toHaveText("Unsaved example");
});

test("chromosome navigator gives its width to the chromosome with controls on the right", async ({ page }) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  for (const width of [1280, 1600]) {
    await page.setViewportSize({ width, height: 1000 });
    const navigator = page.locator(".genome-overview-navigator");
    const track = await navigator.locator(".genome-overview-track").boundingBox();
    const controls = await navigator.locator(".genome-overview-controls").boundingBox();
    const bounds = await navigator.boundingBox();
    expect(track).not.toBeNull(); expect(controls).not.toBeNull(); expect(bounds).not.toBeNull();
    expect(track!.width).toBeGreaterThan(controls!.width);
    expect(controls!.x).toBeGreaterThanOrEqual(track!.x + track!.width);
    expect(controls!.x + controls!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
    await expect(navigator.getByRole("button", { name: "Full chr", exact: true })).toBeVisible();
    await expect(navigator.getByRole("button", { name: "Reset view", exact: true })).toBeVisible();
  }
});

test("update check handles private releases, retries and opens the release page", async ({ page }) => {
  await page.getByText("Help", { exact: true }).click();
  await page.getByRole("button", { name: "Check for updates", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Check for updates" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("status")).toContainText("repository may be private");
  await page.evaluate(() => localStorage.setItem("test-update-state", "error"));
  await dialog.getByRole("button", { name: "Check again" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Could not reach GitHub");
  await page.evaluate(() => localStorage.setItem("test-update-state", "available"));
  await dialog.getByRole("button", { name: "Check again" }).click();
  await expect(dialog.getByRole("status")).toContainText("0.2.0 is available");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Open GitHub releases" }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("test-releases-opened"))).toBe("1");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("keeps the project purpose and primary starting actions visible", async ({ page }, testInfo) => {
  await expect(page.getByText("Load one sample from a VCF and test allele changes on independent tracks without changing the source.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open .dgw" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open GRCh37 example project" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open GRCh38 example project" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open HG00103 exome example" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open GRCh37 example project" })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Open genome workspace" })).toBeHidden();
  await expect(page.locator(".vcf-import-panel > summary")).toBeInViewport();
  const helperSizes = await page.locator(".setup-panel small").evaluateAll(elements => elements.map(el => getComputedStyle(el).fontSize));
  expect(new Set(helperSizes).size).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("landing-typography.png") });
  await page.locator(".vcf-import-panel > summary").click();
  await expect(page.getByRole("button", { name: "Open genome workspace" })).toBeVisible();
  await expect(page.getByLabel("Reference profile")).toBeVisible();
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

test("track toolbar keeps tracks visible and selectable", async ({ page }, testInfo) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  const heading = page.locator(".dgw-track-deck-header");
  await expect(heading.locator(".dgw-edit-target")).not.toBeEmpty();
  await expect(heading.locator("details")).not.toHaveAttribute("open", "");
  await expect(heading.getByRole("button", { name: "Select all variants · all chromosomes", exact: true })).toBeVisible();
  // Toolbar rows may wrap differently with platform fonts. Protect usable
  // track space and interaction, not an exact toolbar pixel height.
  const bounds = (await heading.boundingBox())!;
  const tracks = await page.locator(".dgw-track-list").boundingBox();
  expect(tracks?.height).toBeGreaterThan(70);
  expect(tracks!.y).toBeGreaterThanOrEqual(bounds.y + bounds.height - 1);
  expect(tracks!.y + tracks!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  const sourceSelect = page.locator(".dgw-track.is-source .dgw-track-select");
  await expect(sourceSelect).toBeInViewport();
  await sourceSelect.click();
  await expect(sourceSelect).toHaveAttribute("aria-pressed", "true");
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

test("application menus switch and dismiss like desktop menus", async ({ page }) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  const menu = page.getByRole("navigation", { name: "Application menu" });
  const fileMenu = menu.locator(":scope > details").filter({ has: page.getByText("File", { exact: true }) });
  const editMenu = menu.locator(":scope > details").filter({ has: page.getByText("Edit", { exact: true }) });

  await fileMenu.locator(":scope > summary").click();
  await expect(fileMenu).toHaveAttribute("open", "");
  await editMenu.locator(":scope > summary").hover();
  await expect(fileMenu).not.toHaveAttribute("open", "");
  await expect(editMenu).toHaveAttribute("open", "");

  await page.keyboard.press("Escape");
  await expect(editMenu).not.toHaveAttribute("open", "");
  await expect(editMenu.locator(":scope > summary")).toBeFocused();

  await editMenu.locator(":scope > summary").click();
  await menu.getByRole("button", { name: /Select all variants/ }).click();
  await expect(menu.locator(":scope > details[open]")).toHaveCount(0);
  await expect(page.locator(".dgw-selection-count")).toContainText("10alleles selected");

  await menu.getByText("View", { exact: true }).click();
  await menu.getByRole("button", { name: /Evidence panel/ }).click();
  await expect(menu.locator(":scope > details[open]")).toHaveCount(0);

  await menu.getByText("Track", { exact: true }).click();
  await expect(menu.getByRole("button", { name: /Duplicate track/ })).toBeVisible();
  await menu.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(menu.locator(":scope > details[open]")).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "User settings" })).toBeVisible();
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

test("settings separates preferences and keeps its actions visible", async ({ page }, testInfo) => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "User settings" });
  const sections = dialog.getByRole("navigation", { name: "Settings section" });
  await expect(dialog.getByRole("group", { name: "Interface scale", exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Worker threads")).toHaveCount(0);
  await sections.getByRole("button", { name: "Processing" }).click();
  await expect(dialog.getByLabel("Worker threads")).toBeVisible();
  await sections.getByRole("button", { name: "Workspace" }).click();
  await expect(dialog.getByLabel("Show Device Rack")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Done", exact: true })).toBeInViewport();
  await sections.getByRole("button", { name: "General" }).click();
  for (const theme of ["Dark", "Light"]) {
    await dialog.getByRole("button", { name: theme, exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath(`settings-${theme.toLowerCase()}.png`) });
  }
});

test("shows verified downloaded-package installation in resource settings", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "User settings" });
  await dialog.getByRole("button", { name: "Resources", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Genome resources" })).toBeVisible();
  const optionalNote = dialog.getByText("Add your separately obtained COSMIC VCF.", { exact: false });
  await expect(optionalNote).not.toBeVisible();
  await dialog.getByText("Optional resources · COSMIC", { exact: true }).click();
  await expect(optionalNote).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Choose COSMIC VCF…" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Validate and add COSMIC" })).toBeDisabled();
  await expect(dialog).toContainText("existing projects and their recorded evidence resources are unchanged");
  await dialog.getByText("Other installation options", { exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Install downloaded packages" })).toBeVisible();
  await expect(dialog).toContainText("one assembly data archive and the tool archive for this computer");
  await expect(dialog).toContainText("Downloads are not available for this genome on this computer");
  await expect(dialog.getByRole("button", { name: "Use existing resources" })).toBeVisible();
  await dialog.getByText("Advanced", { exact: true }).click();
  await expect(dialog).toContainText("Relative paths are resolved from its folder");
});

test("COSMIC setup explains missing inputs and shows validation errors beside the action", async ({ page }) => {
  await page.evaluate(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    let attempts = 0;
    internals.invoke = async (name, args) => {
      if (name === "resource_inventory") return { directory: "/synthetic/resources", platform: "linux-aarch64", issues: [], releases: [], installed: [{ descriptor: "/synthetic/bundle.json", ready: true, message: "Ready", bundle: { assembly: "b37", id: "test-b37" } }] };
      if (name === "plugin:dialog|open") return "/synthetic/cosmic.vcf.gz";
      if (name === "add_cosmic_resource") {
        localStorage.setItem("test-cosmic-request", JSON.stringify(args));
        await new Promise(resolve => setTimeout(resolve, 500));
        if (++attempts === 1) throw new Error("Cannot read the COSMIC index or it contains no contigs");
        return null;
      }
      return original(name, args);
    };
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "User settings" });
  await dialog.getByRole("button", { name: "Resources", exact: true }).click();
  await dialog.getByText("Optional resources · COSMIC", { exact: true }).click();
  const section = dialog.locator("details").filter({ has: page.locator("summary", { hasText: "Optional resources · COSMIC" }) });
  const validate = section.getByRole("button", { name: "Validate and add COSMIC", exact: true });
  await expect(validate).toBeDisabled();
  await expect(section.getByText(/To enable validation:/)).toContainText("enter the COSMIC release");
  await section.getByLabel("Reference profile").selectOption("/synthetic/bundle.json");
  await section.getByRole("button", { name: "Choose COSMIC VCF…" }).click();
  await section.getByLabel("COSMIC release", { exact: true }).fill("v92");
  await expect(section.getByText(/To enable validation:/)).toHaveText("To enable validation: confirm the assembly.");
  await section.getByRole("checkbox").check();
  await expect(validate).toBeEnabled();
  await validate.click();
  await expect(section.getByRole("button", { name: "Validating COSMIC…" })).toBeDisabled();
  await expect(section.getByRole("status")).toContainText("Checking the COSMIC VCF header");
  await expect(section.getByRole("alert")).toContainText("Cannot read the COSMIC index");
  await expect(validate).toBeEnabled();
  await validate.click();
  await expect(section.getByRole("alert")).toHaveCount(0);
  await expect(section.getByRole("status")).toHaveText("COSMIC profile added. Select it when creating a new project.");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("test-cosmic-request")!))).toEqual({ descriptor: "/synthetic/bundle.json", path: "/synthetic/cosmic.vcf.gz", release: "v92" });
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
  await expect(page).toHaveTitle("DGW Allele Editing Demo — DGW");
  await expect(page.locator(".project-context strong")).toHaveText("DGW_DEMO");
  await expect(page.getByLabel("Track Monitor")).toBeVisible();
  await expect(page.getByLabel("Mutation Generator", { exact: true })).toBeVisible();
  await expect(page.locator(".application-menu-context")).toHaveText("Unsaved example");
  await expect(page.locator(".application-menu-context")).not.toContainText("DGW Allele Editing Demo");

  await page.getByText("File", { exact: true }).click();
  await expect(page.getByRole("button", { name: /Save Example as Project/ })).toBeVisible();
});

test("opens the public GRCh37 exome example directly from the landing page", async ({ page }) => {
  await page.getByRole("button", { name: "Open HG00103 exome example" }).click();

  await expect(page.getByLabel("Genome tracks and device rack")).toBeVisible();
  await expect(page).toHaveTitle("HG00103 exome — GRCh37 — DGW");
  await expect(page.locator(".project-context strong")).toHaveText("SRR1596639");
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

test("expands a device without changing its controls and returns to the rack", async ({ page }, testInfo) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  const device = page.getByLabel("Mutation Generator", { exact: true });
  await device.getByLabel("Seed", { exact: true }).fill("9876");
  await page.getByRole("button", { name: "Maximize Mutation Generator", exact: true }).click();
  await expect(page.getByRole("button", { name: "Back to tracks", exact: true })).toBeFocused();
  await expect(page.locator(".dgw-track-deck")).toBeHidden();
  await expect(page.locator(".variant-browser")).toBeHidden();
  await expect(page.locator(".inspector")).toBeHidden();
  expect((await page.locator(".dgw-device-rack").boundingBox())!.height).toBeGreaterThan(450);
  await expect(device.getByLabel("Seed", { exact: true })).toHaveValue("9876");
  const rack = page.locator(".dgw-device-chain");
  await expect(rack.locator(":scope > section")).toHaveCount(1);
  expect((await device.boundingBox())!.width).toBeGreaterThan((await rack.boundingBox())!.width * 0.9);
  await page.screenshot({ path: testInfo.outputPath("expanded-device.png") });
  await device.getByLabel("Seed", { exact: true }).fill("1234");
  await page.getByRole("button", { name: "Back to tracks", exact: true }).click();
  await expect(page.getByRole("button", { name: "Maximize Mutation Generator", exact: true })).toBeFocused();
  await expect(device.getByLabel("Seed", { exact: true })).toHaveValue("1234");
  expect(await rack.locator(":scope > section").count()).toBeGreaterThan(1);
  await expect(page.locator(".dgw-track-deck")).toBeVisible();
  await page.getByRole("button", { name: "Maximize Mutation Generator", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".dgw-track-deck")).toBeVisible();
  await expect(device.getByLabel("Seed", { exact: true })).toHaveValue("1234");
});

test("track labels and controls fit at minimum height and when folded", async ({ page }, testInfo) => {
  await page.evaluate(() => localStorage.setItem("dgw.track-height", "76"));
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  const track = page.locator(".dgw-track.is-candidate").first();
  async function checkBounds() {
    const bounds = await track.boundingBox();
    for (const locator of [track.locator(".dgw-track-name input"), track.locator(".dgw-track-edit-status"), track.locator(".dgw-track-fold"), track.locator(".dgw-track-lane")]) {
      const item = await locator.boundingBox();
      expect(item).not.toBeNull();
      expect(item!.y).toBeGreaterThanOrEqual(bounds!.y);
      expect(item!.y + item!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height + 1);
      expect(item!.x + item!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
    }
  }
  await checkBounds();
  await track.locator(".dgw-track-fold").click();
  await checkBounds();
  await page.screenshot({ path: testInfo.outputPath("track-label-fit.png") });
});

test("Mutation Generator applies with one action and keeps Undo available", async ({ page }) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await page.getByLabel("Allele selection controls").getByRole("button", { name: "Select visible" }).click();
  const device = page.getByLabel("Mutation Generator", { exact: true });
  const generate = device.getByRole("button", { name: "Generate mutations", exact: true });
  await expect(generate).toHaveClass("primary");
  await expect(device.getByRole("button", { name: /Preview|Apply as/ })).toHaveCount(0);
  await generate.click();
  await expect(device).toContainText("1 reversible mutation blocks applied");
  await expect(generate).toBeEnabled();
  await page.getByRole("navigation", { name: "Application menu" }).getByText("Edit", { exact: true }).click();
  await expect(page.getByRole("button", { name: /Undo Randomize/ })).toBeEnabled();
  await expect(page.getByLabel("Edit status for BRAF · restore to REF", { exact: true })).toHaveText("1 active edit");
  await page.getByRole("button", { name: /Undo Randomize/ }).click();
  await expect(page.getByLabel("Edit status for BRAF · restore to REF", { exact: true })).toHaveText("Edits bypassed");
  await page.getByLabel("Allele selection controls").getByRole("button", { name: "Select visible" }).click();
  await device.getByLabel("Seed", { exact: true }).fill("123");
  await expect(generate).toBeEnabled();
  await expect(device).toContainText("Controls changed");
});

test("maximized mutation device confirms application and offers the edited track", async ({ page }) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await page.getByLabel("Allele selection controls").getByRole("button", { name: "Select visible" }).click();
  const device = page.getByLabel("Mutation Generator", { exact: true });
  await page.getByRole("button", { name: "Maximize Mutation Generator", exact: true }).click();
  await device.getByRole("button", { name: "Generate mutations", exact: true }).click();
  await expect(device.locator(".dgw-action-feedback")).toContainText("Last applied: 1 mutation block");
  await expect(device.locator(".dgw-action-feedback")).toContainText("BRAF · restore to REF");
  await expect(page.locator(".dgw-track-deck")).toBeHidden();
  await device.getByRole("button", { name: "View track", exact: true }).click();
  await expect(page.locator(".dgw-track-deck")).toBeVisible();
});

for (const completion of ["completed", "cancelled", "noOp"] as const) test(`bulk generation ${completion} handles the layer without a separate Apply step`, async ({ page }) => {
  await page.evaluate((completion) => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    let target = "";
    internals.invoke = async (name, args = {}) => {
      if (name === "variant_contigs") return [{ contig: "7", total: 2001, minPosition: 140453090, maxPosition: 140453190 }];
      if (name === "start_randomizer_preview_job") {
        target = String(args.trackId);
        return { id: "bulk-generation-test", status: "queued", progress: 0, message: "Preparing mutations" };
      }
      if (name === "background_job" && args.jobId === "bulk-generation-test") return {
        id: "bulk-generation-test", status: completion === "cancelled" ? "cancelled" : "completed", progress: 100, message: "Generation cancelled", result: {
          compoundLayerId: "test-prepared-layer", generatedEdits: completion === "noOp" ? 0 : 2001, randomizedPositions: completion === "noOp" ? 0 : 2001,
          noOpReason: completion === "noOp" ? "No eligible mutations. Track unchanged." : undefined
        }
      };
      if (name === "apply_compound_mutation_layer") {
        if (args.trackId !== target) throw Error("Wrong target track");
        localStorage.setItem("test-bulk-applied", String(args.layerId ?? args.compoundLayerId));
        const result = await original("run_randomizer", { trackId: target }) as { snapshot: unknown };
        return { snapshot: result.snapshot, generatedEditId: "edit-restored" };
      }
      return original(name, args);
    };
  }, completion);
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await page.getByLabel("Allele selection controls").getByRole("button", { name: "Select all variants · all chromosomes", exact: true }).click();
  const device = page.getByLabel("Mutation Generator", { exact: true });
  await device.locator(".dgw-randomizer-limit input").fill("3000");
  await device.getByRole("button", { name: "Generate mutations", exact: true }).click();
  await expect(device.locator(".dgw-action-feedback.running")).toHaveCount(0);
  if (completion === "completed") {
    await expect(device).toContainText("2,001 changes applied as one reversible mutation layer");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("test-bulk-applied"))).not.toBeNull();
  } else {
    await expect(device).toContainText(completion === "cancelled" ? "Generation cancelled" : "No eligible mutations");
    expect(await page.evaluate(() => localStorage.getItem("test-bulk-applied"))).toBeNull();
  }
  await expect(device.getByRole("button", { name: /Apply mutation layer|Preview changes/ })).toHaveCount(0);
});

for (const completion of ["completed", "cancelled", "noOp"] as const) test(`morph ${completion} uses one Apply action`, async ({ page }) => {
  await page.evaluate(completion => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    let destination = "";
    internals.invoke = async (name, args = {}) => {
      if (name === "start_track_morph_preview_job") {
        destination = String(args.trackId);
        if (args.targetTrackId === destination) throw Error("Target must differ");
        return { id: "morph-test", status: "queued", progress: 0, message: "Preparing morph" };
      }
      if (name === "background_job" && args.jobId === "morph-test") return {
        id: "morph-test", status: completion === "cancelled" ? "cancelled" : "completed", progress: 100, message: "Morph cancelled",
        result: { compoundLayerId: "morph-layer", generatedEdits: completion === "noOp" ? 0 : 2, selectedPositions: 2, amount: 50, noOpReason: completion === "noOp" ? "Tracks already match." : undefined }
      };
      if (name === "apply_compound_mutation_layer") {
        if (args.trackId !== destination) throw Error("Wrong destination");
        localStorage.setItem("test-morph-applied", destination);
        const result = await original("run_randomizer", { trackId: destination }) as { snapshot: unknown };
        return { snapshot: result.snapshot, generatedEditId: "edit-restored" };
      }
      return original(name, args);
    };
  }, completion);
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await page.getByRole("button", { name: "Maximize Genome Morph", exact: true }).click();
  const device = page.getByLabel("Genome Morph", { exact: true });
  await expect(device.getByRole("button", { name: "Preview", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("test-morph-applied"))).toBeNull();
  await device.getByRole("button", { name: "Apply morph", exact: true }).click();
  await expect(device).toContainText(completion === "completed" ? "2 changes applied as one reversible morph layer." : completion === "noOp" ? "Tracks already match." : "Morph cancelled");
  if (completion === "completed") await expect.poll(() => page.evaluate(() => localStorage.getItem("test-morph-applied"))).not.toBeNull();
  else expect(await page.evaluate(() => localStorage.getItem("test-morph-applied"))).toBeNull();
  await expect(device.getByRole("button", { name: "Apply morph", exact: true })).toBeEnabled();
});

test("failed mutation application shows an error instead of confirmation", async ({ page }) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await page.getByLabel("Allele selection controls").getByRole("button", { name: "Select visible" }).click();
  const device = page.getByLabel("Mutation Generator", { exact: true });
  await page.evaluate(() => localStorage.setItem("test-randomizer-failure", "1"));
  await page.getByRole("button", { name: "Maximize Mutation Generator", exact: true }).click();
  await device.getByRole("button", { name: "Generate mutations", exact: true }).click();
  await expect(device.getByRole("alert")).toContainText("Test application failed");
  await expect(device.getByRole("button", { name: "View track", exact: true })).toHaveCount(0);
  await expect(device.getByRole("button", { name: "Generate mutations", exact: true })).toBeEnabled();
});

for (const scope of ["gene", "allTrack"] as const) {
  for (const mode of ["saturation", "conservative"] as const) {
    test(`optimizer runs ${mode} on a small ${scope} selection`, async ({ page }) => {
      const variants = Array.from({ length: scope === "gene" ? 5 : 10 }, (_, index) => ({
        contig: scope === "gene" ? "19" : index < 7 ? "7" : "17",
        position: scope === "gene" ? 11_200_100 + index : 100_000 + index,
        reference: "A", alternate: "G"
      }));
      await page.evaluate(({ variants }) => {
        const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
        const original = internals.invoke;
        internals.invoke = async (name, args = {}) => {
          if (name === "resolve_variant_selection") {
            localStorage.setItem("test-optimizer-selection", JSON.stringify(args.selection));
            return { total: variants.length, limit: args.limit, variants, truncated: false };
          }
          if (name === "run_optimizer") {
            localStorage.setItem("test-optimizer-request", JSON.stringify(args.request));
            if (!(args.request as { selectedVariants: unknown[] }).selectedVariants.length) {
              throw Error("Select at least one active allele before running Genome Optimizer.");
            }
            return {
              snapshot: await original("open_project", args), generatedEditIds: [],
              plan: { proposals: [], exclusions: [], candidateComparisons: variants.map(key => ({
                sourceVariant: key, candidateVariant: key, current: true, selected: true, comparable: true,
                evidence: { impactLabel: "MODERATE" }, scoreComponents: { objectiveScore: 1 }, exactEvidenceSources: []
              })), consideredVariants: variants.length,
                scoreBefore: 0, scoreAfter: 0, scoreDescription: "Test score", limitation: "Test fixture",
                noOpReason: "Selection evaluated; no improving alternatives." }
            };
          }
          if (name === "start_optimizer_job") throw Error("Small selections should use the interactive optimizer");
          return original(name, args);
        };
      }, { variants });
      await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
      if (scope === "gene") {
        await page.getByLabel("Go to gene", { exact: true }).fill("LDLR");
        await page.locator(".gene-search-results").getByRole("button", { name: /LDLR/ }).click();
        await page.getByRole("button", { name: "Select 5 alleles in gene", exact: true }).click();
      } else {
        await page.getByLabel("Allele selection controls").getByRole("button", { name: "Select all variants · all chromosomes", exact: true }).click();
      }
      await page.getByRole("button", { name: "Maximize Genome Optimizer", exact: true }).click();
      const optimizer = page.locator(".dgw-optimizer");
      await optimizer.getByRole("combobox", { name: "Mode", exact: true }).selectOption(mode);
      await optimizer.getByRole("button", { name: mode === "saturation" ? "Run saturation" : "Generate edits", exact: true }).click();
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("test-optimizer-request") ?? "null")?.selectedVariants)).toEqual(variants);
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("test-optimizer-selection") ?? "null")?.kind)).toBe(scope === "gene" ? "interval" : "allTrack");
      await expect(optimizer).toContainText("Selection evaluated; no improving alternatives.");
      if (mode === "saturation") await expect(optimizer.getByText(`Candidate comparison · ${variants.length} alleles`, { exact: true })).toBeVisible();
      await expect(optimizer.getByRole("alert")).toHaveCount(0);
    });
  }
}

test("optimizer scoring labels stay above the knob controls", async ({ page }) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  for (const expanded of [false, true]) {
    if (expanded) await page.getByRole("button", { name: "Maximize Genome Optimizer", exact: true }).click();
    const optimizer = page.locator(".dgw-optimizer").first();
    const label = optimizer.locator(".dgw-fader-state").first();
    await expect(label).toBeVisible();
    const labelBox = await label.boundingBox();
    const knobBox = await optimizer.locator(".dgw-knob-bank").first().boundingBox();
    expect(labelBox).not.toBeNull(); expect(knobBox).not.toBeNull();
    expect(labelBox!.y + labelBox!.height).toBeLessThanOrEqual(knobBox!.y);
  }
});

test("maximized devices keep their actual input scope visible", async ({ page }) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await page.getByLabel("Allele selection controls").getByRole("button", { name: "Select all variants · all chromosomes", exact: true }).click();
  for (const name of ["Mutation Generator", "Genome Optimizer", "Consequence Predictor"]) {
    await page.getByRole("button", { name: `Maximize ${name}`, exact: true }).click();
    const scope = page.getByLabel("Device input scope");
    await expect(scope).toContainText("10 alleles selected");
    await expect(scope).toContainText("All chromosomes");
    await expect(scope).toContainText("BRAF · restore to REF");
    await scope.getByRole("button", { name: "Change selection", exact: true }).click();
  }
  await page.getByLabel("Allele selection controls").getByRole("button", { name: "Clear", exact: true }).click();
  await page.getByRole("button", { name: "Maximize Genome Optimizer", exact: true }).click();
  await expect(page.getByLabel("Device input scope")).toContainText("No alleles selected");
  await page.getByRole("button", { name: "Change selection", exact: true }).click();
  await expect(page.locator(".dgw-track-deck")).toBeVisible();
  await page.getByRole("button", { name: "Maximize Consequence Predictor", exact: true }).click();
  await expect(page.getByLabel("Device input scope")).toContainText("No alleles selected");
  await expect(page.getByRole("button", { name: "Create report", exact: true })).toBeDisabled();
});

test("compact predictor keeps its description small and its open action accessible", async ({ page }) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  const card = page.getByRole("region", { name: "Consequence Predictor device", exact: true });
  const summary = card.locator(".dgw-compact-prediction-summary");
  await expect(summary).toContainText("Automatic prediction");
  await expect(summary).toContainText("Used by focused alleles and Track Monitor.");
  expect(await summary.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeLessThanOrEqual(12);
  await card.getByRole("button", { name: "Selection report", exact: true }).click();
  await expect(page.getByRole("button", { name: "Create report", exact: true })).toBeVisible();
  await expect(page.locator(".dgw-compact-prediction-summary")).toHaveCount(0);
});

test("offers device bypass only for database Evidence devices", async ({ page }) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  for (const name of ["Mutation Generator", "Genome Morph", "Genome Optimizer"]) {
    const device = page.locator(".dgw-device-chain").getByLabel(name, { exact: true });
    await expect(device).toBeVisible();
    await expect(device.locator(".dgw-bypass")).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: /Track Compare is .* Toggle device/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Consequence Predictor is .* Toggle device/ })).toHaveCount(0);
  const toggle = page.getByRole("button", { name: "ClinVar is active. Toggle device.", exact: true });
  await toggle.click();
  await expect(page.getByRole("button", { name: "ClinVar is bypassed. Toggle device.", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "ClinVar is bypassed. Toggle device.", exact: true }).click();
  await expect(toggle).toBeVisible();
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
  await expect(page.getByRole("navigation", { name: "Application menu", exact: true })
    .getByText(/Close failed because the project could not be saved/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Edit and compare genome variants." })).toHaveCount(0);
  await page.getByText("File", { exact: true }).click();
  await page.getByRole("button", { name: "Close project", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Edit and compare genome variants." })).toBeVisible();
});

test("Track Compare preserves the map, opens full workspace and returns with Escape", async ({ page }, testInfo) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await expect(page.getByRole("group", { name: "Workspace mode" })).toHaveCount(0);
  await page.getByLabel("Allele selection controls").getByRole("button", { name: "Select all variants · all chromosomes", exact: true }).click();
  await page.getByRole("button", { name: "Open Track Compare", exact: true }).click();
  const compare = page.getByRole("region", { name: "Track Compare", exact: true });
  await expect(compare.getByRole("button", { name: "DNA changes", exact: true })).toHaveAttribute("aria-pressed", "true");
  await compare.getByRole("button", { name: "Genome view", exact: true }).click();
  await expect(page.getByRole("region", { name: "Genome difference map" })).toBeVisible();
  await expect(page.locator(".dgw-track-deck")).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("track-compare-map.png") });
  await compare.getByRole("button", { name: "DNA changes", exact: true }).click();
  await expect(compare.getByRole("region", { name: "Whole track DNA comparison" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("track-compare-changes.png") });
  await page.keyboard.press("Escape");
  await expect(compare).toHaveCount(0);
  await expect(page.locator(".dgw-track-deck")).toBeVisible();
});

test("genome map bounds dense data, zooms into alleles and searches genes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1400, height: 950 });
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await page.getByLabel("Allele selection controls").getByRole("button", { name: "Select all variants · all chromosomes", exact: true }).click();
  await page.getByRole("button", { name: "Open Track Compare", exact: true }).click();
  await page.getByRole("button", { name: "Genome view", exact: true }).click();
  const map = page.getByRole("region", { name: "Genome difference map" });
  await expect(map).toContainText("18,000 / 20,000 loci differ");
  expect(await map.locator("svg rect[role=button]").count()).toBeLessThanOrEqual(1024);
  await expect(map).toContainText("fixed 0–100% scale");
  await expect(map.locator("svg rect[role=button]").first()).toHaveAttribute("aria-label", /9000 of 10000 selected loci changed \(90.0%\).*6000 ALT sequence.*2000 ALT copies.*1000 copy\/phase/);
  const segments = map.locator("svg").first().locator("g").first();
  expect(Number(await segments.locator("rect.change-sequence").first().getAttribute("height"))).toBeCloseTo(40.8);
  expect(Number(await segments.locator("rect.change-altCopies").getAttribute("height"))).toBeCloseTo(13.6);
  expect(Number(await segments.locator("rect.change-placement").getAttribute("height"))).toBeCloseTo(6.8);
  await expect(map.getByLabel("Aligned allele differences")).toHaveCount(0);
  await map.getByRole("button", { name: "7", exact: true }).click();
  await expect(map.locator(".genome-map-heading")).toContainText("7:1,000–1,000,000");
  await expect(map.locator("svg")).toHaveCount(1);
  await map.locator("svg rect[role=button]").first().click();
  await expect(map.getByLabel("Aligned allele differences")).toBeVisible();
  await map.getByRole("button", { name: "Full chromosome", exact: true }).click();
  await expect(map.locator(".genome-map-heading")).toContainText("7:1,000–1,000,000");
  await map.getByRole("button", { name: "Whole genome", exact: true }).click();
  await expect(map).toContainText("18,000 / 20,000 loci differ");
  await map.locator("svg rect[role=button]").first().focus();
  await page.keyboard.press("Enter");
  await expect(map.getByLabel("Aligned allele differences")).toBeVisible();
  await map.getByLabel("Aligned allele differences").getByRole("button").first().click();
  await expect(map.getByRole("button", { name: "Close evidence" })).toBeVisible();
  await map.getByRole("button", { name: "Close evidence" }).click();
  await map.getByRole("button", { name: "Back", exact: true }).click();
  await expect(map).toContainText("18,000 / 20,000 loci differ");
  const strip = map.locator("svg").first();
  const box = (await strip.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.25, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, box.y + 12, { steps: 5 });
  await page.mouse.up();
  await expect(map.locator("svg")).toHaveCount(1);
  await expect(map.getByRole("button", { name: "Back", exact: true })).toBeEnabled();
  await map.getByRole("button", { name: "Whole genome", exact: true }).click();
  await map.getByLabel("Find gene").fill("LDLR");
  await map.getByRole("button", { name: "Search", exact: true }).click();
  await map.getByRole("button", { name: /LDLR · 19:/ }).click();
  await expect(map.locator(".genome-map-heading")).toContainText("19:11,200,038–11,244,506");
  await page.screenshot({ path: testInfo.outputPath("genome-map-gene.png") });
});

test("expanded devices share the same Back to tracks control", async ({ page }) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  const sizes = [];
  for (const device of ["Mutation Generator", "Genome Optimizer", "Genome Morph", "Track Compare"]) {
    await page.getByRole("button", { name: device === "Track Compare" ? "Open Track Compare" : `Maximize ${device}`, exact: true }).click();
    const back = page.getByRole("button", { name: "Back to tracks", exact: true });
    sizes.push(await back.evaluate(node => {
      const bounds = node.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height, font: getComputedStyle(node).fontSize };
    }));
    await back.click();
  }
  for (const size of sizes) expect(size).toEqual(sizes[0]);
});

test("large interface expanded devices use the full workstation width", async ({ page }) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await page.locator(".application-shell").evaluate(node => node.classList.add("large-interface"));
  for (const name of ["Maximize Mutation Generator", "Open Track Compare"]) {
    await page.getByRole("button", { name, exact: true }).click();
    const workspace = await page.locator(".workstation").boundingBox();
    const canvas = await page.locator(".canvas").boundingBox();
    expect(canvas!.width).toBeGreaterThan(workspace!.width * 0.95);
    await page.getByRole("button", { name: "Back to tracks", exact: true }).click();
  }
});

test("consequence comparison requires selection instead of offering implicit scopes", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await page.getByRole("button", { name: "Open Track Compare", exact: true }).click();
  await page.getByRole("group", { name: "Track Compare views" }).getByRole("button", { name: "Consequence changes", exact: true }).click();
  const comparison = page.getByRole("region", { name: "Track Compare", exact: true });
  for (const tab of ["DNA changes", "Genome view", "Consequence changes"]) {
    await comparison.getByRole("button", { name: tab, exact: true }).click();
    await expect(comparison.getByLabel("Comparison selection")).toContainText("No alleles selected");
    await expect(comparison.getByRole("table")).toHaveCount(0);
    await expect(comparison.getByRole("button", { name: "Compare consequences", exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole("group", { name: "Comparison scope" })).toHaveCount(0);
  await expect(comparison.getByRole("table")).toHaveCount(0);
  await comparison.getByRole("button", { name: "Change selection", exact: true }).click();
  await expect(page.locator(".dgw-track-deck")).toBeVisible();
});

test("generated mutations retain selection when opening Track Compare", async ({ page }) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await page.getByLabel("Allele selection controls").getByRole("button", { name: "Select all variants · all chromosomes", exact: true }).click();
  const device = page.getByLabel("Mutation Generator", { exact: true });
  await device.getByRole("button", { name: "Generate mutations", exact: true }).click();
  await expect(device).toContainText("reversible mutation blocks applied");
  await page.getByRole("button", { name: "Open Track Compare", exact: true }).click();
  await expect(page.getByLabel("Comparison selection")).toContainText("10 alleles selected");
  await expect(page.getByRole("region", { name: "Whole track DNA comparison" })).toBeVisible();
});

test("all comparison tabs send the same Track view selection", async ({ page }) => {
  await page.evaluate(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    internals.invoke = async (name, args = {}) => {
      if (["track_comparison_page", "track_comparison_map", "start_prediction_comparison_job"].includes(name)) {
        localStorage.setItem(name, JSON.stringify(args.selection));
      }
      return original(name, args);
    };
  });
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await page.getByLabel("Allele selection controls").getByRole("button", { name: "Select visible", exact: true }).click();
  await page.getByRole("button", { name: "Open Track Compare", exact: true }).click();
  const header = page.getByLabel("Comparison selection");
  const count = await header.textContent();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("track_comparison_page"))).not.toBeNull();
  await page.getByRole("button", { name: "Genome view", exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("track_comparison_map"))).not.toBeNull();
  await expect(header).toHaveText(count!);
  await page.getByRole("button", { name: "Consequence changes", exact: true }).click();
  const run = page.getByRole("button", { name: "Compare consequences", exact: true });
  await expect(run.locator("svg")).toHaveCount(1);
  await run.click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("start_prediction_comparison_job"))).not.toBeNull();
  const selections = await page.evaluate(() => ["track_comparison_page", "track_comparison_map", "start_prediction_comparison_job"].map(name => localStorage.getItem(name)));
  expect(selections[0]).toBe(selections[1]); expect(selections[1]).toBe(selections[2]);
});

test("searches DNA comparison across pages and preserves the differences filter", async ({ page }) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await page.evaluate(async () => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string) => Promise<unknown> } }).__TAURI_INTERNALS__;
    await internals.invoke("test_large_comparison");
  });
  await page.getByLabel("Allele selection controls").getByRole("button", { name: "Select all variants · all chromosomes", exact: true }).click();
  await page.getByRole("button", { name: "Open Track Compare", exact: true }).click();
  const comparison = page.getByRole("region", { name: "Whole track DNA comparison" });
  const search = comparison.getByRole("searchbox", { name: "Find locus" });
  await search.fill("chr17:1204");
  await search.press("Enter");
  await expect(comparison.getByText(/1–1 of 1 loci matching search/)).toBeVisible();
  await expect(comparison.getByRole("button", { name: "Inspect difference 17:1204", exact: true })).toBeVisible();
  await search.fill("7");
  await search.press("Enter");
  await expect(comparison.getByText("No loci match this search and the current Differences only filter.")).toBeVisible();
  await comparison.getByLabel("Changed loci across track").uncheck();
  await expect(comparison.getByText(/1–200 of 200 loci matching search/)).toBeVisible();
  await search.fill("chr17:1200-1204");
  await search.press("Enter");
  await expect(comparison.getByText(/1–5 of 5 loci matching search/)).toBeVisible();
  await comparison.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(comparison.getByText(/1–200 of 205 loci/)).toBeVisible();
});

test("pages whole-track DNA comparison without rendering all loci", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await page.evaluate(async () => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string) => Promise<unknown> } }).__TAURI_INTERNALS__;
    await internals.invoke("test_large_comparison");
  });
  await page.getByLabel("Allele selection controls").getByRole("button", { name: "Select all variants · all chromosomes", exact: true }).click();
  await page.getByRole("button", { name: "Open Track Compare", exact: true }).click();
  await page.getByRole("button", { name: "DNA changes", exact: true }).click();
  const comparison = page.getByRole("region", { name: "Whole track DNA comparison" });
  await expect(comparison.getByLabel("DNA difference summary").locator(".comparison-dna-stat").first().locator("b")).toHaveText("1");
  await page.screenshot({ path: testInfo.outputPath("track-compare-dna-cards.png") });
  await page.evaluate(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    internals.invoke = async (name, args) => {
      if (name === "evaluate_device") await new Promise(resolve => setTimeout(resolve, 700));
      return original(name, args);
    };
  });
  await comparison.getByRole("button", { name: /Inspect difference/ }).click();
  const evidence = comparison.getByRole("region", { name: "Evidence for selected DNA difference" });
  await expect(evidence.locator(".prediction-evidence-pair")).toHaveAttribute("aria-busy", "true");
  await expect(evidence.getByRole("heading", { name: "Source", exact: true })).toBeVisible();
  await expect(evidence.getByRole("heading", { name: "Current", exact: true })).toBeVisible();
  await evidence.evaluate(node => node.setAttribute("data-test-mounted", "yes"));
  await expect(evidence.locator(".prediction-evidence-pair")).toHaveAttribute("aria-busy", "false");
  await expect(evidence).toHaveAttribute("data-test-mounted", "yes");
  await expect(comparison.getByRole("region", { name: "Evidence for selected DNA difference" })).toContainText("No ALT at this locus");
  await comparison.getByLabel("Changed loci across track").uncheck();
  await expect(comparison.getByText(/1–200 of 205 loci/)).toBeVisible();
  await expect(comparison.getByLabel("DNA difference summary").locator(".comparison-dna-stat").first().locator("b")).toHaveText("—");
  expect(errors).toEqual([]);
  await expect(comparison.locator(".comparison-table-scroll").getByRole("row", { includeHidden: true })).toHaveCount(201);
  await page.evaluate(async () => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string) => Promise<unknown> } }).__TAURI_INTERNALS__;
    await internals.invoke("test_fail_next_comparison");
  });
  await comparison.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(comparison.getByRole("alert")).toContainText("Synthetic comparison read failure");
  await comparison.getByRole("button", { name: "Retry comparison", exact: true }).click();
  await expect(comparison.getByText(/201–205 of 205 loci/)).toBeVisible();
  await expect(comparison.locator(".comparison-table-scroll").getByRole("row", { includeHidden: true })).toHaveCount(6);
  await page.screenshot({ path: testInfo.outputPath("whole-track-comparison.png") });
  await comparison.getByLabel("Changed loci across track").check();
  await expect(comparison.locator(".comparison-table-scroll").getByRole("row", { includeHidden: true })).toHaveCount(2);
  await expect(comparison.getByLabel("Source and current allele matrix")).toBeVisible();
  await expect(comparison).toContainText("1 changed across 205 selected loci");
  await expect(comparison).toContainText("No ALT at this locus");
  await expect(comparison.getByRole("button", { name: "Previous page", exact: true })).toBeDisabled();
  await comparison.getByLabel("Changed loci across track").uncheck();
  await expect(comparison.locator(".comparison-table-scroll").getByRole("row", { includeHidden: true })).toHaveCount(201);
  await expect(comparison.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
});

test("opens the exact allele from whole-track comparison", async ({ page }) => {
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await page.getByLabel("Allele selection controls").getByRole("button", { name: "Select all variants · all chromosomes", exact: true }).click();
  await page.getByRole("button", { name: "Open Track Compare", exact: true }).click();
  await page.getByRole("button", { name: "DNA changes", exact: true }).click();
  await page.getByLabel("Changed loci across track").uncheck();
  await page.locator(".comparison-row-details > summary").click();
  await page.getByRole("button", { name: "Focus locus 7:140453148", exact: true }).click();
  const editor = page.getByLabel("Selected allele editor");
  await expect(editor).toBeVisible();
  await expect(editor.locator(".locked-position")).toContainText("140,453,148");
});

test("consequence results paginate 15K loci and jump without rendering the entire report", async ({ page }) => {
  await page.evaluate(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    internals.invoke = async (name, args = {}) => {
      const response = await original(name, name === "prediction_comparison_page" ? { ...args, offset: 0 } : args);
      if (name !== "prediction_comparison_page") return response;
      const page = response as { rows: Array<{ locus: { position: number } }> };
      const total = args.outcome ? 1 : 15001;
      const offset = Number(args.offset ?? 0);
      return { stale: false, total, rows: Array.from({ length: Math.min(200, Math.max(0, total - offset)) }, (_, index) => ({ ...page.rows[0], locus: { ...page.rows[0].locus, position: 1000 + offset + index } })) };
    };
  });
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await page.getByLabel("Allele selection controls").getByRole("button", { name: "Select all variants · all chromosomes", exact: true }).click();
  await page.getByRole("button", { name: "Open Track Compare", exact: true }).click();
  await page.getByRole("button", { name: "Consequence changes", exact: true }).click();
  const view = page.getByRole("region", { name: "Selected consequences comparison" });
  await view.getByRole("button", { name: "Compare consequences", exact: true }).click();
  const pager = view.getByRole("navigation", { name: "Consequence results pagination top" });
  await expect(pager).toContainText("1–200 of 15,001 loci");
  await expect(view.getByRole("row")).toHaveCount(201);
  const first = view.getByRole("row").nth(1);
  await first.getByRole("button", { name: "Evidence", exact: true }).click();
  const evidence = view.locator(".prediction-evidence-row");
  await expect(evidence).toHaveCount(1);
  expect(await evidence.evaluate(node => node.previousElementSibling?.textContent)).toContain("1,000");
  await expect(evidence.getByRole("region", { name: "source prediction evidence" })).toBeVisible();
  await evidence.getByRole("button", { name: "Close evidence" }).click();
  await expect(view.getByRole("row")).toHaveCount(201);
  await pager.getByRole("button", { name: "Last page", exact: true }).click();
  await expect(pager).toContainText("15,001–15,001 of 15,001 loci");
  await expect(view.getByRole("row")).toHaveCount(2);
  await expect(pager.getByRole("button", { name: "Next page", exact: true })).toBeDisabled();
  await pager.getByRole("spinbutton", { name: "Page number" }).fill("20");
  await pager.getByRole("button", { name: "Go", exact: true }).click();
  await expect(pager).toContainText("3,801–4,000 of 15,001 loci");
  await expect(view.getByRole("navigation", { name: "Consequence results pagination bottom" })).toContainText("3,801–4,000");
  await view.getByLabel("Prediction result filter").selectOption("different");
  await expect(pager).toContainText("1–1 of 1 loci");
  await expect(pager.getByRole("spinbutton", { name: "Page number" })).toHaveValue("1");
});

test("runs a whole-track prediction job, filters saved results and marks stale input", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await page.getByLabel("Allele selection controls").getByRole("button", { name: "Select all variants · all chromosomes", exact: true }).click();
  await page.getByRole("button", { name: "Open Track Compare", exact: true }).click();
  await page.getByRole("group", { name: "Track Compare views" }).getByRole("button", { name: "Consequence changes", exact: true }).click();
  const view = page.getByRole("region", { name: "Selected consequences comparison" });
  await expect(view).toContainText("10 alleles selected");
  await view.getByRole("button", { name: "Compare consequences", exact: true }).click();
  await expect(view).toContainText("Prediction comparison ready");
  await expect(view.getByRole("row")).toHaveCount(5);
  await view.getByLabel("Prediction result filter").selectOption("different");
  await expect(view.getByRole("row")).toHaveCount(2);
  await view.getByRole("button", { name: "Evidence", exact: true }).click();
  await expect(view.getByRole("region", { name: "source prediction evidence" })).toContainText("TEST_TRANSCRIPT");
  await expect(view.getByRole("region", { name: "current prediction evidence" })).toContainText("TEST_TRANSCRIPT");
  await page.screenshot({ path: testInfo.outputPath("whole-track-predictions.png") });
  await view.getByRole("button", { name: "Go to locus", exact: true }).click();
  const editor = page.getByLabel("Selected allele editor");
  if (await editor.isVisible()) await editor.getByRole("button", { name: /devices/i }).click();
  await page.getByRole("button", { name: "Open Track Compare", exact: true }).click();
  await expect(view).toContainText("10 alleles selected");
  await expect(view.getByLabel("Prediction result filter")).toHaveValue("different");
  await expect(view.getByRole("row")).toHaveCount(2);
  await page.evaluate(async () => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string) => Promise<unknown> } }).__TAURI_INTERNALS__;
    await internals.invoke("test_stale_prediction");
  });
  await view.getByLabel("Prediction result filter").selectOption("same");
  await expect(view.getByRole("alert")).toContainText("Results are outdated");
  await expect(view.getByRole("region", { name: "source prediction evidence" })).toHaveCount(0);
});

test("formats ClinVar consistently in Evidence and Track Compare without losing annotation values", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.evaluate(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    internals.invoke = async (name, args) => {
      if (name === "evaluate_device" && args?.deviceId === "org.dgw.builtin.cosmic") return {
        source: "v92", status: "found", records: [{ id: "COSV_TEST", GENE: "BRAF_ENST_TEST", HGVSC: "ENST_TEST:c.123A>G", HGVSP: "p.Test", CNT: "7", FUTURE: "keep_this|value,unchanged", raw: "Synthetic COSMIC raw record" }]
      };
      if (name === "evaluate_device" && args?.deviceId === "org.dgw.builtin.clinvar") return {
        source: "ClinVar test fixture", status: "found", records: [{
          id: "123", CLNSIG: "Conflicting_classifications_of_pathogenicity",
          CLNSIGCONF: "Uncertain_significance(2)|Likely_benign(1)",
          CLNREVSTAT: "criteria_provided,_conflicting_classifications",
          CLNDN: "Synthetic_condition,_type_1|Another_condition|not_provided|Fourth_condition",
          MC: "SO:0001583|missense_variant,SO:0001627|intron_variant",
          GENEINFO: "BRAF:673", FUTURE_FIELD: "keep_this|value,unchanged",
          raw: "Synthetic ClinVar raw record"
        }, { id: "456", CLNSIG: "Pathogenic/Likely_pathogenic", CLNREVSTAT: "unrecognised_status" }]
      };
      return original(name, args);
    };
  });
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await page.getByText("View", { exact: true }).click();
  const evidenceMenu = page.getByRole("button", { name: /Evidence panel$/ });
  if (!(await evidenceMenu.getAttribute("class"))?.includes("is-selected")) await evidenceMenu.click();
  await page.keyboard.press("Escape");
  const card = page.locator(".inspector").getByRole("article", { name: "ClinVar test fixture evidence" });
  const cosmic = page.locator(".inspector").getByRole("article", { name: "v92 evidence" });
  await expect(cosmic.getByText("BRAF_ENST_TEST", { exact: true })).toBeVisible();
  await expect(cosmic.getByText("Reported samples", { exact: true })).toBeVisible();
  await expect(cosmic.locator(".annotation-label", { hasText: /^7$/ })).toBeVisible();
  await expect(cosmic.locator(".annotation-stars, .annotation-pathogenic")).toHaveCount(0);
  await cosmic.getByText("Additional annotations · 1", { exact: true }).click();
  await expect(cosmic.getByText("keep_this|value,unchanged", { exact: true })).toBeVisible();
  await expect(card.locator(".annotation-conflicting")).toHaveText("Conflicting classifications of pathogenicity");
  await expect(card.getByRole("img", { name: "1 of 4 review stars" })).toBeVisible();
  await expect(card.getByText("missense variant · SO:0001583", { exact: true })).toBeVisible();
  await expect(card.getByText("Synthetic condition, type 1", { exact: true })).toBeVisible();
  await card.getByText("+1 more", { exact: true }).click();
  await expect(card.getByText("Fourth condition", { exact: true })).toBeVisible();
  await card.getByText("Additional annotations · 1", { exact: true }).click();
  await expect(card.getByText("keep_this|value,unchanged", { exact: true })).toBeVisible();
  await card.getByText("Raw matched record", { exact: true }).click();
  await expect(card.getByText("Synthetic ClinVar raw record", { exact: true })).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((node, theme) => node.setAttribute("data-dgw-theme", theme), theme);
    await card.screenshot({ path: testInfo.outputPath(`clinvar-${theme}.png`) });
    await cosmic.screenshot({ path: testInfo.outputPath(`cosmic-${theme}.png`) });
  }
  await card.getByRole("combobox").selectOption("1");
  await expect(card.locator(".annotation-pathogenic")).toHaveText("Pathogenic/Likely pathogenic");
  await expect(card.locator(".annotation-stars")).toHaveCount(0);
  await expect(card).toContainText("unrecognised status");
  await page.evaluate(async () => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string) => Promise<unknown> } }).__TAURI_INTERNALS__;
    await internals.invoke("test_large_comparison");
  });
  await page.getByLabel("Allele selection controls").getByRole("button", { name: "Select all variants · all chromosomes", exact: true }).click();
  await page.getByRole("button", { name: "Open Track Compare", exact: true }).click();
  await page.getByRole("button", { name: "DNA changes", exact: true }).click();
  const comparison = page.getByRole("region", { name: "Whole track DNA comparison" });
  await comparison.getByRole("button", { name: /Inspect difference/ }).click();
  const compared = comparison.getByRole("article", { name: "ClinVar test fixture evidence" });
  await expect(compared.locator(".annotation-conflicting")).toHaveText("Conflicting classifications of pathogenicity");
  await expect(compared.getByRole("img", { name: "1 of 4 review stars" })).toBeVisible();
  const cosmicCompared = comparison.getByRole("article", { name: "v92 evidence" });
  await expect(cosmicCompared.getByText("BRAF_ENST_TEST", { exact: true })).toBeVisible();
  await expect(cosmicCompared.getByText("Reported samples", { exact: true })).toBeVisible();
});

test("automatic review waits for evidence then the chosen reading interval and pauses safely", async ({ page }) => {
  await page.evaluate(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, args?: Record<string, unknown>) => Promise<any> } }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    let nextCalls = 0;
    internals.invoke = async (name, args) => {
      if (name === "transport_target") {
        const snapshot = await original("open_project", { path: "/synthetic/DGW-Allele-Editing-Demo.dgw" });
        const request = args?.request as { action: string };
        if (request.action === "next") { nextCalls++; localStorage.setItem("review-next-calls", String(nextCalls)); }
        const variant = snapshot.variants[nextCalls + 1];
        if (!variant) return { total: 2 };
        return { total: 2, target: { cursor: { sourceKey: variant.key }, sourceKey: variant.key, currentVariant: variant, locusStatus: "alternate", ordinal: nextCalls + 1, total: 2, wrapped: false } };
      }
      if (name === "evaluate_device" && localStorage.getItem("slow-review")) {
        await new Promise(resolve => setTimeout(resolve, 900));
        localStorage.setItem("review-evidence-ready", String(Date.now()));
      }
      return original(name, args);
    };
  });
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  const bar = page.getByRole("region", { name: "Genome transport", exact: true });
  await expect(bar.getByLabel("Evidence reading time")).toHaveValue("5");
  await bar.getByLabel("Evidence reading time").selectOption("3");
  await page.evaluate(() => localStorage.setItem("slow-review", "1"));
  await bar.getByRole("button", { name: "Start automatic variant and Evidence review" }).click();
  await expect(page.locator(".evidence-loading").first()).toBeVisible();
  await expect(page.locator(".evidence-slot[aria-busy=true]")).toHaveCount(3);
  await expect(page.locator(".evidence-loading")).toHaveCount(0);
  const ready = Number(await page.evaluate(() => localStorage.getItem("review-evidence-ready")));
  expect(await page.evaluate(() => localStorage.getItem("review-next-calls"))).toBeNull();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("review-next-calls")), { timeout: 6000 }).toBe("1");
  expect(Date.now() - ready).toBeGreaterThanOrEqual(2900);
  await bar.getByRole("button", { name: "Pause automatic review" }).click();
  await expect(bar.getByRole("button", { name: "Start automatic variant and Evidence review" })).toBeVisible();
  await page.waitForTimeout(3300);
  expect(await page.evaluate(() => localStorage.getItem("review-next-calls"))).toBe("1");
});

test("keeps transport coordinates inside the canvas at narrow window sizes", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  const bar = page.getByRole("region", { name: "Genome transport", exact: true });
  const position = bar.locator(".transport-position");
  const coordinates = bar.locator(".transport-location > summary");
  const [barBox, positionBox, coordinatesBox] = await Promise.all([
    bar.boundingBox(), position.boundingBox(), coordinates.boundingBox()
  ]);
  expect(barBox).not.toBeNull(); expect(positionBox).not.toBeNull(); expect(coordinatesBox).not.toBeNull();
  expect(coordinatesBox!.x + coordinatesBox!.width).toBeLessThanOrEqual(barBox!.x + barBox!.width + 0.5);
  expect(positionBox!.x + positionBox!.width).toBeLessThanOrEqual(coordinatesBox!.x - 4);
  await expect(position).toContainText("1-based");
});

test("makes every transcript evidence record accessible without changing the allele", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await page.getByText("View", { exact: true }).click();
  // Evidence is initially hidden by the default settings in some saved profiles.
  const evidenceMenu = page.getByRole("button", { name: /Evidence panel$/ });
  if (!(await evidenceMenu.getAttribute("class"))?.includes("is-selected")) await evidenceMenu.click();
  await page.keyboard.press("Escape");
  const card = page.getByRole("article", { name: "Consequence Predictor predictions" });
  const selector = card.getByLabel("Consequence Predictor record");
  await expect(selector).toHaveCount(1);
  await expect(card.locator(".impact-high")).toHaveText("HIGH");
  await expect(card.locator(".prediction-effect .prediction-term")).toHaveText("Stop gained");
  await card.screenshot({ path: testInfo.outputPath("evidence-labels-preview.png") });
  await selector.selectOption("1");
  await expect(card.locator(":scope > dl")).toContainText("ENST00000479537");
  await expect(card.locator(".prediction-effect .prediction-term")).toHaveText("Synonymous");
  await expect(card.locator(".impact-low")).toHaveText("LOW");
  await card.getByText("Raw matched record", { exact: true }).click();
  await expect(card).toContainText("Synthetic second transcript record");
  await selector.selectOption("0");
  await expect(card.locator(":scope > dl")).toContainText("ENST00000288602");
});

test("shows compact prediction progress and a working cancel control", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("test-hold-prediction", "1"));
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await page.getByLabel("Allele selection controls").getByRole("button", { name: "Select visible", exact: true }).click();
  await page.getByRole("button", { name: "Maximize Consequence Predictor", exact: true }).click();
  const results = page.getByRole("region", { name: "Consequence selection report" });
  await results.getByRole("button", { name: "Create report", exact: true }).click();
  await expect(results.getByRole("progressbar", { name: "Prediction progress", exact: true })).toHaveAttribute("value", "20");
  const cancel = results.getByRole("button", { name: "Cancel prediction", exact: true });
  await expect(cancel).toHaveText("Cancel");
  await page.screenshot({ path: "/tmp/dgw-prediction-progress.png" });
  await cancel.click();
  await expect(cancel).toHaveCount(0);
  await expect(results.getByRole("button", { name: "Create report", exact: true })).toBeEnabled();
});

test("predicts the track selection with paged current-only results", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole("button", { name: "Open GRCh37 example project" }).click();
  await page.getByLabel("Allele selection controls").getByRole("button", { name: "Select all variants · all chromosomes", exact: true }).click();
  await page.getByRole("button", { name: "Maximize Consequence Predictor", exact: true }).click();
  const results = page.getByRole("region", { name: "Consequence selection report" });
  await results.getByRole("button", { name: "Create report", exact: true }).click();
  await expect(results.getByRole("columnheader", { name: "REF → ALT", exact: true })).toBeVisible();
  await expect(results.getByRole("columnheader", { name: "Source ALTs" })).toHaveCount(0);
  await expect(results.getByRole("button", { name: "Transcripts", exact: true })).toHaveCount(200);
  await results.getByRole("button", { name: "Transcripts", exact: true }).first().click();
  await expect(results.getByRole("article", { name: "Consequence Predictor predictions" })).toContainText("TEST_TRANSCRIPT");
  await page.screenshot({ path: "/tmp/dgw-selection-predictor.png" });
  await results.getByRole("navigation", { name: "Consequence results pagination top" }).getByRole("button", { name: "Next page", exact: true }).click();
  await expect(results.getByRole("button", { name: "Transcripts", exact: true })).toHaveCount(5);
  await results.getByRole("group", { name: "Consequence filter" }).getByRole("button", { name: "synonymous", exact: true }).click();
  await expect(results.getByRole("button", { name: "Transcripts", exact: true })).toHaveCount(200);
  await results.getByRole("group", { name: "Impact filter" }).getByRole("button", { name: "LOW", exact: true }).click();
  await results.getByRole("group", { name: "Impact filter" }).getByRole("button", { name: "MODERATE", exact: true }).click();
  await expect(results.getByRole("group", { name: "Impact filter" }).getByRole("button", { name: "LOW", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(results.getByRole("group", { name: "Impact filter" }).getByRole("button", { name: "MODERATE", exact: true })).toHaveAttribute("aria-pressed", "true");
  const lowChip = results.getByRole("group", { name: "Impact filter" }).getByRole("button", { name: "LOW", exact: true });
  const moderateChip = results.getByRole("group", { name: "Impact filter" }).getByRole("button", { name: "MODERATE", exact: true });
  expect(await lowChip.evaluate(el => getComputedStyle(el).color)).not.toEqual(await moderateChip.evaluate(el => getComputedStyle(el).color));
  await page.screenshot({ path: "/tmp/dgw-prediction-filter-colors.png" });
  await results.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(results.getByRole("group", { name: "Impact filter" }).getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(results).toContainText("strongest transcript impact");
});
