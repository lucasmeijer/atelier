import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser } from "@playwright/test";
import { atelierUi } from "../smoke/support/atelier-ui.ts";
import { renderWorkspacePresentation, workspacePresentationTurboStream, type WorkspacePresentation } from "../src/server/workspace-presentation.ts";

let browser: Browser;
let workspaceClient: string;

beforeAll(async () => {
  const build = Bun.spawn(["bun", "run", "apps/web/scripts/build-assets.ts"], { cwd: new URL("../../..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
  if (exitCode !== 0) throw new Error(`workspace client build failed:\n${stdout}${stderr}`);
  const manifest = await Bun.file(new URL("../public/assets-manifest.json", import.meta.url)).json() as Record<string, string>;
  workspaceClient = await Bun.file(new URL(`../public${manifest["/workspace.js"]}`, import.meta.url)).text();
  const executablePath = process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/local/bin/chromium";
  browser = await chromium.launch({ executablePath, headless: true });
});

afterAll(async () => {
  await browser?.close();
});

describe("Atelier Playwright helper", () => {
  test("key locators match the server-rendered contracts", async () => {
    const page = await browser.newPage();
    await page.setContent(`<button type="button">New workspace</button>
      <dialog open><h2>Which project to start from?</h2><a href="#">Add a new project</a><a href="#" aria-label="Edit Demo">Edit</a></dialog>
      <form aria-label="Add project"></form><form aria-label="Repository"></form>
      <div role="table"><form role="row" aria-label="Add secret"></form></div>
      <form id="agent_launch_form"><textarea aria-label="Describe what you want the agent to do… (optional)"></textarea></form>
      <section data-tab-pane="agent:Agent 1"><textarea data-agent-pane-target="input"></textarea></section>`);

    expect(await atelierUi.newWorkspaceButton(page).count()).toBe(1);
    expect(await atelierUi.addProjectLink(page).count()).toBe(1);
    expect(await atelierUi.editProjectLink(page, "Demo").count()).toBe(1);
    expect(await atelierUi.newProjectForm(page).count()).toBe(1);
    expect(await atelierUi.projectRepositoryForm(page).count()).toBe(1);
    expect(await atelierUi.newProjectSecretForm(page).count()).toBe(1);
    expect(await atelierUi.agentLaunchPrompt(page).count()).toBe(1);
    expect(await atelierUi.currentAgentPrompt(page, "agent:Agent 1").count()).toBe(1);
    await page.close();
  });

  test("detects and selects a Turbo-added workspace without URL navigation", async () => {
    const page = await browser.newPage();
    await page.setContent(`<div id="workspaces_table_rows">
      <div data-workspace-id="existing"><a href="/workspaces/existing">Existing</a></div>
    </div><div id="workspace_detail"></div>`);
    await page.locator("#workspaces_table_rows").evaluate((rows) => {
      rows.addEventListener("click", (event) => {
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
      body: `<div data-controller="agent-completions" data-agent-completions-url-value="/completions">
        <div data-agent-completions-target="menu" hidden></div>
        <textarea data-agent-completions-target="input" data-action="input->agent-completions#input"></textarea>
      </div><script type="module" src="/workspace-test.js"></script>`,
    }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.route("**/completions?*", (route) => route.fulfill({
      contentType: "text/html",
      body: '<button class="agent-completion-option" data-completion-kind="prompt-template" data-command-trigger="/review">Review</button>',
    }));
    await page.goto("http://atelier.test/");

    const input = page.locator("textarea");
    await input.fill("/");
    const option = page.locator(".agent-completion-option");
    await option.waitFor();
    await option.dispatchEvent("pointerdown", { button: 0, pointerType: "touch" });

    expect(await input.inputValue()).toBe("/review ");
    expect(await option.count()).toBe(0);
    await page.close();
  });

  test("opens and closes a live Browser tab with Atelier's fullscreen implementation", async () => {
    const page = await browser.newPage();
    await page.route("**/workspaces/demo/view-state", (route) => route.fulfill({ status: 204 }));
    await page.setContent(`<div data-workspace-id="demo">
      <section class="workspace-group">
        <div class="group-tabbar" data-controller="workspace-tabs" data-workspace-tabs-workspace-id-value="demo" data-workspace-tabs-group-id-value="group-1" data-workspace-tabs-initial-tab-value="browser-1">
          <div class="group-tabs"><div class="group-tab visible" data-tab="browser-1"><button type="button" data-controller="atelier-fullscreen" data-atelier-fullscreen-mode-value="tab" data-atelier-fullscreen-tab-key-value="browser-1" data-atelier-fullscreen-title-value="Browser" data-action="click->workspace-tabs#show" data-workspace-tabs-tab-param="browser-1">Browser</button></div></div>
          <details class="group-overflow-menu"><summary>Hidden tabs</summary><div></div></details>
        </div>
        <div class="workspace-panes"><section class="tab-pane visible" data-tab-pane="browser-1"><button type="button">Preview content</button></section></div>
      </section>
    </div>`);
    await page.addScriptTag({ content: workspaceClient, type: "module" });
    await page.waitForFunction(() => Boolean(window.Stimulus));

    const fullscreen = await atelierUi.openTabFullscreen(page, { tabKey: "browser-1" });
    expect(await atelierUi.workspaceTabPane(page, "browser-1").getAttribute("data-atelier-fullscreen-active")).toBe("true");
    await fullscreen.close();
    await page.close();
  });

  test("moves live panes between server-rendered groups without recreating them", async () => {
    const page = await browser.newPage();
    await page.route("http://atelier.test/", (route) => route.fulfill({
      contentType: "text/html",
      body: `<div class="workspace-detail-resident visible" data-workspace-id="demo">
        <div id="workspace_groups_demo" class="workspace-groups" data-controller="workspace-groups" data-workspace-groups-workspace-id-value="demo">
          <section class="workspace-group" data-group-id="left" data-workspace-groups-target="group">
            <div class="group-tabbar" data-controller="workspace-tabs" data-workspace-tabs-workspace-id-value="demo" data-workspace-tabs-group-id-value="left" data-workspace-tabs-initial-tab-value="browser-1">
              <div class="group-tabs"><div class="group-tab visible" data-tab="browser-1"><button type="button" data-action="click->workspace-tabs#show" data-workspace-tabs-tab-param="browser-1">Browser</button></div></div>
              <details class="group-overflow-menu"><summary>Hidden tabs</summary><div></div></details>
            </div>
            <div class="workspace-panes"><section class="tab-pane visible" data-tab-pane="browser-1"><textarea>draft</textarea><iframe srcdoc="<p>live</p>"></iframe></section></div>
          </section>
        </div>
      </div><div id="side_effect"></div><script type="module" src="/workspace-test.js"></script>`,
    }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.goto("http://atelier.test/");
    await page.waitForFunction(() => Boolean(window.Stimulus && window.Turbo));
    await page.waitForFunction(() => document.querySelector("iframe")?.contentDocument?.readyState === "complete");

    await page.evaluate(() => {
      const pane = document.querySelector<HTMLElement>('[data-tab-pane="browser-1"]')!;
      const frame = pane.querySelector<HTMLIFrameElement>("iframe")!;
      (window as typeof window & { layoutProbe?: unknown }).layoutProbe = { pane, frame, frameWindow: frame.contentWindow };
      pane.querySelector("textarea")!.value = "unsaved draft";
      window.Turbo!.renderStreamMessage(`<turbo-stream action="replace-workspace-layout" target="workspace_groups_demo"><template>
        <div id="workspace_groups_demo" class="workspace-groups" data-controller="workspace-groups" data-workspace-groups-workspace-id-value="demo">
          <section class="workspace-group" data-group-id="right" data-workspace-groups-target="group">
            <div class="group-tabbar" data-controller="workspace-tabs" data-workspace-tabs-workspace-id-value="demo" data-workspace-tabs-group-id-value="right" data-workspace-tabs-initial-tab-value="browser-1">
              <div class="group-tabs"><div class="group-tab visible" data-tab="browser-1"><button type="button" data-action="click->workspace-tabs#show" data-workspace-tabs-tab-param="browser-1">Browser</button></div><div class="group-tab muted" data-tab="new"><button type="button" data-action="click->workspace-tabs#show" data-workspace-tabs-tab-param="new">New</button></div></div>
              <details class="group-overflow-menu"><summary>Hidden tabs</summary><div></div></details>
            </div>
            <div class="workspace-panes"><span hidden data-workspace-pane-slot="browser-1" data-visible="true"></span><section class="tab-pane" data-tab-pane="new">New pane</section></div>
          </section>
        </div></template></turbo-stream><turbo-stream action="update" target="side_effect"><template>rendered too</template></turbo-stream>`);
    });

    await page.waitForFunction(() => document.querySelector(".workspace-group")?.getAttribute("data-group-id") === "right" && document.querySelector("#side_effect")?.textContent === "rendered too");
    const preserved = await page.evaluate(() => {
      const probe = (window as typeof window & { layoutProbe: { pane: HTMLElement; frame: HTMLIFrameElement; frameWindow: Window | null } }).layoutProbe;
      const pane = document.querySelector<HTMLElement>('[data-tab-pane="browser-1"]')!;
      const frame = pane.querySelector<HTMLIFrameElement>("iframe")!;
      return {
        oneLayout: document.querySelectorAll("#workspace_groups_demo").length,
        paneIdentity: pane === probe.pane,
        frameIdentity: frame === probe.frame,
        frameWindowIdentity: frame.contentWindow === probe.frameWindow,
        draft: pane.querySelector("textarea")!.value,
        newPane: document.querySelector('[data-tab-pane="new"]')?.textContent,
      };
    });

    expect(preserved).toEqual({ oneLayout: 1, paneIdentity: true, frameIdentity: true, frameWindowIdentity: true, draft: "unsaved draft", newPane: "New pane" });
    await page.close();
  });

  test("navigates the inactive role-fixed presentation without recreating live nodes", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const presentation: WorkspacePresentation = {
      workspace: { id: "fixed-demo", title: "Fixed shell", projectTitle: "Atelier" },
      projects: [{ id: "atelier", title: "Atelier", workspaces: [{ id: "fixed-demo", title: "Fixed shell" }] }],
      agentConversations: [
        { id: "agent-1", title: "Plan", bodyHtml: '<textarea data-probe="draft">initial</textarea>' },
        { id: "agent-2", title: "Build", bodyHtml: '<div data-probe="agent-2">Second transcript</div>' },
      ],
      workViews: [
        { key: "terminal:1", label: "Terminal", kind: "resource", attention: false, availability: { phase: "live" }, bodyHtml: '<textarea data-probe="terminal">command</textarea><iframe srcdoc="<p>terminal</p>"></iframe>' },
        { key: "changes", label: "Changes", kind: "contextual", attention: true, availability: { phase: "live" }, bodyHtml: '<div data-probe="changes">Changes</div>' },
      ],
    };
    await page.route("http://atelier.test/", (route) => route.fulfill({
      contentType: "text/html",
      body: `${renderWorkspacePresentation(presentation)}<script type="module" src="/workspace-test.js"></script>`,
    }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.goto("http://atelier.test/");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");

    await page.evaluate(() => {
      const agent = document.querySelector<HTMLElement>('[data-workspace-live-node="agent:agent-1"]')!;
      const terminal = document.querySelector<HTMLElement>('[data-workspace-live-node="work:terminal:1"]')!;
      const frame = terminal.querySelector<HTMLIFrameElement>("iframe")!;
      agent.querySelector("textarea")!.value = "unsaved agent draft";
      terminal.querySelector("textarea")!.value = "unsaved command";
      (window as typeof window & { fixedProbe?: unknown }).fixedProbe = { agent, terminal, frame, frameWindow: frame.contentWindow };
    });
    await page.locator('[data-work-view-key="changes"]').click();
    await page.locator('[data-agent-tab-id="agent-2"]').click();
    await page.locator('[data-work-view-key="terminal:1"]').click();
    await page.locator('[data-agent-tab-id="agent-1"]').click();

    expect(await page.evaluate(() => {
      const probe = (window as typeof window & { fixedProbe: { agent: HTMLElement; terminal: HTMLElement; frame: HTMLIFrameElement; frameWindow: Window | null } }).fixedProbe;
      const agent = document.querySelector<HTMLElement>('[data-workspace-live-node="agent:agent-1"]')!;
      const terminal = document.querySelector<HTMLElement>('[data-workspace-live-node="work:terminal:1"]')!;
      const frame = terminal.querySelector<HTMLIFrameElement>("iframe")!;
      return {
        agentIdentity: agent === probe.agent,
        terminalIdentity: terminal === probe.terminal,
        frameIdentity: frame === probe.frame,
        frameWindowIdentity: frame.contentWindow === probe.frameWindow,
        agentDraft: agent.querySelector("textarea")!.value,
        terminalDraft: terminal.querySelector("textarea")!.value,
      };
    })).toEqual({ agentIdentity: true, terminalIdentity: true, frameIdentity: true, frameWindowIdentity: true, agentDraft: "unsaved agent draft", terminalDraft: "unsaved command" });
    await page.close();
  });

  test("keeps personal navigation independent while sharing profile preferences", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "client-demo", title: "Client state" },
      projects: [{ id: "project", title: "Project", workspaces: [{ id: "client-demo", title: "Client state" }] }],
      agentConversations: [{ id: "agent-1", title: "Agent", bodyHtml: "<p>Agent</p>" }],
      workViews: [
        { key: "terminal:1", label: "Terminal", kind: "resource", attention: false, availability: { phase: "live" }, bodyHtml: "<p>Terminal</p>" },
        { key: "browser:1", label: "Browser", kind: "resource", attention: false, availability: { phase: "live" }, bodyHtml: "<p>Browser</p>" },
      ],
    };
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route("http://atelier.test/", (route) => route.fulfill({ contentType: "text/html", body: `${renderWorkspacePresentation(presentation)}<script type="module" src="/workspace-test.js"></script>` }));
    await context.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    const first = await context.newPage();
    const second = await context.newPage();
    await Promise.all([first.goto("http://atelier.test/"), second.goto("http://atelier.test/")]);
    await Promise.all([first.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true"), second.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true")]);

    await first.locator('[data-work-view-key="browser:1"]').click();
    expect(await first.locator('[data-work-view-key="browser:1"]').getAttribute("aria-selected")).toBe("true");
    expect(await second.locator('[data-work-view-key="terminal:1"]').getAttribute("aria-selected")).toBe("true");

    await first.locator(".fixed-shell-project-heading").click();
    await second.reload();
    await second.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");
    expect(await second.locator(".fixed-shell-project").getAttribute("class")).toContain("is-collapsed");
    await context.close();
  });

  test("uses one phone surface and reports genuine visibility transitions", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const presentation: WorkspacePresentation = {
      workspace: { id: "phone-demo", title: "Phone" },
      projects: [{ id: "project", title: "Project", workspaces: [{ id: "phone-demo", title: "Phone" }] }],
      agentConversations: [{ id: "agent-1", title: "Agent", bodyHtml: "<p>Agent</p>" }],
      workViews: [
        { key: "terminal:1", label: "Terminal", kind: "resource", attention: false, availability: { phase: "live" }, bodyHtml: "<p>Terminal</p>" },
        { key: "changes", label: "Changes", kind: "contextual", attention: true, availability: { phase: "live" }, bodyHtml: "<p>Changes</p>" },
      ],
    };
    await page.route("http://atelier.test/", (route) => route.fulfill({ contentType: "text/html", body: `${renderWorkspacePresentation(presentation)}<script type="module" src="/workspace-test.js"></script>` }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.goto("http://atelier.test/");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");
    await page.evaluate(() => {
      (window as typeof window & { transitions?: string[] }).transitions = [];
      document.addEventListener("atelier:workspace-pane-visible", (event) => (window as typeof window & { transitions: string[] }).transitions.push(`visible:${(event as CustomEvent).detail.id}`));
      document.addEventListener("atelier:workspace-pane-hidden", (event) => (window as typeof window & { transitions: string[] }).transitions.push(`hidden:${(event as CustomEvent).detail.id}`));
    });

    await page.locator('[data-mobile-destination="work:terminal:1"]').click();
    await page.locator('[data-mobile-destination="more"]').click();
    await page.locator('[data-more-work-key="changes"]').click();

    expect(await page.locator(".fixed-workspace-presentation").getAttribute("data-phone-destination")).toBe("work:changes");
    expect(await page.locator('[data-mobile-contextual-key="changes"]').isVisible()).toBe(true);
    expect(await page.evaluate(() => (window as typeof window & { transitions: string[] }).transitions)).toEqual([
      "hidden:agent-1", "visible:terminal:1", "hidden:terminal:1", "visible:changes",
    ]);
    await page.close();
  });

  test("transplants live nodes through the role-fixed Turbo seam", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const presentation: WorkspacePresentation = {
      workspace: { id: "stream-demo", title: "Before" },
      projects: [],
      agentConversations: [{ id: "agent-1", title: "Agent", bodyHtml: '<textarea data-probe="draft">draft</textarea>' }],
      workViews: [{ key: "terminal:1", label: "Terminal", kind: "resource", attention: false, availability: { phase: "live" }, bodyHtml: '<iframe srcdoc="<p>live</p>"></iframe>' }],
    };
    await page.route("http://atelier.test/", (route) => route.fulfill({ contentType: "text/html", body: `${renderWorkspacePresentation(presentation)}<script type="module" src="/workspace-test.js"></script>` }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.goto("http://atelier.test/");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");
    const next = { ...presentation, workspace: { id: "stream-demo", title: "After" }, preserveLiveKeys: new Set(["agent:agent-1", "work:terminal:1"]) };
    const stream = workspacePresentationTurboStream("stream-demo", next);
    await page.evaluate((html) => {
      const agent = document.querySelector<HTMLElement>('[data-workspace-live-node="agent:agent-1"]')!;
      const terminal = document.querySelector<HTMLElement>('[data-workspace-live-node="work:terminal:1"]')!;
      const frame = terminal.querySelector<HTMLIFrameElement>("iframe")!;
      agent.querySelector("textarea")!.value = "unsaved";
      (window as typeof window & { streamProbe?: unknown }).streamProbe = { agent, terminal, frame, frameWindow: frame.contentWindow };
      window.Turbo!.renderStreamMessage(html);
    }, stream);
    await page.waitForFunction(() => document.querySelector(".fixed-shell-workspace-title")?.textContent?.includes("After"));

    expect(await page.evaluate(() => {
      const probe = (window as typeof window & { streamProbe: { agent: HTMLElement; terminal: HTMLElement; frame: HTMLIFrameElement; frameWindow: Window | null } }).streamProbe;
      const agent = document.querySelector<HTMLElement>('[data-workspace-live-node="agent:agent-1"]')!;
      const terminal = document.querySelector<HTMLElement>('[data-workspace-live-node="work:terminal:1"]')!;
      const frame = terminal.querySelector<HTMLIFrameElement>("iframe")!;
      return { agent: agent === probe.agent, terminal: terminal === probe.terminal, frame: frame === probe.frame, frameWindow: frame.contentWindow === probe.frameWindow, draft: agent.querySelector("textarea")!.value };
    })).toEqual({ agent: true, terminal: true, frame: true, frameWindow: true, draft: "unsaved" });
    await page.close();
  });
});
