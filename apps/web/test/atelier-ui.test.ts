import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser } from "@playwright/test";
import { atelierUi } from "../smoke/support/atelier-ui.ts";
import { renderWorkspacePane, renderWorkspacePresentation, workspacePaneCollectionsTurboStream, workspacePresentationTurboStream, type WorkspacePanePresentation, type WorkspacePresentation } from "../src/server/workspace-presentation.ts";

let browser: Browser;
let workspaceClient: string;
let workspaceStyle: string;

function renderShellFixture(presentation: WorkspacePresentation, pane: WorkspacePanePresentation, cached: readonly WorkspacePresentation[] = []): string {
  const residents = [presentation, ...cached].map((resident, index) => `<div class="workspace-detail-resident${index === 0 ? " visible" : ""}" data-workspace-residency-target="resident" data-workspace-id="${resident.workspace.id}">${renderWorkspacePresentation(resident)}</div>`).join("");
  return `<div class="app fixed-shell-app" data-controller="workspace-navigation">${renderWorkspacePane(pane)}<main class="fixed-shell-app-main"><div id="workspace_detail" data-controller="workspace-residency" data-workspace-residency-max-resident-value="5"><div data-workspace-residency-target="empty" hidden></div><div class="workspace-detail-loading" data-workspace-residency-target="loading" hidden></div>${residents}</div></main></div>`;
}

beforeAll(async () => {
  const build = Bun.spawn(["bun", "run", "apps/web/scripts/build-assets.ts"], { cwd: new URL("../../..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
  if (exitCode !== 0) throw new Error(`workspace client build failed:\n${stdout}${stderr}`);
  // SAFETY: The test fixture controls this value and establishes the asserted shape.
  const manifest = await Bun.file(new URL("../public/assets-manifest.json", import.meta.url)).json() as Record<string, string>;
  workspaceClient = await Bun.file(new URL(`../public${manifest["/workspace.js"]}`, import.meta.url)).text();
  workspaceStyle = await Bun.file(new URL("../public/style.css", import.meta.url)).text();
  const executablePath = process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/local/bin/chromium";
  browser = await chromium.launch({ executablePath, headless: true });
});

afterAll(async () => {
  await browser?.close();
});

describe("Atelier Playwright helper", () => {
  test("key locators match the server-rendered contracts", async () => {
    const page = await browser.newPage();
    await page.setContent(`<form aria-label="Add project"></form><form aria-label="Repository"></form>
      <div role="table"><form role="row" aria-label="Add secret"></form></div>
      <form id="agent_launch_form"><textarea aria-label="Describe what you want the agent to do… (optional)"></textarea></form>
      <section data-agent-conversation-source="agent:Agent 1"><textarea data-agent-pane-target="input"></textarea></section>`);

    expect(await atelierUi.newProjectForm(page).count()).toBe(1);
    expect(await atelierUi.projectRepositoryForm(page).count()).toBe(1);
    expect(await atelierUi.newProjectSecretForm(page).count()).toBe(1);
    expect(await atelierUi.agentLaunchPrompt(page).count()).toBe(1);
    expect(await atelierUi.currentAgentPrompt(page, "agent:Agent 1").count()).toBe(1);
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
    const page = await browser.newPage();
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

  test("detects and selects a Turbo-added workspace without URL navigation", async () => {
    const page = await browser.newPage();
    await page.setContent(`<div id="workspaces_table_rows">
      <div data-workspace-id="existing"><a href="/workspaces/existing">Existing</a></div>
    </div><div id="workspace_detail"></div>`);
    await page.locator("#workspaces_table_rows").evaluate((rows) => {
      rows.addEventListener("click", (event) => {
        // SAFETY: The test fixture controls this value and establishes the asserted shape.
        const link = (event.target as Element).closest("a");
        if (!link) return;
        event.preventDefault();
        const id = link.closest<HTMLElement>("[data-workspace-id]")!.dataset.workspaceId!;
        setTimeout(() => document.querySelector("#workspace_detail")!.insertAdjacentHTML("beforeend", `<div data-workspace-residency-target="resident" data-workspace-id="${id}">Loaded ${id}</div>`), 20);
      });
    });
    const originalUrl = page.url();

    const workspace = await atelierUi.waitForNewWorkspace(page, async () => {
      await page.evaluate(() => setTimeout(() => document.querySelector("#workspaces_table_rows")!.insertAdjacentHTML("beforeend", '<div data-workspace-id="created"><a href="/workspaces/created">Created</a></div>'), 20));
    });

    expect(workspace.id).toBe("created");
    expect(await workspace.row.getAttribute("data-workspace-id")).toBe("created");
    expect(page.url()).toBe(originalUrl);
    await workspace.select();
    expect(await atelierUi.workspaceDetail(page, "created").textContent()).toContain("Loaded created");
    expect(page.url()).toBe(originalUrl);
    await page.close();
  });

  test("selects a touch autocomplete option before iOS WebKit cancels click", async () => {
    const page = await browser.newPage();
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

  test("opens and closes a live Browser view with Atelier's fullscreen implementation", async () => {
    const page = await browser.newPage();
    await page.setContent(`<div data-workspace-id="demo">
      <section class="fixed-shell-work-pane">
        <div class="fixed-shell-work-view-selectors"><button type="button" data-controller="atelier-fullscreen" data-atelier-fullscreen-mode-value="view" data-atelier-fullscreen-view-key-value="browser-1" data-atelier-fullscreen-title-value="Browser">Browser</button></div>
        <section class="fixed-shell-live-node is-active" data-workspace-pane-role="work" data-source-work-view-key="browser-1"><button type="button">Preview content</button></section>
      </section>
    </div>`);
    await page.addScriptTag({ content: workspaceClient, type: "module" });
    await page.waitForFunction(() => Boolean(window.Stimulus));

    const fullscreen = await atelierUi.openViewFullscreen(page, { viewKey: "browser-1" });
    expect(await atelierUi.workspaceViewPane(page, "browser-1").getAttribute("data-atelier-fullscreen-active")).toBe("true");
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
    const page = await browser.newPage();
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

  test("keeps live Agent and Work nodes mounted while restoring personal navigation", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "fixed-demo", title: "Fixed shell" },
      agentConversations: [
        { id: "agent-1", title: "Plan", bodyHtml: '<textarea data-probe="agent">initial</textarea>' },
        { id: "agent-2", title: "Build", bodyHtml: "<p>Second transcript</p>" },
      ],
      workViews: [
        { key: "terminal:1", label: "Terminal", kind: "resource", mobileDestination: "direct", availability: { phase: "live" }, bodyHtml: '<textarea data-probe="terminal">command</textarea><iframe srcdoc="<p>live</p>"></iframe>' },
        { key: "files:workspace", label: "Files", kind: "contextual", mobileDestination: "more", attentionSequence: 1, availability: { phase: "live" }, bodyHtml: "<p>Files</p>" },
      ],
    };
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route("http://atelier.test/", (route) => route.fulfill({ contentType: "text/html", body: `${renderWorkspacePresentation(presentation)}<script type="module" src="/workspace-test.js"></script>` }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.route("**/attention/acknowledge", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");

    expect(await page.locator(".fixed-workspace-presentation").getAttribute("class")).not.toContain("is-work-pane-open");
    await page.evaluate(() => {
      const agent = document.querySelector<HTMLElement>('[data-workspace-live-node="agent:agent-1"]')!;
      const terminal = document.querySelector<HTMLElement>('[data-workspace-live-node="work:terminal:1"]')!;
      const frame = terminal.querySelector<HTMLIFrameElement>("iframe")!;
      agent.querySelector("textarea")!.value = "unsaved agent draft";
      terminal.querySelector("textarea")!.value = "unsaved command";
      // SAFETY: The test fixture controls this value and establishes the asserted shape.
      (window as typeof window & { fixedProbe?: unknown }).fixedProbe = { agent, terminal, frame, frameWindow: frame.contentWindow };
    });
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

  test("deep links reveal Work only in the visible Workspace and hidden presentations do not acknowledge Attention", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "deep-demo", title: "Deep link" },
      agentConversations: [{ id: "agent-1", title: "Agent", bodyHtml: "<p>Agent</p>" }],
      workViews: [
        { key: "files:workspace", label: "Files", kind: "contextual", mobileDestination: "more", availability: { phase: "live" }, bodyHtml: "<p>Files</p>" },
        { key: "browser:1", label: "Browser", kind: "resource", mobileDestination: "direct", attentionSequence: 1, availability: { phase: "live" }, bodyHtml: "<p>Browser</p>" },
      ],
    };
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
    expect(await cachedResident.locator("[data-work-view-key] .fixed-shell-attention-dot").count()).toBe(2);
    await page.locator('.fixed-shell-workspace-pane [data-workspace-entry-id="present-demo"]').evaluate((button: HTMLButtonElement) => button.click());
    const resident = page.locator('.workspace-detail-resident[data-workspace-id="present-demo"]');
    await page.waitForFunction(() => document.querySelector('.workspace-detail-resident[data-workspace-id="present-demo"]')?.classList.contains("visible"));

    expect(await resident.locator(".fixed-workspace-presentation").getAttribute("class")).toContain("is-work-pane-open");
    const browserPane = resident.locator('[data-workspace-pane-role="work"][data-workspace-pane-id="browser:1"]');
    expect(await browserPane.evaluate((pane) => document.activeElement === pane)).toBe(true);
    expect(await browserPane.evaluate((pane) => getComputedStyle(pane).outlineStyle)).toBe("none");
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

  test("expands the separate Projects section above Settings", async () => {
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
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.addInitScript(() => localStorage.removeItem("atelier:workspace-project-disclosures"));
    await page.route("http://atelier.test/", (route) => route.fulfill({ contentType: "text/html", body: `<style>${workspaceStyle}</style>${renderShellFixture(presentation, pane)}<script type="module" src="/workspace-test.js"></script>` }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.goto("http://atelier.test/");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");

    const drawer = page.locator(".fixed-shell-projects-drawer");
    const disclosure = drawer.locator(":scope > .fixed-shell-project-heading-row .fixed-shell-project-heading");
    const workspaceScroll = page.locator(".fixed-shell-workspace-scroll");
    const footer = page.locator(".fixed-shell-workspace-pane > footer");
    const emptyProject = drawer.getByText("Unused one", { exact: true });
    const usedProject = drawer.getByText("Used one", { exact: true });
    const drawerLabel = disclosure.getByText("Projects", { exact: true });
    const workspaceProject = page.locator('[data-project-id="used-1"] > .fixed-shell-project-heading-row .fixed-shell-project-heading > span');
    const collapsedDrawer = (await drawer.boundingBox())!;
    const expandedFrom = (await workspaceScroll.boundingBox())!;
    expect(await disclosure.textContent()).toContain("Projects");
    expect(await disclosure.locator(":scope > svg").isVisible()).toBe(false);
    const drawerAdd = drawer.locator(":scope > .fixed-shell-project-heading-row .fixed-shell-project-add");
    const idleDrawerAddStyle = await drawerAdd.evaluate((element) => ({ background: getComputedStyle(element).backgroundColor, shadow: getComputedStyle(element).boxShadow }));
    await disclosure.hover();
    expect(await drawerAdd.evaluate((element) => ({ background: getComputedStyle(element).backgroundColor, shadow: getComputedStyle(element).boxShadow }))).toEqual(idleDrawerAddStyle);
    expect(await disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(await emptyProject.isVisible()).toBe(false);
    expect(collapsedDrawer.y + collapsedDrawer.height).toBe((await footer.boundingBox())!.y);

    await disclosure.evaluate((button: HTMLButtonElement) => button.click());
    const expandedDrawer = (await drawer.boundingBox())!;
    expect(await disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(await emptyProject.isVisible()).toBe(true);
    expect(await usedProject.isVisible()).toBe(true);
    const projectLaunch = drawer.locator('.fixed-shell-project-launch[href="/projects/unused-1/agent-launch"]');
    const projectRow = projectLaunch.locator("..");
    const projectSettings = projectRow.locator(".fixed-shell-project-settings");
    const projectAdd = projectRow.locator(".fixed-shell-project-add");
    expect(await projectLaunch.getAttribute("href")).toBe(await projectAdd.getAttribute("href"));
    expect(await projectLaunch.getAttribute("data-turbo-frame")).toBe("agent_launch_modal");
    await projectLaunch.hover();
    const rowHoverAddStyle = await projectAdd.evaluate((element) => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor, shadow: getComputedStyle(element).boxShadow }));
    await projectAdd.hover();
    expect(rowHoverAddStyle).toEqual(await projectAdd.evaluate((element) => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor, shadow: getComputedStyle(element).boxShadow })));
    await projectSettings.hover();
    expect(await projectAdd.evaluate((element) => ({ background: getComputedStyle(element).backgroundColor, shadow: getComputedStyle(element).boxShadow }))).toEqual(idleDrawerAddStyle);
    expect((await emptyProject.boundingBox())!.x).toBe((await drawerLabel.boundingBox())!.x);
    expect(await emptyProject.evaluate((element) => getComputedStyle(element).color)).toBe(await workspaceProject.evaluate((element) => getComputedStyle(element).color));
    expect(await emptyProject.evaluate((element) => getComputedStyle(element).fontSize)).toBe(await workspaceProject.evaluate((element) => getComputedStyle(element).fontSize));
    expect(await emptyProject.evaluate((element) => getComputedStyle(element).fontWeight)).toBe(await workspaceProject.evaluate((element) => getComputedStyle(element).fontWeight));
    expect(expandedDrawer.height).toBeGreaterThan(collapsedDrawer.height);
    expect((await workspaceScroll.boundingBox())!.height).toBeLessThan(expandedFrom.height);

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

  test("keeps the Workspace pane permanently open on desktop", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "compact-demo", title: "Compact" },
      agentConversations: [{ id: "agent-1", title: "Agent", bodyHtml: '<button data-agent-content>Agent content</button>' }],
      workViews: [],
    };
    const pane: WorkspacePanePresentation = { projects: [{ id: "project-1", title: "Project", workspaces: [
      { id: "compact-demo", title: "Compact", color: "#3b82f6", active: true },
      { id: "ready-demo", title: "Ready", color: "#f97316", ready: true },
      { id: "busy-demo", title: "Busy", color: "#22c55e", busy: true },
    ] }] };
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.route("http://atelier.test/", (route) => route.fulfill({ contentType: "text/html", body: `<style>${workspaceStyle}</style>${renderShellFixture(presentation, pane)}<script type="module" src="/workspace-test.js"></script>` }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.goto("http://atelier.test/");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");

    expect(await page.getByRole("button", { name: /Workspace pane/ }).count()).toBe(0);
    expect(await page.locator(".fixed-shell-workspace-pane > header").count()).toBe(0);
    expect(await page.locator(".fixed-shell-workspace-pane").evaluate((element) => element.getBoundingClientRect().width)).toBe(275);
    expect(await page.locator(".fixed-shell-app").evaluate((element) => {
      const workspace = element.querySelector(".fixed-shell-workspace-pane")!.getBoundingClientRect();
      const agent = element.querySelector(".fixed-shell-agent-pane")!.getBoundingClientRect();
      return { separated: workspace.right < agent.left, radius: getComputedStyle(element.querySelector(".fixed-shell-workspace-pane")!).borderRadius };
    })).toEqual({ separated: true, radius: "14px" });
    expect(await page.locator('.fixed-shell-workspace-row[data-workspace-entry-id="ready-demo"] .fixed-shell-attention-dot').isVisible()).toBe(true);
    expect(await page.locator('.fixed-shell-workspace-row[data-workspace-entry-id="busy-demo"] .fixed-shell-workspace-busy').isVisible()).toBe(true);
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
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
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

  test("reveals Work immediately without reanimating the Workspace pane", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "motion-demo", title: "Motion" },
      agentConversations: [{ id: "agent-1", title: "Agent", bodyHtml: "<p>Agent content</p>" }],
      workViews: [{ key: "browser:1", label: "Browser", kind: "resource", mobileDestination: "direct", availability: { phase: "live" }, bodyHtml: "<p>Browser</p>" }],
    };
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route("http://atelier.test/", (route) => route.fulfill({ contentType: "text/html", body: `<style>${workspaceStyle}</style>${renderShellFixture(presentation, { projects: [] })}<script type="module" src="/workspace-test.js"></script>` }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.goto("http://atelier.test/");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");
    const workspaceBefore = await page.locator(".fixed-shell-workspace-pane").boundingBox();
    expect(await page.locator(".fixed-shell-work-pane").evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0s");
    expect(await page.locator(".fixed-shell-workspace-pane").evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0s");
    expect(await page.locator('[data-show-work-pane]').evaluate((element) => getComputedStyle(element).display)).toBe("grid");
    expect(await page.locator('[data-collapse-work-pane]').evaluate((element) => getComputedStyle(element).display)).toBe("none");
    await page.getByRole("button", { name: "Show Work pane" }).evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.locator(".fixed-workspace-presentation").getAttribute("class")).toContain("is-work-pane-open");
    expect(await page.locator('[data-show-work-pane]').evaluate((element) => getComputedStyle(element).display)).toBe("none");
    expect(await page.locator('[data-collapse-work-pane]').evaluate((element) => getComputedStyle(element).display)).toBe("grid");
    expect(await page.locator(".fixed-shell-work-pane").evaluate((element) => getComputedStyle(element).marginRight)).toBe("0px");
    expect(await page.locator(".fixed-shell-main").evaluate((element) => {
      const agent = element.querySelector(".fixed-shell-agent-pane")!.getBoundingClientRect();
      const work = element.querySelector(".fixed-shell-work-pane")!.getBoundingClientRect();
      return { separated: agent.right < work.left, agentBottom: agent.bottom, workBottom: work.bottom, agentRadius: getComputedStyle(element.querySelector(".fixed-shell-agent-pane")!).borderRadius, workRadius: getComputedStyle(element.querySelector(".fixed-shell-work-pane")!).borderRadius };
    })).toEqual({ separated: true, agentBottom: 892, workBottom: 892, agentRadius: "14px", workRadius: "14px" });
    expect(await page.locator(".fixed-shell-workspace-pane").boundingBox()).toEqual(workspaceBefore);
    await page.getByRole("button", { name: "Collapse Work pane" }).evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.getByRole("button", { name: "Show Work pane" }).isVisible()).toBe(true);
    await page.close();
  });

  test("transplants editor drafts and iframe identity through a Turbo presentation refresh", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "stream-demo", title: "Before" },
      agentConversations: [{ id: "agent-1", title: "Agent", bodyHtml: '<textarea data-probe="draft">draft</textarea>' }],
      workViews: [{ key: "browser:1", label: "Browser", kind: "resource", mobileDestination: "direct", availability: { phase: "live" }, bodyHtml: '<iframe srcdoc="<p>live</p>"></iframe>' }],
    };
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
      agentConversations: [{ id: "agent-1", title: "Agent", bodyHtml: '<textarea data-probe="agent">draft</textarea>' }],
      workViews: [
        { key: "terminal:1", label: "Terminal", kind: "resource", mobileDestination: "direct", availability: { phase: "live" }, bodyHtml: '<textarea data-probe="terminal">command</textarea>', close: { action: "/terminal/close", label: "Terminal Work view" } },
        { key: "files:workspace", label: "Files", kind: "contextual", mobileDestination: "more", attentionSequence: 1, availability: { phase: "live" }, bodyHtml: "<p>Files</p>", close: { action: "/files/close", label: "Files Work view" } },
      ],
      commands: [{ id: "files.open", label: "Files", scope: "workspace", placement: "work-launcher" }, { id: "terminal.create", label: "New Terminal", scope: "workspace", placement: "work-launcher" }],
    };
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.route("http://atelier.test/", (route) => route.fulfill({ contentType: "text/html", body: `<style>${workspaceStyle}</style>${renderShellFixture(presentation, { projects: [] })}<script type="module" src="/workspace-test.js"></script>` }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.route("**/attention/acknowledge", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");
    const workspaceUpdate = workspacePaneCollectionsTurboStream({ projects: [], projectlessWorkspaces: [{ id: "phone-demo", title: "Phone" }, { id: "new-mobile-workspace", title: "New mobile workspace" }] });
    await page.evaluate((stream) => window.Turbo!.renderStreamMessage(stream), workspaceUpdate);
    await page.getByRole("button", { name: "New mobile workspace" }).waitFor();
    expect(await page.locator('[data-mobile-destination="work:files:workspace"]').count()).toBe(0);
    expect(await page.locator("[data-mobile-more] .fixed-shell-attention-dot").count()).toBe(1);
    await page.locator("[data-mobile-more]").evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.getByRole("button", { name: "Close current view" }).count()).toBe(1);
    await page.getByRole("button", { name: "Close More" }).evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.locator(".fixed-shell-more-section").first().locator("button", { hasText: "Files" }).count()).toBe(1);
    expect(await page.locator(".fixed-shell-mobile-fixed, .fixed-shell-mobile-scroll > button").evaluateAll((buttons) => buttons.every((button) => !button.textContent?.trim()))).toBe(true);
    expect(await page.locator('[data-mobile-destination="work:terminal:1"] svg').count()).toBe(1);
    await page.locator('[data-mobile-destination="agent:agent-1"]').evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.locator(".fixed-shell-agent-pane > header").evaluate((element) => getComputedStyle(element).display)).toBe("none");
    expect(await page.locator('[data-workspace-live-node="agent:agent-1"]').getAttribute("class")).toContain("is-active");
    await page.locator("[data-mobile-more]").evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.getByRole("button", { name: "Close current view" }).count()).toBe(0);
    await page.getByRole("button", { name: "Close More" }).evaluate((button: HTMLButtonElement) => button.click());
    await page.locator('[data-mobile-destination="work:terminal:1"]').evaluate((button: HTMLButtonElement) => button.click());
    await page.locator("[data-mobile-more]").evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.getByRole("button", { name: "Close current view" }).count()).toBe(1);
    expect(await page.locator(".fixed-shell-more-scrim").count()).toBe(0);
    expect(await page.getByRole("heading", { name: "Secondary Work views" }).count()).toBe(0);
    const moreBox = await page.locator(".fixed-shell-more-menu").boundingBox();
    const closeBox = await page.getByRole("button", { name: "Close More" }).boundingBox();
    if (!moreBox || !closeBox) throw new Error("More menu close button is not visible");
    expect(closeBox.x).toBeGreaterThan(moreBox.x + moreBox.width / 2);
    expect(closeBox.y).toBeLessThan(moreBox.y + 52);
    expect(closeBox.width).toBeGreaterThanOrEqual(40);
    expect(await page.getByRole("button", { name: "Close More" }).evaluate((element) => getComputedStyle(element).borderRadius)).toBe("10px");
    expect(await page.getByRole("button", { name: "Close More" }).locator("svg").count()).toBe(1);
    await page.locator('[data-more-work-key="files:workspace"]').evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.locator(".fixed-workspace-presentation").getAttribute("data-phone-destination")).toBe("work:files:workspace");
    expect(await page.locator("[data-mobile-more]").getAttribute("class")).toContain("is-active");
    expect(await page.locator('[data-mobile-destination="work:files:workspace"]').count()).toBe(0);
    // SAFETY: The test fixture controls this value and establishes the asserted shape.
    await page.evaluate(() => (window as typeof window & { filesNode?: Element }).filesNode = document.querySelector('[data-workspace-live-node="work:files:workspace"]')!);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.setViewportSize({ width: 390, height: 844 });
    // SAFETY: The test fixture controls this value and establishes the asserted shape.
    expect(await page.evaluate(() => (window as typeof window & { filesNode?: Element }).filesNode === document.querySelector('[data-workspace-live-node="work:files:workspace"]'))).toBe(true);
    await page.close();
  });
});
