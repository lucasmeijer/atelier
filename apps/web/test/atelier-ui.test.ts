import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser } from "@playwright/test";
import { parseAssetManifest } from "../src/server/asset-manifest.ts";
import { atelierUi } from "../smoke/support/atelier-ui.ts";

let browser: Browser;
let workspaceClient: string;

beforeAll(async () => {
  const build = Bun.spawn(["bun", "run", "apps/web/scripts/build-assets.ts"], { cwd: new URL("../../..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
  if (exitCode !== 0) throw new Error(`workspace client build failed:\n${stdout}${stderr}`);
  const manifest = parseAssetManifest(await Bun.file(new URL("../public/assets-manifest.json", import.meta.url)).text());
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
});
