import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { renderFilesEditorFrame, renderFilesTreeFrame, renderFilesWorkView } from "../../../packages/files/src/server/render.ts";
import { atelierUi } from "../smoke/support/atelier-ui.ts";
import { removeWorkspaceResidentTurboStream, renderGlobalMobileNavigation, renderWorkspacePane, renderWorkspacePresentation, workspacePaneCollectionsTurboStream, workspacePresentationTurboStream, type WorkspacePanePresentation, type WorkspacePresentation } from "../src/server/workspace-presentation.ts";

let browser: Browser;
let browserContext: BrowserContext;
let workspaceClient: string;
let designSystemClient: string;
let designSystemStyle: string;
let workspaceStyle: string;
let filesStyle: string;
let catalogueHtml: string;

async function newTestPage(options: { viewport?: { width: number; height: number }; reducedMotion?: "reduce" | "no-preference" } = {}): Promise<Page> {
  const page = await browserContext.newPage();
  if (options.viewport) await page.setViewportSize(options.viewport);
  if (options.reducedMotion) await page.emulateMedia({ reducedMotion: options.reducedMotion });
  return page;
}

function renderShellResidents(pane: WorkspacePanePresentation, residentsHtml: string): string {
  return `<div class="app fixed-shell-app" data-controller="workspace-navigation">${renderWorkspacePane(pane)}<main class="fixed-shell-app-main"><div id="workspace_detail" data-controller="workspace-residency" data-workspace-residency-max-resident-value="5"><div class="workspace-detail-empty" data-workspace-residency-target="empty" hidden></div><div class="workspace-detail-loading" data-workspace-residency-target="loading" hidden></div>${residentsHtml}</div></main>${renderGlobalMobileNavigation()}</div>`;
}

function renderShellFixture(presentation: WorkspacePresentation, pane: WorkspacePanePresentation, cached: readonly WorkspacePresentation[] = []): string {
  const residents = [presentation, ...cached].map((resident, index) => `<div class="workspace-detail-resident${index === 0 ? " visible" : ""}" data-workspace-residency-target="resident" data-workspace-id="${resident.workspace.id}">${renderWorkspacePresentation(resident)}</div>`).join("");
  return renderShellResidents(pane, residents);
}

beforeAll(async () => {
  const build = Bun.spawn(["bun", "run", "apps/web/scripts/build-assets.ts"], { cwd: new URL("../../..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
  if (exitCode !== 0) throw new Error(`workspace client build failed:\n${stdout}${stderr}`);
  // SAFETY: The test fixture controls this value and establishes the asserted shape.
  const manifest = await Bun.file(new URL("../public/assets-manifest.json", import.meta.url)).json() as Record<string, string>;
  workspaceClient = await Bun.file(new URL(`../public${manifest["/workspace.js"]}`, import.meta.url)).text();
  designSystemClient = await Bun.file(new URL(`../public${manifest["/design-system.js"]}`, import.meta.url)).text();
  designSystemStyle = await Bun.file(new URL("../public/design-system.css", import.meta.url)).text();
  const shellStyle = await Bun.file(new URL("../public/style.css", import.meta.url)).text();
  workspaceStyle = `${designSystemStyle}\n${shellStyle}`;
  filesStyle = await Bun.file(new URL("../../../packages/files/src/client/style.css", import.meta.url)).text();
  catalogueHtml = await Bun.file(new URL("../public/design-system-catalogue.html", import.meta.url)).text();
  const executablePath = process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/local/bin/chromium";
  browser = await chromium.launch({ executablePath, headless: true });
  browserContext = await browser.newContext();
});

afterAll(async () => {
  await browserContext?.close();
  await browser?.close();
});

describe("Atelier browser behavior", () => {
  test("switches the design catalogue between responsive preview platforms", async () => {
    const serveCatalogue = async (page: Page) => {
      await page.route("http://catalogue.test/design-system-catalogue.html**", (route) => route.fulfill({ contentType: "text/html", body: catalogueHtml }));
      await page.route("http://catalogue.test/design-system.css", (route) => route.fulfill({ contentType: "text/css", body: workspaceStyle }));
      await page.route("http://catalogue.test/design-system.js", (route) => route.fulfill({ contentType: "text/javascript", body: designSystemClient }));
      await page.goto("http://catalogue.test/design-system-catalogue.html");
    };
    const desktopPage = await newTestPage({ viewport: { width: 1280, height: 800 } });
    await serveCatalogue(desktopPage);
    const preview = desktopPage.locator("[data-catalogue-preview]");
    expect(await desktopPage.locator('[data-catalogue-platform="desktop"]').getAttribute("aria-pressed")).toBe("true");
    expect(await preview.getAttribute("data-platform")).toBe("desktop");

    await desktopPage.locator('[data-catalogue-platform="mobile"]').click();
    expect(await desktopPage.locator('[data-catalogue-platform="mobile"]').getAttribute("aria-pressed")).toBe("true");
    expect(await preview.getAttribute("data-platform")).toBe("mobile");
    expect(new URL(desktopPage.url()).searchParams.get("platform")).toBe("mobile");
    await desktopPage.close();

    const mobilePage = await newTestPage({ viewport: { width: 390, height: 844 } });
    await serveCatalogue(mobilePage);
    expect(await mobilePage.locator('[data-catalogue-platform="mobile"]').getAttribute("aria-pressed")).toBe("true");
    expect(await mobilePage.locator("[data-catalogue-preview]").getAttribute("data-platform")).toBe("mobile");
    await mobilePage.close();
  });

  test("toggle variants expose selection and support keyboard navigation", async () => {
    const page = await newTestPage();
    await page.route("http://catalogue.test/design-system-catalogue.html**", (route) => route.fulfill({ contentType: "text/html", body: catalogueHtml }));
    await page.route("http://catalogue.test/design-system.css", (route) => route.fulfill({ contentType: "text/css", body: workspaceStyle }));
    await page.route("http://catalogue.test/design-system.js", (route) => route.fulfill({ contentType: "text/javascript", body: designSystemClient }));
    await page.goto("http://catalogue.test/design-system-catalogue.html?embedded=1");

    const buttonToggle = page.locator("[data-catalogue-button-toggle]");
    const edit = buttonToggle.getByRole("button", { name: "Edit" });
    const preview = buttonToggle.getByRole("button", { name: "Preview" });
    expect(await edit.getAttribute("aria-pressed")).toBe("true");
    await preview.click();
    expect(await edit.getAttribute("aria-pressed")).toBe("false");
    expect(await preview.getAttribute("aria-pressed")).toBe("true");

    const textToggle = page.locator("[data-catalogue-text-toggle]");
    const overview = textToggle.getByRole("button", { name: "Overview" });
    const activity = textToggle.getByRole("button", { name: "Recent activity" });
    await overview.focus();
    await page.keyboard.press("ArrowRight");
    expect(await overview.getAttribute("aria-pressed")).toBe("false");
    expect(await activity.getAttribute("aria-pressed")).toBe("true");
    expect(await activity.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(Number.parseFloat(await textToggle.evaluate((element) => element.style.getPropertyValue("--text-toggle-indicator-width")))).toBeGreaterThan(0);
    await page.close();
  });

  test("design-system copy buttons write nearby content and confirm success", async () => {
    await browserContext.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://localhost" });
    const page = await newTestPage();
    await page.route("http://localhost/design-system-catalogue.html**", (route) => route.fulfill({ contentType: "text/html", body: catalogueHtml }));
    await page.route("http://localhost/design-system.css", (route) => route.fulfill({ contentType: "text/css", body: workspaceStyle }));
    await page.route("http://localhost/design-system.js", (route) => route.fulfill({ contentType: "text/javascript", body: designSystemClient }));
    await page.goto("http://localhost/design-system-catalogue.html?embedded=1");

    const copy = page.locator("[data-catalogue-copy] .copy-button");
    await copy.click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("bun run check\nbun test");
    expect(await copy.locator(".copy-button__icon").textContent()).toBe("✓");
    expect(await copy.getAttribute("aria-label")).toBe("Copied to clipboard");
    await page.waitForTimeout(1100);
    expect(await copy.locator(".copy-button__icon").textContent()).toBe("⧉");
    expect(await copy.getAttribute("aria-label")).toBe("Copy example to clipboard");
    await page.close();
    await browserContext.clearPermissions();
  });

  test("design-system managed lists filter without caller wiring", async () => {
    const page = await newTestPage();
    await page.route("http://catalogue.test/design-system-catalogue.html**", (route) => route.fulfill({ contentType: "text/html", body: catalogueHtml }));
    await page.route("http://catalogue.test/design-system.css", (route) => route.fulfill({ contentType: "text/css", body: workspaceStyle }));
    await page.route("http://catalogue.test/design-system.js", (route) => route.fulfill({ contentType: "text/javascript", body: designSystemClient }));
    await page.goto("http://catalogue.test/design-system-catalogue.html?embedded=1");

    const list = page.locator("[data-catalogue-managed-list]");
    await list.getByRole("searchbox").fill("openrouter");
    expect(await list.locator(".managed-list__item:visible").count()).toBe(1);
    await list.getByRole("searchbox").fill("missing");
    expect(await list.locator(".managed-list__empty").isVisible()).toBe(true);

    const theme = page.locator(".catalogue-field.popup-menu-anchor");
    await theme.locator(".popup-menu-trigger").click();
    expect(await theme.locator(".popup-menu").isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    expect(await theme.locator(".popup-menu").isHidden()).toBe(true);
    await page.close();
  });

  test("dismisses the Work launcher outside and after choosing an item", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "popup", title: "Popup" },
      agentConversations: [{ id: "agent", title: "Agent", bodyHtml: "<p>Agent</p>" }],
      workViews: [],
      commands: [{ id: "files.create", label: "New Files view", scope: "workspace", placement: "work-launcher" }],
    };
    const page = await newTestPage();
    await page.route("http://atelier.test/workspaces/popup", (route) => route.fulfill({ contentType: "text/html", body: `<style>${designSystemStyle}</style><button type="button">Outside</button>${renderWorkspacePresentation(presentation)}<script type="module" src="/design-system.js"></script>` }));
    await page.route("**/design-system.js", (route) => route.fulfill({ contentType: "text/javascript", body: designSystemClient }));
    await page.route("**/workspaces/popup/commands/files.create", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/workspaces/popup");

    const trigger = page.getByRole("button", { name: "Open Work view" });
    const menu = page.getByRole("menu", { name: "Open Work view" });
    await trigger.click();
    expect(await menu.isVisible()).toBe(true);
    await page.getByRole("button", { name: "Outside" }).click();
    expect(await menu.isHidden()).toBe(true);

    await trigger.click();
    await page.getByRole("menuitem", { name: "New Files view" }).click();
    expect(await menu.isHidden()).toBe(true);
    expect(await trigger.getAttribute("aria-expanded")).toBe("false");
    await page.close();
  });

  test("design-system dialogs auto-show and restore focus", async () => {
    const page = await newTestPage();
    await page.route("http://design-system.test/", (route) => route.fulfill({ contentType: "text/html", body: `<button id="opener">Open</button><script type="module" src="/design-system.js"></script>` }));
    await page.route("http://design-system.test/design-system.js", (route) => route.fulfill({ contentType: "text/javascript", body: designSystemClient }));
    await page.goto("http://design-system.test/");
    await page.locator("#opener").focus();
    await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", `<dialog class="dialog" data-dialog-auto-show><input aria-label="Filter" autofocus><form method="dialog"><button>Close</button></form></dialog>`));
    const dialog = page.locator("dialog");
    await dialog.waitFor({ state: "visible" });
    expect(await page.getByRole("textbox", { name: "Filter" }).evaluate((element) => element === document.activeElement)).toBe(true);
    await dialog.getByRole("button", { name: "Close" }).click();
    expect(await page.locator("#opener").evaluate((element) => element === document.activeElement)).toBe(true);
    await page.close();
  });

  test("cancels an API key dialog without validating its required input", async () => {
    const page = await newTestPage();
    await page.route("http://atelier.test/", (route) => route.fulfill({
      contentType: "text/html",
      body: `<dialog class="dialog" data-dialog-auto-show><form id="api-key"><input required></form><div class="dialog__actions"><form method="dialog"><button>Cancel</button></form><button type="submit" form="api-key">Connect</button></div></dialog><script type="module" src="/design-system.js"></script>`,
    }));
    await page.route("**/design-system.js", (route) => route.fulfill({ contentType: "text/javascript", body: designSystemClient }));
    await page.goto("http://atelier.test/");
    const dialog = page.locator("dialog");
    await dialog.waitFor({ state: "visible" });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(await dialog.isHidden()).toBe(true);
    await page.close();
  });

  test("switches a Markdown file between Edit and Rendered", async () => {
    const page = await newTestPage();
    const editor = renderFilesWorkView("workspace", { id: "workspace", path: "/work/README.md", line: 1 }).bodyHtml!;
    await page.route("http://atelier.test/", (route) => route.fulfill({
      contentType: "text/html",
      body: `<style>${workspaceStyle}</style><div class="fixed-workspace-presentation"><div data-work-view-reorder-key="files:workspace"><button data-atelier-fullscreen-title-value="Files"><span class="action-item__label-text">Files</span></button></div><section data-workspace-pane-id="files:workspace">${editor}</section></div><script type="module" src="/workspace-test.js"></script>`,
    }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.route("**/files-view/content?**", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ path: "/work/README.md", content: "# Rendered", revision: "one", writable: true }),
    }));
    let completeRender!: () => void;
    const renderPending = new Promise<void>((resolve) => { completeRender = resolve; });
    await page.route("**/files-view/markdown-preview?**", async (route) => {
      await renderPending;
      await route.fulfill({ contentType: "text/html", body: "<h1>Rendered</h1>" });
    });
    await page.goto("http://atelier.test/");
    await page.locator(".file-editor-loading").waitFor({ state: "detached" });

    const display = page.getByRole("group", { name: "Markdown display" });
    const edit = display.getByRole("button", { name: "Edit" });
    const preview = display.getByRole("button", { name: "Rendered" });
    expect(await edit.getAttribute("aria-pressed")).toBe("true");
    expect(await preview.getAttribute("aria-pressed")).toBe("false");

    const previewNode = await preview.elementHandle();
    await preview.click();
    expect(await display.getAttribute("aria-busy")).toBe("true");
    expect(await preview.evaluate((node, original) => node === original, previewNode)).toBe(true);
    await edit.click();
    expect(await display.getAttribute("aria-busy")).toBe("false");
    expect(await page.locator(".file-editor-host").isVisible()).toBe(true);
    completeRender();

    await preview.click();
    await page.getByRole("heading", { name: "Rendered" }).waitFor();
    expect(await preview.getAttribute("aria-pressed")).toBe("true");
    expect(await display.getAttribute("aria-busy")).toBe("false");
    await edit.click();
    expect(await page.locator(".file-editor-host").isVisible()).toBe(true);
    expect(await edit.getAttribute("aria-pressed")).toBe("true");
    await page.close();
  });

  test("collapses the Files pane after selecting a file", async () => {
    const page = await newTestPage();
    const files = renderFilesWorkView("workspace", { id: "workspace" }).bodyHtml!;
    const tree = renderFilesTreeFrame("workspace", "workspace", [{ name: "README.md", path: "/work/README.md", kind: "file", size: 20, openable: true }]);
    const editor = renderFilesEditorFrame("workspace", { id: "workspace", path: "/work/README.md" });
    await page.route("http://atelier.test/", (route) => route.fulfill({ contentType: "text/html", body: `<style>${workspaceStyle}</style><div class="fixed-workspace-presentation"><div data-work-view-reorder-key="files:workspace"><button data-atelier-fullscreen-title-value="Files"><span class="action-item__label-text">Files</span></button></div><section data-workspace-pane-id="files:workspace">${files}</section></div><script type="module" src="/workspace-test.js"></script>` }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.route("**/workspaces/workspace/files?**", (route) => route.fulfill({ contentType: "text/html", body: tree }));
    await page.route("**/workspaces/workspace/files-view/open?**", (route) => route.fulfill({ contentType: "text/html", body: editor }));
    await page.route("**/workspaces/workspace/files-view/content?**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ path: "/work/README.md", content: "# Readme", revision: "one", writable: true }) }));
    await page.goto("http://atelier.test/");
    await page.getByRole("treeitem", { name: /README.md/ }).click();
    expect(await page.locator(".files-workbench").getAttribute("class")).not.toContain("is-files-pane-open");
    await page.locator('.file-editor-path[title="/work/README.md"]').waitFor();
    await page.close();
  });

  test("keeps a single file row compact within a tall Files tree", async () => {
    const page = await newTestPage();
    const tree = renderFilesTreeFrame("workspace", "workspace", [{ name: "README.md", path: "/work/README.md", kind: "file", size: 20, openable: true }]);
    await page.setContent(`<style>${workspaceStyle}\n${filesStyle}</style><div style="height: 300px">${tree}</div>`);
    const treeBox = await page.getByRole("tree").boundingBox();
    const rowBox = await page.getByRole("treeitem").boundingBox();
    expect(treeBox).not.toBeNull();
    expect(rowBox).not.toBeNull();
    expect(rowBox!.height).toBeLessThan(treeBox!.height / 2);
    await page.close();
  });

  test("does not shift a long-running button while its state changes", async () => {
    const page = await newTestPage();
    await page.setContent(`<style>${workspaceStyle}</style>
      <button id="progress" class="button primary progress-button" data-progress-state="initial" style="--button-progress: 1">
        <svg class="progress-button__perimeter" aria-hidden="true"><rect pathLength="100"/></svg>
        <span class="progress-button__content" data-progress-content="initial">Download</span>
        <span class="progress-button__content" data-progress-content="in-progress"><i class="progress-button__spinner"></i>Downloading workspace…</span>
        <span class="progress-button__content" data-progress-content="finish">Downloaded</span>
      </button>`);
    const button = page.locator("#progress");
    const initial = await button.boundingBox();

    await button.evaluate((element) => { element.setAttribute("data-progress-state", "in-progress"); });
    const inProgress = await button.boundingBox();
    await button.evaluate((element) => { element.setAttribute("data-progress-state", "finish"); });
    const finish = await button.boundingBox();

    expect({ width: inProgress?.width, height: inProgress?.height }).toEqual({ width: initial?.width, height: initial?.height });
    expect({ width: finish?.width, height: finish?.height }).toEqual({ width: initial?.width, height: initial?.height });
    await page.close();
  });

  test("opens the next and previous workspace with keyboard shortcuts", async () => {
    const presentations: WorkspacePresentation[] = ["first", "second", "third"].map((id) => ({
      workspace: { id, title: id },
      agentConversations: [{ id: `agent-${id}`, title: "Agent", bodyHtml: "<p>Agent</p>" }],
      workViews: [],
    }));
    const pane: WorkspacePanePresentation = {
      projects: [],
      projectlessWorkspaces: presentations.map(({ workspace }, index) => ({ ...workspace, active: index === 0 })),
    };
    const shell = renderShellFixture(presentations[0]!, pane, presentations.slice(1))
      .replace('data-controller="workspace-navigation"', 'data-controller="atelier-shortcuts workspace-navigation"');
    const page = await newTestPage();
    await page.route("http://atelier.test/", (route) => route.fulfill({
      contentType: "text/html",
      body: `${shell}<script type="module" src="/workspace-test.js"></script>`,
    }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.route("**/active", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");

    const pressShortcut = async (key: string, code: string) => {
      await page.locator("body").dispatchEvent("keydown", { key, code, metaKey: true, altKey: true, bubbles: true, cancelable: true });
    };
    await pressShortcut(".", "Period");
    await page.waitForFunction(() => document.querySelector('[data-workspace-entry-id="second"]')?.classList.contains("active"));
    await pressShortcut(",", "Comma");
    await page.waitForFunction(() => document.querySelector('[data-workspace-entry-id="first"]')?.classList.contains("active"));
    await page.close();
  });

  test("force deletes the visible workspace with Command-Option-Shift-Backspace", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "force-delete-me", title: "Force delete me" },
      agentConversations: [{ id: "agent-force-delete", title: "Agent", bodyHtml: "<p>Agent</p>" }],
      workViews: [],
    };
    const pane: WorkspacePanePresentation = {
      projects: [],
      projectlessWorkspaces: [{ id: "force-delete-me", title: "Force delete me", active: true }],
    };
    const shell = renderShellFixture(presentation, pane)
      .replace('data-controller="workspace-navigation"', 'data-controller="atelier-shortcuts workspace-navigation"');
    const page = await newTestPage();
    await page.route("http://atelier.test/workspaces/force-delete-me", (route) => route.fulfill({
      contentType: "text/html",
      body: `${shell}<script type="module" src="/workspace-test.js"></script>`,
    }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.route("**/workspaces/force-delete-me/delete?force=1", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/workspaces/force-delete-me");

    const requestPromise = page.waitForRequest((request) => new URL(request.url()).pathname === "/workspaces/force-delete-me/delete");
    await page.locator("body").dispatchEvent("keydown", {
      key: "Backspace",
      code: "Backspace",
      metaKey: true,
      altKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    const request = await requestPromise;

    expect(request.method()).toBe("POST");
    expect(new URL(request.url()).searchParams.get("force")).toBe("1");
    await page.close();
  });

  test("positions a selected Agent transcript at the latest user message while its navigation button still targets the latest message", async () => {
    const agentBody = `<div class="agent-pane" data-controller="agent-pane" data-agent-pane-workspace-id-value="selected" data-agent-pane-label-value="Agent 1">
      <div class="agent-transcript" id="selected_agent_transcript" data-agent-pane-target="transcript" style="height: 200px; overflow-y: auto">
        <div class="agent-item" style="height: 600px">Earlier messages</div>
        <div class="agent-item" data-latest-user-message style="height: 200px"><div class="agent-user">Latest user message</div></div>
        <div class="agent-item" data-latest-message style="height: 200px">Latest assistant message</div>
        <div class="agent-notices" style="height: 400px"></div>
      </div>
      <div class="composer agent-pane-composer">
        <button type="button" data-agent-pane-target="transcriptNav" data-action="agent-pane#jumpToLatestMessage"></button>
        <form data-agent-pane-target="form"><textarea data-agent-pane-target="input"></textarea><button class="agent-sendstop" data-agent-pane-target="sendStop" data-agent-busy="false"></button></form>
      </div>
    </div>`;
    const presentation: WorkspacePresentation = {
      workspace: { id: "selected", title: "Selected" },
      agentConversations: [{ id: "agent-selected", title: "Agent", bodyHtml: "<p>Agent is loading…</p>" }],
      workViews: [],
    };
    const other: WorkspacePresentation = {
      workspace: { id: "other", title: "Other" },
      agentConversations: [{ id: "agent-other", title: "Agent", bodyHtml: "<p>Other Agent</p>" }],
      workViews: [],
    };
    const pane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [
      { id: "selected", title: "Selected", active: true },
      { id: "other", title: "Other" },
    ] };
    const page = await newTestPage();
    await page.route("http://atelier.test/", (route) => route.fulfill({
      contentType: "text/html",
      body: `${renderShellFixture(presentation, pane, [other])}<script>
        window.AtelierCable = {
          subscribe(_identifier, options) { window.agentCableSynchronized = options?.onSynchronized; },
          unsubscribe() {},
          connected() { return true; },
        };
      </script><script type="module" src="/workspace-test.js"></script>`,
    }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.route("**/active", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");
    await page.locator('.workspace-detail-resident.visible .fixed-shell-live-body').evaluate((body, html) => { body.innerHTML = html; }, agentBody);

    await page.waitForFunction(() => {
      const transcript = document.querySelector<HTMLElement>(".agent-transcript");
      const latestUser = document.querySelector<HTMLElement>("[data-latest-user-message]");
      if (!transcript || !latestUser) return false;
      return Math.abs(latestUser.getBoundingClientRect().top - transcript.getBoundingClientRect().top) < 1;
    }, undefined, { timeout: 2_000 });
    const transcript = page.locator(".agent-transcript");
    expect(await transcript.evaluate((element) => element.scrollTop)).toBe(600);

    await page.locator('[data-agent-pane-target="transcriptNav"]').click();
    await page.waitForFunction(() => document.querySelector<HTMLElement>(".agent-transcript")?.scrollTop === 800);

    await transcript.evaluate((element) => { element.scrollTop = 0; });
    await page.locator('[data-workspace-entry-id="other"]').click();
    await page.locator('[data-workspace-entry-id="selected"]').click();
    await page.waitForFunction(() => document.querySelector<HTMLElement>(".agent-transcript")?.scrollTop === 600);
    expect(await transcript.evaluate((element) => element.scrollTop)).toBe(600);

    await page.evaluate(async () => {
      window.Turbo?.renderStreamMessage(`<turbo-stream action="update" target="selected_agent_transcript"><template>
        <div class="agent-item" style="height: 800px">Refreshed earlier messages</div>
        <div class="agent-item" data-latest-user-message style="height: 200px"><div class="agent-user">Latest user message</div></div>
        <div class="agent-item" data-latest-message style="height: 200px">Latest assistant message</div>
        <div class="agent-notices" style="height: 400px"></div>
      </template></turbo-stream>`);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      // SAFETY: This fixture installs the synchronization callback before loading the application.
      (window as typeof window & { agentCableSynchronized?(): void }).agentCableSynchronized?.();
    });
    await page.waitForFunction(() => document.querySelector<HTMLElement>(".agent-transcript")?.scrollTop === 800);
    expect(await transcript.evaluate((element) => element.scrollTop)).toBe(800);
    await page.close();
  });

  test("enhances native selects with anchored design-system popup menus", async () => {
    const page = await newTestPage({ viewport: { width: 360, height: 300 } });
    await page.route("http://atelier.test/", (route) => route.fulfill({
      contentType: "text/html",
      body: `<style>${workspaceStyle}</style><form style="position:fixed;right:4px;bottom:4px"><select class="popup-select" data-popup-select-opens-above="true" aria-label="Thinking level"><option>low</option><option selected>medium</option><option>high</option></select></form><script type="module" src="/workspace-test.js"></script>`,
    }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.goto("http://atelier.test/");

    const trigger = page.locator(".popup-select-trigger");
    await trigger.waitFor();
    const before = (await trigger.boundingBox())!;
    await trigger.click();
    const menu = page.locator(".popup-menu[data-popup-select-menu]");
    expect(await menu.isVisible()).toBe(true);
    expect(await menu.locator(".action-item").count()).toBe(3);
    expect(await menu.locator('[aria-checked="true"]').textContent()).toBe("medium");
    const menuBox = (await menu.boundingBox())!;
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.y).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(360);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(300);
    expect(await trigger.boundingBox()).toEqual(before);

    await menu.getByText("high", { exact: true }).click();
    expect(await page.locator("select").inputValue()).toBe("high");
    expect(await trigger.textContent()).toContain("high");
    expect(await menu.isHidden()).toBe(true);

    await page.close();
  });

  test("automatically scrolls only clipped Action Item labels while hovered or focused", async () => {
    const current: WorkspacePresentation = {
      workspace: { id: "short", title: "Short" },
      agentConversations: [{ id: "agent-short", title: "Agent", bodyHtml: "<p>Agent</p>" }],
      workViews: [],
    };
    const pane: WorkspacePanePresentation = {
      projects: [],
      projectlessWorkspaces: [
        { id: "short", title: "Short", active: true },
        { id: "long", title: "A workspace name that is much too long for this narrow sidebar" },
      ],
    };
    const page = await newTestPage({ reducedMotion: "no-preference" });
    await page.route("http://atelier.test/", (route) => route.fulfill({
      contentType: "text/html",
      body: `<style>${workspaceStyle}</style><style>.fixed-shell-app { --fixed-workspace-width: 150px; width: 700px; height: 500px; }</style>${renderShellFixture(current, pane)}<script type="module" src="/workspace-test.js"></script>`,
    }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.route("**/workspaces/short/active", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/");

    const shortRow = page.locator('[data-workspace-entry-id="short"]');
    await shortRow.hover();
    expect(await shortRow.evaluate((row) => row.classList.contains("is-label-scrolling"))).toBe(false);

    const longRow = page.locator('[data-workspace-entry-id="long"]');
    await longRow.hover();
    expect(await longRow.evaluate((row) => row.classList.contains("is-label-scrolling"))).toBe(true);
    expect(await longRow.locator(".action-item__label-text").evaluate((name) => ({
      name: getComputedStyle(name).animationName,
      timing: getComputedStyle(name).animationTimingFunction,
    }))).toEqual({ name: "action-item-label-scroll", timing: "linear" });

    await longRow.focus();
    await page.mouse.move(600, 400);
    expect(await longRow.evaluate((row) => row.classList.contains("is-label-scrolling"))).toBe(false);

    await shortRow.focus();
    await longRow.focus();
    expect(await longRow.evaluate((row) => row.classList.contains("is-label-scrolling"))).toBe(true);
    await shortRow.focus();
    expect(await longRow.evaluate((row) => row.classList.contains("is-label-scrolling"))).toBe(false);
    await page.close();
  });

  test("shows unread only after the workspace resident has preloaded", async () => {
    const current: WorkspacePresentation = {
      workspace: { id: "a", title: "Current" },
      agentConversations: [{ id: "agent-a", title: "Agent", bodyHtml: "<p>Current</p>" }],
      workViews: [],
    };
    const pane: WorkspacePanePresentation = {
      projects: [],
      projectlessWorkspaces: [
        { id: "a", title: "Current", active: true },
        { id: "b", title: "Unread", unreadAt: 123 },
      ],
    };
    let finishPreload!: () => void;
    const preloadBlocked = new Promise<void>((resolve) => { finishPreload = resolve; });
    const page = await newTestPage();
    await page.route("http://atelier.test/", (route) => route.fulfill({
      contentType: "text/html",
      body: `<style>${workspaceStyle}</style>${renderShellFixture(current, pane)}<script type="module" src="/workspace-test.js"></script>`,
    }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.route("**/workspaces/a/active", (route) => route.fulfill({ status: 204 }));
    await page.route("**/workspaces/b?resident=1", async (route) => {
      await preloadBlocked;
      await route.fulfill({ contentType: "text/html", body: '<div class="workspace-detail-resident visible" data-workspace-residency-target="resident" data-workspace-id="b">Preloaded unread workspace</div>' });
    });
    await page.goto("http://atelier.test/");

    const unread = page.locator('[data-workspace-entry-id="b"]');
    await unread.locator(".workspace-preload-spinner").waitFor();
    expect(await unread.locator('[aria-label="Agent ready"]').isVisible()).toBe(false);

    finishPreload();
    await page.waitForFunction(() => Boolean(document.querySelector('.workspace-detail-resident[data-workspace-id="b"]')));
    await unread.locator('[aria-label="Agent ready"]').waitFor({ state: "visible" });
    expect(await unread.getAttribute("data-workspace-preloading")).toBeNull();
    await page.close();
  });

  test("synchronizes a cached unread Agent transcript before showing its unread dot", async () => {
    const current: WorkspacePresentation = {
      workspace: { id: "a", title: "Current" },
      agentConversations: [{ id: "agent-a", title: "Agent", bodyHtml: "<p>Current</p>" }],
      workViews: [],
    };
    const cachedAgent = `<div class="agent-pane" data-controller="agent-pane" data-agent-pane-workspace-id-value="b" data-agent-pane-label-value="Agent">
      <div class="agent-transcript" id="b_agent_transcript" data-agent-pane-target="transcript">Old transcript</div>
      <div class="composer"><button data-agent-pane-target="transcriptNav"></button><form data-agent-pane-target="form"><textarea data-agent-pane-target="input"></textarea><button class="agent-sendstop" data-agent-pane-target="sendStop" data-agent-busy="false"></button></form></div>
    </div>`;
    const cached: WorkspacePresentation = {
      workspace: { id: "b", title: "Cached" },
      agentConversations: [{ id: "agent-b", title: "Agent", bodyHtml: cachedAgent }],
      workViews: [],
    };
    const initialPane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [
      { id: "a", title: "Current", active: true },
      { id: "b", title: "Cached" },
    ] };
    const unreadPane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [
      { id: "a", title: "Current", active: true },
      { id: "b", title: "Cached", unreadAt: 123 },
    ] };
    const page = await newTestPage();
    await page.route("http://atelier.test/", (route) => route.fulfill({
      contentType: "text/html",
      body: `${renderShellFixture(current, initialPane, [cached])}<script>
        window.AtelierCable = {
          subscribe(_identifier, options) { window.finishCachedAgentSync = () => {
            window.Turbo.renderStreamMessage('<turbo-stream action="update" target="b_agent_transcript"><template>New transcript</template></turbo-stream>');
            requestAnimationFrame(() => options.onSynchronized());
          }; },
          unsubscribe() {},
          connected() { return true; },
        };
      </script><script type="module" src="/workspace-test.js"></script>`,
    }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.route("**/active", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");

    await page.evaluate((stream) => window.Turbo!.renderStreamMessage(stream), workspacePaneCollectionsTurboStream(unreadPane));
    const unread = page.locator('[data-workspace-entry-id="b"]');
    await page.waitForFunction(() => document.querySelector('[data-workspace-entry-id="b"]')?.hasAttribute("data-workspace-preloading"));
    expect(await unread.locator('[aria-label="Agent ready"]').isVisible()).toBe(false);
    expect(await page.locator("#b_agent_transcript").textContent()).toBe("Old transcript");

    await page.evaluate(() => {
      // SAFETY: This test fixture installs the synchronization callback before the assertion reaches this point.
      (window as typeof window & { finishCachedAgentSync(): void }).finishCachedAgentSync();
    });
    await page.waitForFunction(() => !document.querySelector('[data-workspace-entry-id="b"]')?.hasAttribute("data-workspace-preloading"));
    expect(await unread.locator('[aria-label="Agent ready"]').count()).toBe(1);
    expect(await page.locator("#b_agent_transcript").textContent()).toBe("New transcript");
    await page.close();
  });

  test("selects the Workspace requested by a creation stream", async () => {
    const first: WorkspacePresentation = {
      workspace: { id: "first", title: "First" },
      agentConversations: [{ id: "agent-1", title: "Agent", bodyHtml: "<p>First Agent</p>" }],
      workViews: [],
    };
    const created: WorkspacePresentation = {
      workspace: { id: "created", title: "Created" },
      agentConversations: [{ id: "agent-2", title: "Agent", bodyHtml: "<p>Created Agent</p>" }],
      workViews: [],
    };
    const pane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [
      { id: "first", title: "First", active: true },
      { id: "created", title: "Created" },
    ] };
    const page = await newTestPage();
    await page.route("http://atelier.test/", (route) => route.fulfill({ contentType: "text/html", body: `${renderShellFixture(first, pane, [created])}<script type="module" src="/workspace-test.js"></script>` }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.route("**/active", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");

    await page.evaluate(() => window.Turbo!.renderStreamMessage('<turbo-stream action="select-workspace" target="workspace_detail" data-workspace-id="created"></turbo-stream>'));
    await page.waitForFunction(() => document.querySelector('.workspace-detail-resident[data-workspace-id="created"]')?.classList.contains("visible"));

    expect(new URL(page.url()).pathname).toBe("/workspaces/created");
    expect(await page.locator('[data-workspace-entry-id="created"]').getAttribute("aria-current")).toBe("page");
    await page.close();
  });

  test("detects and selects a Turbo-added workspace without URL navigation", async () => {
    const page = await newTestPage();
    await page.setContent(`<div id="workspace_entries">
      <button class="fixed-shell-workspace-row" data-workspace-entry-id="existing">Existing</button>
    </div><div id="workspace_detail"></div>`);
    await page.locator("#workspace_entries").evaluate((rows) => {
      rows.addEventListener("click", (event) => {
        // SAFETY: The test fixture controls this value and establishes the asserted shape.
        const entry = (event.target as Element).closest<HTMLElement>("[data-workspace-entry-id]");
        if (!entry) return;
        const id = entry.dataset.workspaceEntryId!;
        setTimeout(() => document.querySelector("#workspace_detail")!.insertAdjacentHTML("beforeend", `<div data-workspace-residency-target="resident" data-workspace-id="${id}">Loaded ${id}</div>`), 20);
      });
    });
    const originalUrl = page.url();

    const workspace = await atelierUi.waitForNewWorkspace(page, async () => {
      await page.evaluate(() => setTimeout(() => document.querySelector("#workspace_entries")!.insertAdjacentHTML("beforeend", '<button class="fixed-shell-workspace-row" data-workspace-entry-id="created">Created</button>'), 20));
    });

    expect(workspace.id).toBe("created");
    expect(await workspace.row.getAttribute("data-workspace-entry-id")).toBe("created");
    expect(page.url()).toBe(originalUrl);
    await workspace.select();
    expect(await atelierUi.workspaceDetail(page, "created").textContent()).toContain("Loaded created");
    expect(page.url()).toBe(originalUrl);
    await page.close();
  });

  test("selects a touch autocomplete option before iOS WebKit cancels click", async () => {
    const page = await newTestPage();
    await page.route("http://atelier.test/", (route) => route.fulfill({
      contentType: "text/html",
      body: `<div data-controller="agent-completions" data-agent-completions-url-value="/workspaces/demo/agents/Agent%201/completions">
        <div data-agent-completions-target="menu" hidden></div>
        <textarea data-agent-completions-target="input" data-action="input->agent-completions#input"></textarea>
      </div><script type="module" src="/workspace-test.js"></script>`,
    }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.route("**/workspaces/demo/completion-catalog", (route) => route.fulfill({
      contentType: "text/html",
      body: '<div class="agent-completion-menu"><button class="agent-completion-option" data-completion-kind="prompt-template" data-command-trigger="/review">Review</button><button class="agent-completion-option" data-completion-kind="prompt-template" data-command-trigger="/simplify">Simplify</button></div>',
    }));
    await page.goto("http://atelier.test/");

    const input = page.locator("textarea");
    await input.fill("/rev");
    const option = page.locator(".agent-completion-option");
    await option.waitFor();
    expect(await option.count()).toBe(1);
    await option.dispatchEvent("pointerdown", { button: 0, pointerType: "touch" });

    expect(await input.inputValue()).toBe("/review ");
    expect(await option.count()).toBe(0);
    await page.close();
  });

  test("hides an inactive Work view close action after the pointer leaves its tab", async () => {
    const page = await newTestPage({ viewport: { width: 1280, height: 800 } });
    await page.setContent(`<style>${workspaceStyle}</style><button type="button">Agent surface</button><div class="fixed-shell-work-view-selector action-item">
      <button class="action-item__primary" type="button" role="tab" aria-selected="false" tabindex="-1" data-controller="atelier-fullscreen" data-atelier-fullscreen-mode-value="view" data-atelier-fullscreen-view-key-value="server" data-atelier-fullscreen-title-value="Server">Server</button>
      <button class="action-item__action" type="button">Close Server</button>
    </div>`);
    await page.addScriptTag({ content: workspaceClient, type: "module" });
    await page.waitForFunction(() => Boolean(window.Stimulus));

    const agentSurface = page.getByRole("button", { name: "Agent surface" });
    const tab = page.getByRole("tab", { name: "Server" });
    const close = page.getByRole("button", { name: "Close Server" });
    await agentSurface.focus();
    expect(await close.evaluate((button) => getComputedStyle(button).pointerEvents)).toBe("none");

    await tab.hover();
    expect(await close.evaluate((button) => getComputedStyle(button).pointerEvents)).toBe("auto");
    await page.mouse.move(640, 400);

    expect(await agentSurface.evaluate((button) => button.matches(":focus"))).toBe(true);
    expect(await close.evaluate((button) => getComputedStyle(button).pointerEvents)).toBe("none");
    await page.close();
  });

  test("opens and closes a live Browser view with Atelier's fullscreen implementation", async () => {
    const page = await newTestPage();
    await page.setContent(`<style>${workspaceStyle}</style><div data-workspace-id="demo">
      <section class="fixed-shell-work-pane" style="height: 400px">
        <header><div class="fixed-shell-work-view-selectors"><button type="button" data-controller="atelier-fullscreen" data-atelier-fullscreen-mode-value="view" data-atelier-fullscreen-view-key-value="browser-1" data-atelier-fullscreen-title-value="Browser">Browser</button></div></header>
        <div class="fixed-shell-work-bodies"><section class="fixed-shell-live-node is-active" data-workspace-pane-role="work" data-source-work-view-key="browser-1"><button type="button">Preview content</button></section></div>
      </section>
    </div>`);
    await page.addScriptTag({ content: workspaceClient, type: "module" });
    await page.waitForFunction(() => Boolean(window.Stimulus));

    const fullscreen = await atelierUi.openViewFullscreen(page, { viewKey: "browser-1" });
    expect(await atelierUi.workspaceViewPane(page, "browser-1").getAttribute("data-atelier-fullscreen-active")).toBe("true");
    const controls = page.getByRole("toolbar", { name: "Fullscreen controls" });
    expect(await controls.getByText("Browser", { exact: true }).isVisible()).toBe(true);
    const controlsBox = (await controls.boundingBox())!;
    const viewBox = (await atelierUi.workspaceViewPane(page, "browser-1").boundingBox())!;
    expect(viewBox.y).toBeGreaterThanOrEqual(controlsBox.y + controlsBox.height - 1);
    await fullscreen.close();
    await page.close();
  });


  test("removes a deleted Workspace resident so its Agent can no longer be used", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "deleted-demo", title: "Delete me" },
      agentConversations: [{ id: "agent-1", title: "Agent", bodyHtml: '<textarea data-agent-input></textarea>' }],
      workViews: [],
    };
    const pane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [{ id: "deleted-demo", title: "Delete me" }] };
    const page = await newTestPage();
    await page.route("http://atelier.test/workspaces/deleted-demo", (route) => route.fulfill({ contentType: "text/html", body: `${renderShellFixture(presentation, pane)}<script type="module" src="/workspace-test.js"></script>` }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.goto("http://atelier.test/workspaces/deleted-demo");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");

    await page.evaluate(() => window.Turbo!.renderStreamMessage('<turbo-stream action="remove-workspace-resident" target="fixed_workspace_deleted-demo"></turbo-stream>'));

    await page.waitForFunction(() => !document.querySelector("[data-agent-input]"));
    expect(await page.locator("[data-agent-input]").count()).toBe(0);
    expect(await page.locator("[data-workspace-residency-target='empty']").getAttribute("hidden")).toBeNull();
    expect(new URL(page.url()).pathname).toBe("/");
    await page.close();
  });

  test("keeps global mobile navigation available for a provisioning resident", async () => {
    const pane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [{ id: "starting", title: "Starting", active: true, busy: true }] };
    const shell = renderShellResidents(pane, '<div class="workspace-detail-resident workspace-boot visible" data-workspace-residency-target="resident" data-workspace-id="starting"><p>Preparing workspace…</p></div>');
    const page = await newTestPage({ viewport: { width: 390, height: 844 } });
    await page.route("http://atelier.test/workspaces/starting", (route) => route.fulfill({ contentType: "text/html", body: `<style>${workspaceStyle}</style>${shell}<script type="module" src="/workspace-test.js"></script>` }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.route("**/workspaces/starting/active", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/workspaces/starting");

    const workspaceDestination = page.locator("[data-mobile-workspace-destination]");
    expect(await workspaceDestination.isVisible()).toBe(true);
    expect(await page.locator(".fixed-shell-resident-mobile-nav").count()).toBe(0);
    await workspaceDestination.click();
    expect(await page.locator(".fixed-shell-workspace-pane").evaluate((pane) => getComputedStyle(pane).visibility)).toBe("visible");
    expect(await workspaceDestination.getAttribute("aria-expanded")).toBe("true");
    await page.close();
  });

  test("parks the current Workspace on mobile without losing global navigation", async () => {
    const current: WorkspacePresentation = {
      workspace: { id: "park-current", title: "Park current" },
      agentConversations: [{ id: "agent-current", title: "Agent", bodyHtml: "<p>Current Agent</p>" }],
      workViews: [],
    };
    const pane: WorkspacePanePresentation = {
      projects: [],
      projectlessWorkspaces: [{ id: "park-current", title: "Park current", active: true }, { id: "park-next", title: "Park next" }],
    };
    const parkedPane: WorkspacePanePresentation = {
      projects: [],
      projectlessWorkspaces: [{ id: "park-next", title: "Park next" }],
      projectlessParkedWorkspaces: [{ id: "park-current", title: "Park current" }],
    };
    let parkRequests = 0;
    let documentRequests = 0;
    const page = await newTestPage({ viewport: { width: 390, height: 844 } });
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.resourceType() === "document") documentRequests += 1;
    });
    await page.route("http://atelier.test/workspaces/park-current", (route) => route.fulfill({ contentType: "text/html", body: `${renderShellFixture(current, pane)}<script type="module" src="/workspace-test.js"></script>` }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.route("**/workspaces/park-current/park", (route) => {
      expect(route.request().method()).toBe("POST");
      parkRequests += 1;
      return route.fulfill({ contentType: "text/vnd.turbo-stream.html", body: `${workspacePaneCollectionsTurboStream(parkedPane)}${removeWorkspaceResidentTurboStream("park-current")}` });
    });
    await page.route("**/workspaces/park-current/active", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/workspaces/park-current");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");
    const requestsBeforeParking = documentRequests;

    await page.locator('.workspace-detail-resident.visible[data-workspace-id="park-current"] .fixed-shell-park-workspace').evaluate((form: HTMLFormElement) => form.requestSubmit());
    await page.waitForFunction(() => !document.querySelector('.workspace-detail-resident[data-workspace-id="park-current"]'));

    expect(parkRequests).toBe(1);
    expect(documentRequests).toBe(requestsBeforeParking);
    expect(new URL(page.url()).pathname).toBe("/");
    expect(await page.locator('.workspace-detail-resident.visible').count()).toBe(0);
    expect(await page.locator('[data-workspace-residency-target="empty"]').getAttribute("hidden")).toBeNull();
    expect(await page.locator('.workspace-detail-resident[data-workspace-id="park-next"]').count()).toBe(0);
    expect(await page.locator("[data-mobile-workspace-destination]").isVisible()).toBe(true);
    expect(await page.locator("[data-mobile-workspace-destination]").getAttribute("aria-expanded")).toBe("true");
    expect(await page.locator(".fixed-shell-workspace-pane").evaluate((pane) => getComputedStyle(pane).visibility)).toBe("visible");
    expect(await page.getByRole("button", { name: "1 parked" }).count()).toBe(1);
    await page.close();
  });

  test("keeps live Agent and Work nodes mounted while restoring personal navigation", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "fixed-demo", title: "Fixed shell" },
      agentConversations: [
        { id: "agent-1", title: "Plan", bodyHtml: '<textarea data-probe="agent">initial</textarea>' },
        { id: "agent-2", title: "Build", bodyHtml: "<p>Second transcript</p>" },
      ],
      workViews: [
        { key: "terminal:1", label: "Terminal", kind: "resource", mobileDestination: "direct", availability: { phase: "live" }, bodyHtml: '<textarea data-probe="terminal">command</textarea><iframe srcdoc="<p>live</p>"></iframe>', close: { action: "/terminal/close", label: "Terminal" } },
        { key: "files:workspace", label: "Files", kind: "contextual", mobileDestination: "more", attentionSequence: 1, availability: { phase: "live" }, bodyHtml: "<p>Files</p>", close: { action: "/files/close", label: "Files" } },
      ],
    };
    const page = await newTestPage({ viewport: { width: 1440, height: 900 } });
    await page.route("http://atelier.test/", (route) => route.fulfill({ contentType: "text/html", body: `${renderWorkspacePresentation(presentation)}<script type="module" src="/workspace-test.js"></script>` }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.route("**/attention/acknowledge", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");

    expect(await page.locator(".fixed-workspace-presentation").getAttribute("class")).not.toContain("is-work-pane-open");
    const terminalClose = page.locator('[data-work-view-key="terminal:1"] + form');
    const filesClose = page.locator('[data-work-view-key="files:workspace"] + form');
    expect(await terminalClose.isHidden()).toBe(false);
    expect(await filesClose.isHidden()).toBe(false);
    await page.evaluate(() => {
      const agent = document.querySelector<HTMLElement>('[data-workspace-live-node="agent:agent-1"]')!;
      const terminal = document.querySelector<HTMLElement>('[data-workspace-live-node="work:terminal:1"]')!;
      const frame = terminal.querySelector<HTMLIFrameElement>("iframe")!;
      agent.querySelector("textarea")!.value = "unsaved agent draft";
      terminal.querySelector("textarea")!.value = "unsaved command";
      // SAFETY: The test fixture controls this value and establishes the asserted shape.
      (window as typeof window & { fixedProbe?: unknown }).fixedProbe = { agent, terminal, frame, frameWindow: frame.contentWindow };
    });
    await page.locator('[data-work-view-key="files:workspace"]').click({ force: true });
    expect(await terminalClose.isHidden()).toBe(false);
    expect(await filesClose.isHidden()).toBe(false);
    await page.locator('[data-work-view-key="terminal:1"]').click({ force: true });
    await page.locator('[data-agent-conversation-id="agent-2"]').click();
    await page.locator('[data-agent-conversation-id="agent-1"]').click();

    expect(await page.evaluate(() => {
      // SAFETY: The test fixture controls this value and establishes the asserted shape.
      const probe = (window as typeof window & { fixedProbe: { agent: HTMLElement; terminal: HTMLElement; frame: HTMLIFrameElement; frameWindow: Window | null } }).fixedProbe;
      const agent = document.querySelector<HTMLElement>('[data-workspace-live-node="agent:agent-1"]')!;
      const terminal = document.querySelector<HTMLElement>('[data-workspace-live-node="work:terminal:1"]')!;
      const frame = terminal.querySelector<HTMLIFrameElement>("iframe")!;
      return { agent: agent === probe.agent, terminal: terminal === probe.terminal, frame: frame === probe.frame, frameWindow: frame.contentWindow === probe.frameWindow, agentDraft: agent.querySelector("textarea")!.value, terminalDraft: terminal.querySelector("textarea")!.value };
    })).toEqual({ agent: true, terminal: true, frame: true, frameWindow: true, agentDraft: "unsaved agent draft", terminalDraft: "unsaved command" });
    await page.reload();
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");
    expect(await page.locator('[data-work-view-key="terminal:1"]').getAttribute("aria-selected")).toBe("true");
    expect(await page.locator(".fixed-workspace-presentation").getAttribute("class")).toContain("is-work-pane-open");
    await page.close();
  });

  test("gives viewport width changes to Work when it is open and Agent when it is closed", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "width-demo", title: "Pane widths" },
      agentConversations: [{ id: "agent-1", title: "Agent", bodyHtml: "<p>Agent</p>" }],
      workViews: [{ key: "files:workspace", label: "Files", kind: "contextual", mobileDestination: "more", attentionSequence: 1, availability: { phase: "live" }, bodyHtml: "<p>Files</p>" }],
    };
    const pane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [{ id: "width-demo", title: "Pane widths", active: true }] };
    const page = await newTestPage({ viewport: { width: 1440, height: 900 } });
    await page.route("http://atelier.test/", (route) => route.fulfill({ contentType: "text/html", body: `<style>${workspaceStyle}</style>${renderShellFixture(presentation, pane)}<script type="module" src="/workspace-test.js"></script>` }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.route("**/attention/acknowledge", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");

    const widths = () => page.locator(".fixed-shell-workspace-pane, .fixed-shell-agent-pane, .fixed-shell-work-pane").evaluateAll((panes) => panes.map((pane) => pane.getBoundingClientRect().width));
    const openBefore = await widths();
    await page.setViewportSize({ width: 1600, height: 900 });
    const openAfter = await widths();
    expect(openAfter[0]).toBeCloseTo(openBefore[0]!, 0);
    expect(openAfter[1]).toBeCloseTo(openBefore[1]!, 0);
    expect(openAfter[2]! - openBefore[2]!).toBeCloseTo(160, 0);

    await page.getByRole("button", { name: "Collapse Work pane" }).evaluate((button: HTMLButtonElement) => button.click());
    const closedBefore = (await widths()).slice(0, 2);
    await page.setViewportSize({ width: 1400, height: 900 });
    const closedAfter = (await widths()).slice(0, 2);
    expect(closedAfter[0]).toBeCloseTo(closedBefore[0]!, 0);
    expect(closedAfter[1]! - closedBefore[1]!).toBeCloseTo(-200, 0);
    await page.close();
  });

  test("deep links reveal Work only in the visible Workspace and hidden presentations do not acknowledge Attention", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "deep-demo", title: "Deep link" },
      agentConversations: [{ id: "agent-1", title: "Agent", bodyHtml: "<p>Agent</p>" }],
      workViews: [
        { key: "files:workspace", label: "Files", kind: "contextual", mobileDestination: "more", availability: { phase: "live" }, bodyHtml: "<p>Files</p>" },
        { key: "browser:1", label: "Browser", kind: "resource", mobileDestination: "direct", attentionSequence: 1, availability: { phase: "live" }, bodyHtml: "<p>Browser</p>" },
      ],
    };
    const page = await newTestPage({ viewport: { width: 1440, height: 900 } });
    let acknowledgements = 0;
    await page.route("http://atelier.test/workspaces/deep-demo?workView=browser%3A1", (route) => route.fulfill({ contentType: "text/html", body: `<div class="workspace-detail-resident visible">${renderWorkspacePresentation(presentation)}</div><script type="module" src="/workspace-test.js"></script>` }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.route("**/attention/acknowledge", (route) => { acknowledgements += 1; return route.fulfill({ status: 204 }); });
    await page.goto("http://atelier.test/workspaces/deep-demo?workView=browser%3A1");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");
    expect(await page.locator(".fixed-workspace-presentation").getAttribute("class")).toContain("is-work-pane-open");
    expect(await page.locator('[data-work-view-key="browser:1"]').getAttribute("aria-selected")).toBe("true");
    await page.waitForTimeout(20);
    expect(acknowledgements).toBe(1);

    await page.getByRole("tab", { name: "Files" }).click();
    expect(new URL(page.url()).searchParams.has("workView")).toBe(false);
    expect(await page.locator('[data-work-view-key="files:workspace"]').getAttribute("aria-selected")).toBe("true");
    await page.waitForTimeout(20);
    const acknowledgementsBeforeHiding = acknowledgements;

    await page.locator(".workspace-detail-resident").evaluate((resident) => resident.classList.remove("visible"));
    await page.evaluate(() => {
      const target = document.querySelector<HTMLElement>(".fixed-workspace-presentation")!;
      window.Turbo!.renderStreamMessage(`<turbo-stream action="present-work-view" target="${target.id}" data-work-view-key="browser:1"></turbo-stream>`);
    });
    await page.waitForTimeout(20);
    expect(acknowledgements).toBe(acknowledgementsBeforeHiding);
    await page.close();
  });

  test("reveals and focuses an agent-presented Work view when its cached Workspace becomes visible", async () => {
    const pane: WorkspacePanePresentation = { projects: [{ id: "project", title: "Project", workspaces: [
      { id: "visible-demo", title: "Visible", active: true },
      { id: "present-demo", title: "Presented" },
    ] }] };
    const visible: WorkspacePresentation = {
      workspace: { id: "visible-demo", title: "Visible" },
      agentConversations: [{ id: "agent-visible", title: "Agent", bodyHtml: "<p>Visible Agent</p>" }],
      workViews: [],
    };
    const cached: WorkspacePresentation = {
      workspace: { id: "present-demo", title: "Presented" },
      agentConversations: [{ id: "agent-present", title: "Agent", bodyHtml: "<p>Presented Agent</p>" }],
      workViews: [],
    };
    const presented: WorkspacePresentation = {
      ...cached,
      workViews: [
        { key: "files:workspace", label: "Files", kind: "contextual", mobileDestination: "more", attentionSequence: 1, availability: { phase: "live" }, bodyHtml: "<p>Files</p>" },
        { key: "browser:1", label: "Browser", kind: "resource", mobileDestination: "direct", attentionSequence: 2, availability: { phase: "live" }, bodyHtml: "<p>Browser</p>" },
      ],
      preserveLiveKeys: new Set(["agent:agent-present"]),
    };
    const page = await newTestPage({ viewport: { width: 1440, height: 900 } });
    await page.route("http://atelier.test/workspaces/visible-demo", (route) => route.fulfill({ contentType: "text/html", body: `<style>${workspaceStyle}</style>${renderShellFixture(visible, pane, [cached])}<script type="module" src="/workspace-test.js"></script>` }));
    let acknowledgements = 0;
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.route("**/attention/acknowledge", (route) => { acknowledgements += 1; return route.fulfill({ status: 204 }); });
    await page.goto("http://atelier.test/workspaces/visible-demo");
    await page.waitForFunction(() => document.querySelectorAll('[data-navigation-ready="true"]').length === 2);

    const stream = workspacePresentationTurboStream("present-demo", presented);
    await page.evaluate((html) => window.Turbo!.renderStreamMessage(html), stream);
    await page.waitForFunction(() => document.querySelector('.workspace-detail-resident[data-workspace-id="present-demo"] [data-navigation-ready="true"]'));
    const cachedResident = page.locator('.workspace-detail-resident[data-workspace-id="present-demo"]');
    expect(await cachedResident.locator('[data-work-view-key] [aria-label="Attention"]').count()).toBe(2);
    await page.locator('.fixed-shell-workspace-pane [data-workspace-entry-id="present-demo"]').evaluate((button: HTMLButtonElement) => button.click());
    const resident = page.locator('.workspace-detail-resident[data-workspace-id="present-demo"]');
    await page.waitForFunction(() => document.querySelector('.workspace-detail-resident[data-workspace-id="present-demo"]')?.classList.contains("visible"));

    expect(await resident.locator(".fixed-workspace-presentation").getAttribute("class")).toContain("is-work-pane-open");
    const browserPane = resident.locator('[data-workspace-pane-role="work"][data-workspace-pane-id="browser:1"]');
    expect(await browserPane.evaluate((pane) => document.activeElement === pane)).toBe(true);
    await page.waitForTimeout(20);
    expect(acknowledgements).toBe(1);

    const acknowledgedBrowser = { ...presented.workViews[1]! };
    delete acknowledgedBrowser.attentionSequence;
    const acknowledged = workspacePresentationTurboStream("present-demo", {
      ...presented,
      workViews: [presented.workViews[0]!, acknowledgedBrowser],
      preserveLiveKeys: new Set(["agent:agent-present", "work:files:workspace", "work:browser:1"]),
    });
    await page.evaluate((html) => window.Turbo!.renderStreamMessage(html), acknowledged);
    await page.waitForTimeout(20);
    expect(await resident.locator('[data-work-view-key="browser:1"]').getAttribute("aria-selected")).toBe("true");
    expect(acknowledgements).toBe(1);
    await page.close();
  });

  test("expands and collapses the parked Workspace count", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "active", title: "Active" },
      agentConversations: [{ id: "agent-1", title: "Agent", bodyHtml: "<p>Agent content</p>" }],
      workViews: [],
    };
    const pane: WorkspacePanePresentation = {
      projects: [{
        id: "active-project",
        title: "Active project",
        workspaces: [{ id: "active", title: "Active", active: true }, { id: "normal", title: "Normal workspace" }],
        parkedWorkspaces: [{ id: "parked-1", title: "First parked" }, { id: "parked-2", title: "Second parked" }],
      }],
      projectlessWorkspaces: [],
    };
    const parkedPresentation: WorkspacePresentation = {
      workspace: { id: "parked-1", title: "First parked" },
      agentConversations: [{ id: "agent-parked", title: "Agent", bodyHtml: "<p>Unparked Agent content</p>" }],
      workViews: [],
    };
    let unparkRequests = 0;
    const page = await newTestPage({ viewport: { width: 1000, height: 700 } });
    await page.addInitScript(() => localStorage.removeItem("atelier:workspace-project-disclosures"));
    await page.route("http://atelier.test/", (route) => route.fulfill({ contentType: "text/html", body: `<style>${workspaceStyle}</style>${renderShellFixture(presentation, pane)}<script type="module" src="/workspace-test.js"></script>` }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.route("**/workspaces/parked-1/unpark", (route) => {
      expect(route.request().method()).toBe("POST");
      unparkRequests += 1;
      return route.fulfill({ contentType: "text/vnd.turbo-stream.html", body: "" });
    });
    await page.route("**/workspaces/parked-1?resident=1", (route) => route.fulfill({ contentType: "text/html", body: `<div class="workspace-detail-resident" data-workspace-residency-target="resident" data-workspace-id="parked-1">${renderWorkspacePresentation(parkedPresentation)}</div>` }));
    await page.route("**/workspaces/parked-1/active", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");

    const parked = page.locator(".fixed-shell-parked");
    const disclosure = parked.getByRole("button", { name: "2 parked" });
    const parkedWorkspace = parked.getByRole("button", { name: /Unpark and open First parked/ });
    expect(await disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(await parkedWorkspace.isVisible()).toBe(false);

    await disclosure.evaluate((button: HTMLButtonElement) => button.click());
    expect(await disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(await parkedWorkspace.isVisible()).toBe(true);

    await parkedWorkspace.evaluate((button: HTMLButtonElement) => button.click());
    await page.waitForFunction(() => document.querySelector('.workspace-detail-resident.visible[data-workspace-id="parked-1"]'));
    expect(unparkRequests).toBe(1);
    expect(new URL(page.url()).pathname).toBe("/workspaces/parked-1");

    await disclosure.evaluate((button: HTMLButtonElement) => button.click());
    expect(await disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(await parkedWorkspace.isVisible()).toBe(false);
    await page.close();
  });

  test("expands the Projects section and preserves its state across updates", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "used-workspace", title: "Used workspace" },
      agentConversations: [{ id: "agent-1", title: "Agent", bodyHtml: "<p>Agent content</p>" }],
      workViews: [],
    };
    const pane: WorkspacePanePresentation = {
      projects: [{ id: "used-1", title: "Used one", workspaces: [{ id: "used-workspace", title: "Used workspace", active: true }] }],
      projectlessWorkspaces: [],
      emptyProjects: [
        { id: "unused-1", title: "Unused one" },
        { id: "unused-2", title: "Unused two" },
      ],
    };
    const page = await newTestPage({ viewport: { width: 1000, height: 700 } });
    await page.addInitScript(() => localStorage.removeItem("atelier:workspace-project-disclosures"));
    await page.route("http://atelier.test/", (route) => route.fulfill({ contentType: "text/html", body: `<style>${workspaceStyle}</style>${renderShellFixture(presentation, pane)}<script type="module" src="/workspace-test.js"></script>` }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.goto("http://atelier.test/");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");

    const drawer = page.locator(".fixed-shell-projects-drawer");
    const disclosure = drawer.locator(":scope > .fixed-shell-project-heading-row .fixed-shell-project-heading");
    const workspaceScroll = page.locator(".fixed-shell-workspace-scroll");
    const emptyProject = drawer.getByText("Unused one", { exact: true });
    const usedProject = drawer.getByText("Used one", { exact: true });
    expect(await disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(await emptyProject.isVisible()).toBe(false);

    await disclosure.evaluate((button: HTMLButtonElement) => button.click());
    expect(await disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(await emptyProject.isVisible()).toBe(true);
    expect(await usedProject.isVisible()).toBe(true);
    const projectLaunch = drawer.locator('.fixed-shell-project-heading[href="/projects/unused-1/launch-composer"]');
    const projectAdd = projectLaunch.locator("..").locator(".fixed-shell-project-add");
    expect(await projectLaunch.getAttribute("href")).toBe(await projectAdd.getAttribute("href"));
    expect(await projectLaunch.getAttribute("data-turbo-frame")).toBe("launch_composer");

    await workspaceScroll.evaluate((element) => { element.dataset.identityProbe = "kept"; });
    await page.evaluate((html) => window.Turbo!.renderStreamMessage(html), workspacePaneCollectionsTurboStream(pane));
    expect(await workspaceScroll.getAttribute("data-identity-probe")).toBe("kept");
    expect(await disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(await usedProject.isVisible()).toBe(true);

    await disclosure.evaluate((button: HTMLButtonElement) => button.click());
    expect(await disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(await emptyProject.isVisible()).toBe(false);
    await page.close();
  });

  test("keeps the Workspace pane open when selecting a cached Workspace", async () => {
    const makePresentation = (id: string): WorkspacePresentation => ({
      workspace: { id, title: `Workspace ${id}` },
      agentConversations: [{ id: `agent-${id}`, title: "Agent", bodyHtml: `<p>Agent ${id}</p>` }],
      workViews: [],
    });
    const pane: WorkspacePanePresentation = { projects: [{ id: "project", title: "Project", workspaces: [
      { id: "a", title: "Workspace a", active: true },
      { id: "b", title: "Workspace b" },
    ] }] };
    const page = await newTestPage({ viewport: { width: 1000, height: 700 } });
    await page.route("http://atelier.test/workspaces/a", (route) => route.fulfill({ contentType: "text/html", body: `<style>${workspaceStyle}</style>${renderShellFixture(makePresentation("a"), pane, [makePresentation("b")])}<script type="module" src="/workspace-test.js"></script>` }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.goto("http://atelier.test/workspaces/a");
    await page.waitForFunction(() => document.querySelectorAll('[data-navigation-ready="true"]').length === 2);
    const residentB = page.locator('.workspace-detail-resident[data-workspace-id="b"]');

    await page.locator('[data-workspace-entry-id="b"]').evaluate((button: HTMLButtonElement) => button.click());

    await page.waitForFunction(() => document.querySelector('.workspace-detail-resident[data-workspace-id="b"]')?.classList.contains("visible"));
    expect(await page.locator(".fixed-shell-workspace-pane").count()).toBe(1);
    expect(await residentB.locator(".fixed-shell-workspace-pane").count()).toBe(0);
    await page.close();
  });

  test("reveals and collapses the Work pane", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "motion-demo", title: "Motion" },
      agentConversations: [{ id: "agent-1", title: "Agent", bodyHtml: "<p>Agent content</p>" }],
      workViews: [{ key: "browser:1", label: "Browser", kind: "resource", mobileDestination: "direct", availability: { phase: "live" }, bodyHtml: "<p>Browser</p>" }],
    };
    const page = await newTestPage({ viewport: { width: 1440, height: 900 } });
    await page.route("http://atelier.test/", (route) => route.fulfill({ contentType: "text/html", body: `<style>${workspaceStyle}</style>${renderShellFixture(presentation, { projects: [] })}<script type="module" src="/workspace-test.js"></script>` }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.goto("http://atelier.test/");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");
    expect(await page.getByRole("button", { name: "Show Work pane" }).isVisible()).toBe(true);

    await page.getByRole("button", { name: "Show Work pane" }).evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.locator(".fixed-workspace-presentation").getAttribute("class")).toContain("is-work-pane-open");
    expect(await page.getByRole("button", { name: "Collapse Work pane" }).isVisible()).toBe(true);

    await page.getByRole("button", { name: "Collapse Work pane" }).evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.locator(".fixed-workspace-presentation").getAttribute("class")).not.toContain("is-work-pane-open");
    expect(await page.getByRole("button", { name: "Show Work pane" }).isVisible()).toBe(true);
    await page.close();
  });

  test("transplants editor drafts and iframe identity through a Turbo presentation refresh", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "stream-demo", title: "Before" },
      agentConversations: [{ id: "agent-1", title: "Agent", bodyHtml: '<textarea data-probe="draft">draft</textarea>' }],
      workViews: [{ key: "browser:1", label: "Browser", kind: "resource", mobileDestination: "direct", availability: { phase: "live" }, bodyHtml: '<iframe srcdoc="<p>live</p>"></iframe>' }],
    };
    const page = await newTestPage({ viewport: { width: 1440, height: 900 } });
    await page.route("http://atelier.test/", (route) => route.fulfill({ contentType: "text/html", body: `${renderWorkspacePresentation(presentation)}<script type="module" src="/workspace-test.js"></script>` }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.goto("http://atelier.test/");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");
    const stream = workspacePresentationTurboStream("stream-demo", { ...presentation, workspace: { id: "stream-demo", title: "After" }, preserveLiveKeys: new Set(["agent:agent-1", "work:browser:1"]) });
    await page.evaluate((html) => {
      const agent = document.querySelector<HTMLElement>('[data-workspace-live-node="agent:agent-1"]')!;
      const work = document.querySelector<HTMLElement>('[data-workspace-live-node="work:browser:1"]')!;
      const frame = work.querySelector<HTMLIFrameElement>("iframe")!;
      agent.querySelector("textarea")!.value = "unsaved";
      // SAFETY: The test fixture controls this value and establishes the asserted shape.
      (window as typeof window & { streamProbe?: unknown }).streamProbe = { agent, work, frame, frameWindow: frame.contentWindow };
      window.Turbo!.renderStreamMessage(html);
    }, stream);
    await page.waitForFunction(() => document.querySelector(".fixed-shell-workspace-title")?.textContent?.includes("After"));
    expect(await page.evaluate(() => {
      // SAFETY: The test fixture controls this value and establishes the asserted shape.
      const probe = (window as typeof window & { streamProbe: { agent: HTMLElement; work: HTMLElement; frame: HTMLIFrameElement; frameWindow: Window | null } }).streamProbe;
      const agent = document.querySelector<HTMLElement>('[data-workspace-live-node="agent:agent-1"]')!;
      const work = document.querySelector<HTMLElement>('[data-workspace-live-node="work:browser:1"]')!;
      const frame = work.querySelector<HTMLIFrameElement>("iframe")!;
      return { agent: agent === probe.agent, work: work === probe.work, frame: frame === probe.frame, frameWindow: frame.contentWindow === probe.frameWindow, draft: agent.querySelector("textarea")!.value };
    })).toEqual({ agent: true, work: true, frame: true, frameWindow: true, draft: "unsaved" });
    await page.close();
  });

  test("uses fixed mobile destinations and keeps secondary Work views behind More across responsive transitions", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "phone-demo", title: "Phone" },
      agentConversations: [
        { id: "agent-1", title: "First Agent", bodyHtml: '<textarea data-probe="agent">draft</textarea>' },
        { id: "agent-2", title: "Second Agent", bodyHtml: "<p>Second agent</p>" },
      ],
      workViews: [
        { key: "terminal:1", label: "Terminal", kind: "resource", mobileDestination: "direct", availability: { phase: "live" }, bodyHtml: '<textarea data-probe="terminal">command</textarea>', close: { action: "/terminal/close", label: "Terminal Work view" } },
        { key: "files:workspace", label: "Files", kind: "contextual", mobileDestination: "more", attentionSequence: 1, availability: { phase: "live" }, bodyHtml: "<p>Files</p>", close: { action: "/files/close", label: "Files Work view" } },
      ],
      commands: [{ id: "files.create", label: "New Files view", scope: "workspace", placement: "work-launcher" }, { id: "terminal.create", label: "New Terminal", scope: "workspace", placement: "work-launcher" }],
    };
    const page = await newTestPage({ viewport: { width: 390, height: 844 } });
    await page.route("http://atelier.test/", (route) => route.fulfill({ contentType: "text/html", body: `<style>${workspaceStyle}</style>${renderShellFixture(presentation, { projects: [] })}<script type="module" src="/workspace-test.js"></script>` }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.route("**/attention/acknowledge", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");
    const mobileNavigation = page.locator(".fixed-workspace-presentation .fixed-shell-mobile-nav");
    expect(await mobileNavigation.getAttribute("class")).toContain("button-group");
    expect(await mobileNavigation.evaluate((element) => getComputedStyle(element).gap)).toBe("8px");
    const mobileDestinations = mobileNavigation.locator("[data-mobile-destination], [data-mobile-more]");
    expect(await mobileDestinations.evaluateAll((destinations) => destinations.every((destination) => destination.classList.contains("action-item") && destination.classList.contains("action-item__primary")))).toBe(true);
    expect(await mobileNavigation.locator(".fixed-shell-mobile-scroll").getAttribute("class")).toContain("button-group");
    const mobileDestinationHeights = await mobileDestinations.evaluateAll((destinations) => destinations.map((destination) => destination.getBoundingClientRect().height));
    expect(new Set(mobileDestinationHeights).size).toBe(1);
    const workspaceDestination = page.locator("[data-mobile-workspace-destination]");
    await workspaceDestination.evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.locator(".fixed-shell-app").getAttribute("class")).toContain("is-mobile-workspace-pane-open");
    expect(await workspaceDestination.getAttribute("aria-expanded")).toBe("true");
    expect(await page.locator(".fixed-shell-workspace-pane").evaluate((pane) => getComputedStyle(pane).visibility)).toBe("visible");
    await workspaceDestination.evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.locator(".fixed-shell-app").getAttribute("class")).not.toContain("is-mobile-workspace-pane-open");
    expect(await workspaceDestination.getAttribute("aria-expanded")).toBe("false");
    await page.locator('[data-more-work-key="files:workspace"]').evaluate((button: HTMLButtonElement) => button.click());
    const workspaceUpdate = workspacePaneCollectionsTurboStream({ projects: [], projectlessWorkspaces: [{ id: "phone-demo", title: "Phone" }, { id: "new-mobile-workspace", title: "New mobile workspace" }] });
    await page.evaluate((stream) => window.Turbo!.renderStreamMessage(stream), workspaceUpdate);
    await page.getByRole("button", { name: "New mobile workspace", includeHidden: true }).waitFor({ state: "attached" });
    expect(await page.locator('[data-mobile-destination="work:files:workspace"]').count()).toBe(0);
    expect(await page.locator('[data-mobile-more] [aria-label="Hidden Attention"]').count()).toBe(1);
    await page.locator("[data-mobile-more]").evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.getByRole("button", { name: "Close current view" }).count()).toBe(1);
    await page.getByRole("button", { name: "Close More" }).evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.locator(".fixed-shell-more-section").first().locator("button", { hasText: "Files" }).count()).toBe(1);
    expect(await page.locator(".fixed-shell-mobile-fixed, .fixed-shell-mobile-scroll > button").evaluateAll((buttons) => buttons.every((button) => !button.textContent?.trim()))).toBe(true);
    expect(await page.locator('[data-mobile-destination="work:terminal:1"] svg').count()).toBe(1);
    const agentsDestination = page.locator('[data-mobile-destination="agents"]');
    expect(await agentsDestination.count()).toBe(1);
    await agentsDestination.evaluate((button: HTMLButtonElement) => button.click());
    const agentHeader = page.locator(".fixed-shell-agent-pane > header");
    expect(await agentHeader.isVisible()).toBe(true);
    const firstAgentTab = agentHeader.getByRole("tab", { name: "First Agent" });
    expect(await firstAgentTab.isVisible()).toBe(true);
    expect(await firstAgentTab.locator(".action-item__label-text").evaluate((label) => label.scrollWidth <= label.clientWidth)).toBe(true);
    expect(await agentHeader.getByRole("button", { name: "Park workspace" }).isVisible()).toBe(true);
    expect(await agentHeader.getByRole("button", { name: "Delete workspace" }).isVisible()).toBe(true);
    expect(await agentHeader.getByRole("button", { name: "Show Work pane" }).isHidden()).toBe(true);
    await agentHeader.getByRole("tab", { name: "Second Agent" }).evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.locator(".fixed-shell-workspace-pane, .fixed-shell-agent-pane, .fixed-shell-work-pane").evaluateAll((panes) => panes.map((pane) => getComputedStyle(pane).visibility))).toEqual(["hidden", "visible", "hidden"]);
    await page.locator("[data-mobile-more]").evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.getByRole("button", { name: "Close current view" }).count()).toBe(0);
    await page.getByRole("button", { name: "Close More" }).evaluate((button: HTMLButtonElement) => button.click());
    await page.locator('[data-mobile-destination="work:terminal:1"]').evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.locator(".fixed-shell-workspace-pane, .fixed-shell-agent-pane, .fixed-shell-work-pane").evaluateAll((panes) => panes.map((pane) => getComputedStyle(pane).visibility))).toEqual(["hidden", "hidden", "visible"]);
    await agentsDestination.evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.locator('[data-workspace-live-node="agent:agent-2"]').getAttribute("class")).toContain("is-active");
    await page.locator('[data-mobile-destination="work:terminal:1"]').evaluate((button: HTMLButtonElement) => button.click());
    await page.locator("[data-mobile-more]").evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.getByRole("button", { name: "Close current view" }).count()).toBe(1);
    expect(await page.locator(".fixed-shell-more-scrim").count()).toBe(0);
    expect(await page.getByRole("heading", { name: "Secondary Work views" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "Close More" }).isVisible()).toBe(true);
    await page.locator('[data-more-work-key="files:workspace"]').evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.locator(".fixed-workspace-presentation").getAttribute("data-phone-destination")).toBe("work:files:workspace");
    expect(await page.locator("[data-mobile-more]").getAttribute("aria-current")).toBe("page");
    expect(await page.locator('[data-mobile-destination="work:files:workspace"]').count()).toBe(0);
    // SAFETY: The test fixture controls this value and establishes the asserted shape.
    await page.evaluate(() => (window as typeof window & { filesNode?: Element }).filesNode = document.querySelector('[data-workspace-live-node="work:files:workspace"]')!);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.setViewportSize({ width: 390, height: 844 });
    // SAFETY: The test fixture controls this value and establishes the asserted shape.
    expect(await page.evaluate(() => (window as typeof window & { filesNode?: Element }).filesNode === document.querySelector('[data-workspace-live-node="work:files:workspace"]'))).toBe(true);
    await page.close();
  });

  test("closes the LaunchComposer as soon as its prompt is submitted", async () => {
    const page = await newTestPage({ viewport: { width: 390, height: 844 } });
    let finishRequest!: () => void;
    const requestMayFinish = new Promise<void>((resolve) => { finishRequest = resolve; });
    let discardRequests = 0;
    await page.route("http://atelier.test/", (route) => route.fulfill({
      contentType: "text/html",
      body: `<turbo-frame id="launch_composer"><dialog class="launch-composer-dialog" data-controller="launch-composer-dialog" data-launch-composer-dialog-discard-url-value="/draft/discard"><form method="post" action="/launch" data-action="submit->launch-composer-dialog#submit"><textarea name="text">Mobile prompt</textarea><button type="submit">Send prompt</button></form></dialog></turbo-frame><script type="module" src="/workspace-test.js"></script>`,
    }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.route("http://atelier.test/draft/discard", (route) => {
      discardRequests += 1;
      return route.fulfill({ status: 204 });
    });
    await page.route("http://atelier.test/launch", async (route) => {
      await requestMayFinish;
      await route.fulfill({ contentType: "text/vnd.turbo-stream.html", body: '<turbo-stream action="update" target="launch_composer"><template></template></turbo-stream>' });
    });

    await page.goto("http://atelier.test/");
    const dialog = page.locator(".launch-composer-dialog");
    await dialog.waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Send prompt" }).click();

    expect(await dialog.evaluate((element: HTMLDialogElement) => element.open)).toBe(false);
    expect(discardRequests).toBe(0);
    finishRequest();
    await dialog.waitFor({ state: "detached" });
    await page.close();
  });
});
