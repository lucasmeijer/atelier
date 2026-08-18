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

  test("opens and closes a live Browser tab with Atelier's fullscreen implementation", async () => {
    const page = await browser.newPage();
    await page.setContent(`<div data-workspace-id="demo">
      <section class="fixed-shell-work-pane">
        <div class="fixed-shell-work-tabs"><button type="button" data-controller="atelier-fullscreen" data-atelier-fullscreen-mode-value="tab" data-atelier-fullscreen-tab-key-value="browser-1" data-atelier-fullscreen-title-value="Browser">Browser</button></div>
        <section class="fixed-shell-live-node is-active" data-workspace-pane-role="work" data-source-tab-key="browser-1"><button type="button">Preview content</button></section>
      </section>
    </div>`);
    await page.addScriptTag({ content: workspaceClient, type: "module" });
    await page.waitForFunction(() => Boolean(window.Stimulus));

    const fullscreen = await atelierUi.openTabFullscreen(page, { tabKey: "browser-1" });
    expect(await atelierUi.workspaceTabPane(page, "browser-1").getAttribute("data-atelier-fullscreen-active")).toBe("true");
    await fullscreen.close();
    await page.close();
  });


  test("keeps live Agent and Work nodes mounted while restoring personal navigation", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "fixed-demo", title: "Fixed shell", projectTitle: "Atelier" },
      projects: [{ id: "atelier", title: "Atelier", workspaces: [{ id: "fixed-demo", title: "Fixed shell" }] }],
      agentConversations: [
        { id: "agent-1", title: "Plan", bodyHtml: '<textarea data-probe="agent">initial</textarea>' },
        { id: "agent-2", title: "Build", bodyHtml: "<p>Second transcript</p>" },
      ],
      workViews: [
        { key: "terminal:1", label: "Terminal", kind: "resource", mobileDestination: "direct", attention: false, availability: { phase: "live" }, bodyHtml: '<textarea data-probe="terminal">command</textarea><iframe srcdoc="<p>live</p>"></iframe>' },
        { key: "files:workspace", label: "Files", kind: "contextual", mobileDestination: "more", attention: true, availability: { phase: "live" }, bodyHtml: "<p>Files</p>" },
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
      (window as typeof window & { fixedProbe?: unknown }).fixedProbe = { agent, terminal, frame, frameWindow: frame.contentWindow };
    });
    await page.locator('[data-work-view-key="terminal:1"]').click({ force: true });
    await page.locator('[data-agent-tab-id="agent-2"]').click();
    await page.locator('[data-agent-tab-id="agent-1"]').click();

    expect(await page.evaluate(() => {
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

  test("transplants editor drafts and iframe identity through a Turbo presentation refresh", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "stream-demo", title: "Before" }, projects: [],
      agentConversations: [{ id: "agent-1", title: "Agent", bodyHtml: '<textarea data-probe="draft">draft</textarea>' }],
      workViews: [{ key: "browser:1", label: "Browser", kind: "resource", mobileDestination: "direct", attention: false, availability: { phase: "live" }, bodyHtml: '<iframe srcdoc="<p>live</p>"></iframe>' }],
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
      (window as typeof window & { streamProbe?: unknown }).streamProbe = { agent, work, frame, frameWindow: frame.contentWindow };
      window.Turbo!.renderStreamMessage(html);
    }, stream);
    await page.waitForFunction(() => document.querySelector(".fixed-shell-workspace-title")?.textContent?.includes("After"));
    expect(await page.evaluate(() => {
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
      workspace: { id: "phone-demo", title: "Phone" }, projects: [],
      agentConversations: [{ id: "agent-1", title: "Agent", bodyHtml: '<textarea data-probe="agent">draft</textarea>' }],
      workViews: [
        { key: "terminal:1", label: "Terminal", kind: "resource", mobileDestination: "direct", attention: false, availability: { phase: "live" }, bodyHtml: '<textarea data-probe="terminal">command</textarea>' },
        { key: "files:workspace", label: "Files", kind: "contextual", mobileDestination: "more", attention: true, availability: { phase: "live" }, bodyHtml: "<p>Files</p>" },
      ],
      commands: [{ id: "files.open", label: "Files", scope: "workspace", placement: "work-launcher" }, { id: "terminal.create", label: "New Terminal", scope: "workspace", placement: "work-launcher" }],
    };
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.route("http://atelier.test/", (route) => route.fulfill({ contentType: "text/html", body: `${renderWorkspacePresentation(presentation)}<script type="module" src="/workspace-test.js"></script>` }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.route("**/attention/acknowledge", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");
    expect(await page.locator('[data-mobile-destination="work:files:workspace"]').count()).toBe(0);
    expect(await page.locator("[data-mobile-more] .fixed-shell-attention-dot").count()).toBe(1);
    expect(await page.locator(".fixed-shell-more-section").first().locator("button", { hasText: "Files" }).count()).toBe(1);
    await page.locator('[data-mobile-destination="work:terminal:1"]').click();
    await page.locator("[data-mobile-more]").click();
    await page.locator('[data-more-work-key="files:workspace"]').click();
    expect(await page.locator(".fixed-workspace-presentation").getAttribute("data-phone-destination")).toBe("work:files:workspace");
    expect(await page.locator("[data-mobile-more]").getAttribute("class")).toContain("is-active");
    expect(await page.locator('[data-mobile-destination="work:files:workspace"]').count()).toBe(0);
    await page.evaluate(() => (window as typeof window & { filesNode?: Element }).filesNode = document.querySelector('[data-workspace-live-node="work:files:workspace"]')!);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => (window as typeof window & { filesNode?: Element }).filesNode === document.querySelector('[data-workspace-live-node="work:files:workspace"]'))).toBe(true);
    await page.close();
  });
});
