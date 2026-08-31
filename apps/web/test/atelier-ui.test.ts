import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { ids as agentIds, renderActiveToolContent, renderTranscriptItem, renderTranscriptItemDetailFrame, type AgentRenderContext } from "../../../packages/agent/src/server/render.ts";
import { renderSlashCommandCatalog } from "../../../packages/agent/src/server/slash-commands.ts";
import { actionItemHtml } from "../../../packages/design-system/src/action-item/action-item-html.ts";
import { destructiveConfirmationHtml } from "../../../packages/design-system/src/destructive-confirmation/destructive-confirmation-html.ts";
import type { ToolView, TranscriptItem } from "../../../packages/agent/src/server/transcript.ts";
import { renderMarkdown } from "../../../packages/markdown/src/index.ts";
import { filesEditorFrameId, renderFilesEditorFrame, renderFilesTreeFrame, renderFilesWorkViewBody } from "../../../packages/files/src/server/render.ts";
import { collectReviewFile, collectReviewIndex, collectReviewStats } from "../../../packages/review/src/server/diff.ts";
import { renderReviewBody, renderReviewFileDetails, renderReviewStatsFrame } from "../../../packages/review/src/server/render.ts";
import type { ReviewComment } from "../../../packages/review/src/server/state.ts";
import { createReviewRepository } from "../../../packages/review/test/support/repository.ts";
import { turboStream } from "../../../packages/shared/src/index.ts";
import { atelierUi } from "../smoke/support/atelier-ui.ts";
import { agentTabsTurboStream, removeWorkspaceResidentTurboStream, renderAgentBodyFrame, renderGlobalMobileNavigation, renderWorkViewBodyFrame, renderWorkspacePane, renderWorkspacePresentation, workViewsTurboStream, workspacePaneCollectionsTurboStream, workspacePreparationInvalidatedTurboStream, type WorkspacePanePresentation, type WorkspacePresentation } from "../src/server/workspace-presentation.ts";
import { buildWebTestAssets, type WebTestAssets } from "./support/web-test-assets.ts";

let browser: Browser;
let testAssets: WebTestAssets;
let workspaceClientPath: string;
let designSystemStyle: string;
let workspaceStyle: string;
let filesStyle: string;
let agentStyle: string;
let catalogueHtml: string;

async function newTestPage(options: { viewport?: { width: number; height: number }; reducedMotion?: "reduce" | "no-preference"; mobile?: boolean } = {}): Promise<Page> {
  const page = options.mobile
    ? await browser.newPage({ viewport: options.viewport, isMobile: true, hasTouch: true })
    : await browser.newPage();
  await testAssets.serve(page);
  await page.route(/\/workspaces\/([^/]+)\/agents\/([^/]+)\/body$/, (route) => {
    const match = new URL(route.request().url()).pathname.match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/body$/)!;
    const workspaceId = decodeURIComponent(match[1]!);
    const conversationId = decodeURIComponent(match[2]!);
    return route.fulfill({ contentType: "text/html", body: renderAgentBodyFrame(workspaceId, conversationId, `<p>Agent ${conversationId}</p>`) });
  });
  if (options.viewport && !options.mobile) await page.setViewportSize(options.viewport);
  if (options.reducedMotion) await page.emulateMedia({ reducedMotion: options.reducedMotion });
  return page;
}

function agentConversation(workspaceId: string, id: string, title = "Agent"): WorkspacePresentation["agentConversations"][number] {
  return { id, title, bodyUrl: `/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(id)}/body` };
}

function agentPaneBody(workspaceId: string, conversationId: string, transcriptHtml = ""): string {
  return `<div class="agent-pane" data-controller="agent-pane" data-agent-pane-workspace-id-value="${workspaceId}" data-agent-pane-conversation-id-value="${conversationId}">
    <div class="agent-transcript" id="${workspaceId}_${conversationId}_transcript" data-agent-pane-target="transcript">${transcriptHtml}</div>
    <div class="composer"><div class="agent-pane-composer-overlays"><div class="agent-transcript-navs"><button class="button icon-only agent-transcript-nav" type="button" aria-label="Jump to beginning of latest message" data-agent-pane-target="transcriptNav" data-action="agent-pane#jumpToLatestMessage"><span aria-hidden="true">↑</span></button></div></div><div class="composer-surface"><form data-agent-pane-target="form"><textarea class="composer-input" name="text" data-agent-pane-target="input" data-action="input->agent-pane#promptChanged"></textarea><button class="agent-sendstop" data-agent-pane-target="sendStop" data-agent-busy="false"></button></form></div></div>
  </div>`;
}

function renderShellResidents(pane: WorkspacePanePresentation, residentsHtml: string): string {
  return `<div class="app fixed-shell-app" data-controller="workspace-navigation">${renderWorkspacePane(pane)}<main class="fixed-shell-app-main"><div id="workspace_detail" data-controller="workspace-residency" data-workspace-residency-max-resident-value="5"><div class="workspace-detail-empty" data-workspace-residency-target="empty" hidden></div><div class="workspace-detail-loading" data-workspace-residency-target="loading" hidden></div>${residentsHtml}</div></main>${renderGlobalMobileNavigation()}</div>`;
}

function renderShellFixture(presentation: WorkspacePresentation, pane: WorkspacePanePresentation, cached: readonly WorkspacePresentation[] = []): string {
  const residents = [presentation, ...cached].map((resident, index) => `<div class="workspace-detail-resident${index === 0 ? " visible" : ""}" data-workspace-residency-target="resident" data-workspace-id="${resident.workspace.id}">${renderWorkspacePresentation(resident)}</div>`).join("");
  return renderShellResidents(pane, residents);
}

async function pressCommandOptionShortcut(page: Page, key: string, code: string): Promise<void> {
  await page.locator("body").evaluate(async (body, event) => {
    body.dispatchEvent(new KeyboardEvent("keydown", event));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }, { key, code, metaKey: true, altKey: true, bubbles: true, cancelable: true });
}

async function newShortcutTestPage(ids: readonly string[], workViews: WorkspacePresentation["workViews"] = []): Promise<Page> {
  const presentations: WorkspacePresentation[] = ids.map((id) => ({
    workspace: { id, title: id },
    agentConversations: [agentConversation(id, `agent-${id}`)],
    workViews,
  }));
  const pane: WorkspacePanePresentation = {
    projects: [],
    projectlessWorkspaces: presentations.map(({ workspace }, index) => ({ ...workspace, active: index === 0 })),
  };
  const shell = renderShellFixture(presentations[0]!, pane, presentations.slice(1))
    .replace('data-controller="workspace-navigation"', 'data-controller="atelier-shortcuts workspace-navigation"');
  const page = await newTestPage();
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  const url = `http://atelier.test/workspaces/${encodeURIComponent(ids[0]!)}`;
  await page.route(url, (route) => route.fulfill({ contentType: "text/html", body: `${shell}<script type="module" src="${workspaceClientPath}"></script>` }));
  await page.route("**/active", (route) => route.fulfill({ status: 204 }));
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");
  return page;
}

beforeAll(async () => {
  testAssets = await buildWebTestAssets();
  workspaceClientPath = testAssets.path("/workspace.js");
  const actionItemStyle = await Bun.file(new URL("../../../packages/design-system/src/action-item/action-item.css", import.meta.url)).text();
  const copyButtonStyle = await Bun.file(new URL("../../../packages/design-system/src/copy-button/copy-button.css", import.meta.url)).text();
  const destructiveConfirmationStyle = await Bun.file(new URL("../../../packages/design-system/src/destructive-confirmation/destructive-confirmation.css", import.meta.url)).text();
  const progressButtonStyle = await Bun.file(new URL("../../../packages/design-system/src/progress-button/progress-button.css", import.meta.url)).text();
  const transientFeedbackStyle = await Bun.file(new URL("../../../packages/design-system/src/transient-feedback/transient-feedback.css", import.meta.url)).text();
  const toggleStyle = await Bun.file(new URL("../../../packages/design-system/src/toggle/toggle.css", import.meta.url)).text();
  designSystemStyle = `${actionItemStyle}\n${copyButtonStyle}\n${destructiveConfirmationStyle}\n${progressButtonStyle}\n${transientFeedbackStyle}\n${toggleStyle}\n${await Bun.file(new URL("../public/design-system.css", import.meta.url)).text()}`;
  const shellStyle = await Bun.file(new URL("../public/style.css", import.meta.url)).text();
  workspaceStyle = `${designSystemStyle}\n${shellStyle}`;
  filesStyle = await Bun.file(new URL("../../../packages/files/src/client/style.css", import.meta.url)).text();
  agentStyle = await Bun.file(new URL("../../../packages/agent/src/client/style.css", import.meta.url)).text();
  catalogueHtml = await Bun.file(new URL("../public/design-system-catalogue.html", import.meta.url)).text();
  const executablePath = process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/local/bin/chromium";
  browser = await chromium.launch({ executablePath, headless: true });
});

afterAll(async () => {
  await browser?.close();
}, 30_000);

describe("Atelier browser behavior", () => {
  test("wraps long inline Markdown code within the transcript", async () => {
    const page = await newTestPage({ viewport: { width: 500, height: 300 } });
    const source = "Before `this_is_a_very_long_inline_identifier_that_cannot_fit_on_one_transcript_line` after.";
    const transcript = `<main class="agent-md" style="width: 260px">${renderMarkdown("inline-code", source)}</main>`;
    await page.setContent(`<style>${designSystemStyle}\n${agentStyle}</style>${transcript}`);

    const geometry = await page.locator(".agent-md code").evaluate((code) => {
      const transcriptRect = code.closest(".agent-md")!.getBoundingClientRect();
      const fragments = [...code.getClientRects()];
      return {
        fragmentCount: fragments.length,
        maxRight: Math.max(...fragments.map((fragment) => fragment.right)),
        transcriptRight: transcriptRect.right,
      };
    });
    expect(geometry.fragmentCount).toBeGreaterThan(1);
    expect(geometry.maxRight).toBeLessThanOrEqual(geometry.transcriptRight);
    await page.close();
  });

  test("copies review comments into the agent composer or clipboard only on request", async () => {
    const comments: ReviewComment[] = [
      { id: "one", path: "apps/web/web.ts", side: "additions", startLine: 14, endLine: 14, snippet: "the selection the user made gets written here", body: "Why are we doing it like this over here" },
      { id: "two", path: "apps/web/web.tests.ts", side: "additions", startLine: 18, endLine: 18, snippet: "the test snippet here", body: "I don't think we need these tests" },
    ];
    const reviewBody = await renderReviewBody("review-copy", { phase: "ready", files: [] }, comments);
    const fixture = `<div class="workspace-detail-resident visible"><div class="fixed-workspace-presentation is-work-pane-open">
      <section class="fixed-shell-surface is-active" data-workspace-pane-role="agent" data-workspace-pane-id="agent-review"><textarea name="text">Existing prompt</textarea></section>
      <section class="fixed-shell-surface is-active" data-workspace-pane-role="work" data-workspace-pane-id="review:workspace"><div class="fixed-shell-live-body">${reviewBody}</div></section>
    </div></div>`;
    const page = await newTestPage();
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://localhost" });
    await page.route("http://localhost/", (route) => route.fulfill({ contentType: "text/html", body: `${fixture}<script type="module" src="${workspaceClientPath}"></script>` }));
    await page.goto("http://localhost/");

    const composer = page.locator('.fixed-shell-surface[data-workspace-pane-role="agent"].is-active textarea[name="text"]');
    expect(await composer.inputValue()).toBe("Existing prompt");
    expect(await page.locator(".review-comment-attachment").count()).toBe(0);
    await page.getByRole("button", { name: "Copy into composer", exact: true }).click();
    const generated = `Context: apps/web/web.ts, line 14, snippet "the selection the user made gets written here"
Comment: Why are we doing it like this over here

Context: apps/web/web.tests.ts, line 18, snippet "the test snippet here"
Comment: I don't think we need these tests`;
    expect(await composer.inputValue()).toBe(`Existing prompt\n\n${generated}`);

    await page.getByRole("button", { name: "Copy review comments to clipboard", exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(generated);
    await page.close();
  });

  test("loads review stats eagerly, then intent-loads and retains each diff", async () => {
    const root = await createReviewRepository();
    try {
      await writeFile(join(root, "changed.ts"), "const after = true;\n");
      const index = await collectReviewIndex(root);
      if (index.phase !== "ready") throw new Error("expected ready review");
      const reviewFile = await collectReviewFile(root, "changed.ts");
      if (!reviewFile) throw new Error("expected review file");
      const reviewBody = renderReviewBody("word-diff", index, []);
      const fileDetails = await renderReviewFileDetails("word-diff", reviewFile, []);
      const statsFrame = renderReviewStatsFrame("word-diff", await collectReviewStats(root, index));
      const fixture = `<div class="workspace-detail-resident visible"><section class="fixed-shell-surface is-active" data-workspace-pane-role="work">${reviewBody}</section></div>`;
      const page = await newTestPage();
      let detailRequests = 0;
      let statsRequests = 0;
      let releaseStats!: () => void;
      const statsPending = new Promise<void>((resolve) => { releaseStats = resolve; });
      await page.route("http://atelier.test/", (route) => route.fulfill({ contentType: "text/html", body: `${fixture}<script type="module" src="${workspaceClientPath}"></script>` }));
      await page.route("http://atelier.test/workspaces/word-diff/review/stats", async (route) => {
        statsRequests += 1;
        await statsPending;
        return route.fulfill({ contentType: "text/html", body: statsFrame });
      });
      await page.route("http://atelier.test/workspaces/word-diff/review/files/changed.ts", (route) => {
        detailRequests += 1;
        return route.fulfill({ contentType: "text/html", body: fileDetails });
      });
      await page.addInitScript(() => localStorage.setItem("atelier.review.collapsed:word-diff", "[]"));
      await page.goto("http://atelier.test/");

      const file = page.locator("details.review-file");
      const toggle = page.getByRole("button", { name: "Word diff", exact: true });
      const wordHighlights = page.locator("diffs-container").locator("[data-diff-span]");
      expect(detailRequests).toBe(0);
      expect(await file.getAttribute("open")).toBeNull();
      expect(await page.locator("diffs-container").count()).toBe(0);
      expect(await file.getByRole("status", { name: "Loading change stats" }).count()).toBe(1);

      releaseStats();
      await file.locator(".review-additions").waitFor({ state: "attached" });
      expect(statsRequests).toBe(1);
      expect(detailRequests).toBe(0);
      expect(await file.getByRole("status", { name: "Loading change stats" }).count()).toBe(0);

      await file.locator("summary").hover();
      await page.locator("diffs-container").waitFor({ state: "attached" });
      expect(detailRequests).toBe(1);
      expect(await file.locator(".review-additions").count()).toBe(1);
      await file.locator("summary").click();
      expect(await toggle.getAttribute("aria-pressed")).toBe("false");
      expect(await wordHighlights.count()).toBe(0);

      await toggle.click();
      expect(await toggle.getAttribute("aria-pressed")).toBe("true");
      await wordHighlights.first().waitFor({ state: "attached" });
      expect(await wordHighlights.first().evaluate((highlight) => getComputedStyle(highlight).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");

      await toggle.click();
      expect(await toggle.getAttribute("aria-pressed")).toBe("false");
      await page.waitForFunction(() => document.querySelector("diffs-container")?.shadowRoot?.querySelectorAll("[data-diff-span]").length === 0);

      await file.locator("summary").click();
      await file.locator("summary").click();
      expect(detailRequests).toBe(1);
      await page.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("toggles long review lines between horizontal scrolling and wrapping", async () => {
    const root = await createReviewRepository();
    try {
      await writeFile(join(root, "changed.ts"), `const message = "${"long-content-".repeat(80)}";\n`);
      const index = await collectReviewIndex(root);
      if (index.phase !== "ready") throw new Error("expected ready review");
      const reviewFile = await collectReviewFile(root, "changed.ts");
      if (!reviewFile) throw new Error("expected review file");
      const reviewBody = renderReviewBody("line-wrapping", index, []);
      const fileDetails = await renderReviewFileDetails("line-wrapping", reviewFile, []);
      const statsFrame = renderReviewStatsFrame("line-wrapping", await collectReviewStats(root, index));
      const fixture = `<div class="workspace-detail-resident visible"><section class="fixed-shell-surface is-active" data-workspace-pane-role="work">${reviewBody}</section></div>`;
      const page = await newTestPage();
      await page.setViewportSize({ width: 700, height: 700 });
      await page.route("http://atelier.test/", (route) => route.fulfill({ contentType: "text/html", body: `${fixture}<script type="module" src="${workspaceClientPath}"></script>` }));
      await page.route("http://atelier.test/workspaces/line-wrapping/review/stats", (route) => route.fulfill({ contentType: "text/html", body: statsFrame }));
      await page.route("http://atelier.test/workspaces/line-wrapping/review/files/changed.ts", (route) => route.fulfill({ contentType: "text/html", body: fileDetails }));
      await page.goto("http://atelier.test/");
      const summary = page.locator("details.review-file summary");
      await summary.hover();
      await page.locator("diffs-container").waitFor({ state: "attached" });
      await summary.click();

      const toggle = page.getByRole("button", { name: "Wrap lines", exact: true });
      const overflow = () => page.locator("diffs-container").locator("pre[data-diff]").getAttribute("data-overflow");
      expect(await toggle.getAttribute("aria-pressed")).toBe("true");
      expect(await overflow()).toBe("wrap");

      await toggle.click();
      expect(await toggle.getAttribute("aria-pressed")).toBe("false");
      expect(await overflow()).toBe("scroll");

      await toggle.click();
      expect(await toggle.getAttribute("aria-pressed")).toBe("true");
      expect(await overflow()).toBe("wrap");
      await page.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("switches the design catalogue between responsive preview platforms", async () => {
    const serveCatalogue = async (page: Page) => {
      await page.route("http://catalogue.test/design-system-catalogue.html**", (route) => route.fulfill({ contentType: "text/html", body: catalogueHtml }));
      await page.route("http://catalogue.test/design-system.css", (route) => route.fulfill({ contentType: "text/css", body: workspaceStyle }));
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
    await page.goto("http://catalogue.test/design-system-catalogue.html?embedded=1");

    const buttonToggle = page.locator("[data-catalogue-button-toggle]");
    const edit = buttonToggle.getByRole("button", { name: "Edit" });
    const preview = buttonToggle.getByRole("button", { name: "Preview" });
    expect(await edit.getAttribute("aria-pressed")).toBe("true");
    await preview.click();
    expect(await edit.getAttribute("aria-pressed")).toBe("false");
    expect(await preview.getAttribute("aria-pressed")).toBe("true");

    await edit.evaluate((element) => {
      element.setAttribute("aria-pressed", "true");
      element.setAttribute("disabled", "");
    });
    await preview.evaluate((element) => element.setAttribute("aria-pressed", "false"));
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

    const submitToggle = page.locator("[data-catalogue-submit-toggle]");
    await submitToggle.getByRole("button", { name: "Off" }).focus();
    const submission = page.waitForRequest("http://catalogue.test/design-system-catalogue.html?enabled=true");
    await page.keyboard.press("ArrowRight");
    expect((await submission).method()).toBe("GET");
    await page.close();
  });

  test("design-system copy buttons write nearby content and confirm success", async () => {
    const page = await newTestPage();
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://localhost" });
    await page.route("http://localhost/design-system-catalogue.html**", (route) => route.fulfill({ contentType: "text/html", body: catalogueHtml }));
    await page.route("http://localhost/design-system.css", (route) => route.fulfill({ contentType: "text/css", body: workspaceStyle }));
    await page.goto("http://localhost/design-system-catalogue.html?embedded=1");

    const copy = page.locator("[data-catalogue-copy] .copy-button");
    await copy.click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("bun run check\nbun test");
    expect(await copy.locator('[data-transient-feedback-content="feedback"] .copy-button__icon').textContent()).toBe("✓");
    expect(await copy.getAttribute("aria-label")).toBe("Copied to clipboard");
    await page.waitForTimeout(2100);
    expect(await copy.locator('[data-transient-feedback-content="initial"] .copy-button__icon').textContent()).toBe("⧉");
    expect(await copy.getAttribute("aria-label")).toBe("Copy example to clipboard");
    await page.close();
  });

  test("server-rendered transient feedback resets when Turbo preserves its controller", async () => {
    const page = await newTestPage();
    await page.route("http://catalogue.test/design-system-catalogue.html**", (route) => route.fulfill({ contentType: "text/html", body: catalogueHtml }));
    await page.route("http://catalogue.test/design-system.css", (route) => route.fulfill({ contentType: "text/css", body: workspaceStyle }));
    await page.goto("http://catalogue.test/design-system-catalogue.html?embedded=1#buttons");

    const feedback = page.locator("#transient-feedback-demo");
    await feedback.evaluate((element) => element.setAttribute("data-transient-feedback-state-value", "feedback"));
    expect(await feedback.getByRole("status").isVisible()).toBe(true);
    await page.waitForTimeout(2100);
    expect(await feedback.getAttribute("data-transient-feedback-state-value")).toBe("initial");
    expect(await feedback.getByRole("button", { name: "Check now" }).isVisible()).toBe(true);
    await page.close();
  });

  test("design-system managed lists filter without caller wiring", async () => {
    const page = await newTestPage();
    await page.route("http://catalogue.test/design-system-catalogue.html**", (route) => route.fulfill({ contentType: "text/html", body: catalogueHtml }));
    await page.route("http://catalogue.test/design-system.css", (route) => route.fulfill({ contentType: "text/css", body: workspaceStyle }));
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
      agentConversations: [agentConversation("popup", "agent")],
      workViews: [],
      commands: [{ id: "files.create", label: "New Files", scope: "workspace", placement: "work-launcher" }],
    };
    const page = await newTestPage();
    await page.route("http://atelier.test/workspaces/popup", (route) => route.fulfill({ contentType: "text/html", body: `<style>${designSystemStyle}</style><button type="button">Outside</button>${renderWorkspacePresentation(presentation)}<script type="module" src="/design-system.js"></script>` }));
    await page.route("**/workspaces/popup/commands/files.create", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/workspaces/popup");

    const trigger = page.getByRole("button", { name: "Open Work view" });
    const menu = page.getByRole("menu", { name: "Open Work view" });
    await trigger.click();
    expect(await menu.isVisible()).toBe(true);
    await page.getByRole("button", { name: "Outside" }).click();
    expect(await menu.isHidden()).toBe(true);

    await trigger.click();
    await page.getByRole("menuitem", { name: "New Files" }).click();
    expect(await menu.isHidden()).toBe(true);
    expect(await trigger.getAttribute("aria-expanded")).toBe("false");
    await page.close();
  });

  test("design-system dialogs auto-show and restore focus", async () => {
    const page = await newTestPage();
    await page.route("http://design-system.test/", (route) => route.fulfill({ contentType: "text/html", body: `<button id="opener">Open</button><script type="module" src="/design-system.js"></script>` }));
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
    await page.goto("http://atelier.test/");
    const dialog = page.locator("dialog");
    await dialog.waitFor({ state: "visible" });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(await dialog.isHidden()).toBe(true);
    await page.close();
  });

  test("switches a Markdown file between Edit and Rendered", async () => {
    const page = await newTestPage();
    const editor = renderFilesWorkViewBody("workspace", { id: "workspace", path: "/work/README.md", line: 1 });
    await page.route("http://atelier.test/", (route) => route.fulfill({
      contentType: "text/html",
      body: `<style>${workspaceStyle}</style><div class="fixed-workspace-presentation"><div data-work-view-reorder-key="files:workspace"><button data-atelier-fullscreen-title-value="Files"><span class="action-item__label-text">Files</span></button></div><section data-workspace-pane-id="files:workspace">${editor}</section></div><script type="module" src="${workspaceClientPath}"></script>`,
    }));
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
    const files = renderFilesWorkViewBody("workspace", { id: "workspace" }).replace('loading="lazy"', 'loading="eager"');
    const tree = renderFilesTreeFrame("workspace", "workspace", [{ name: "README.md", path: "/work/README.md", kind: "file", size: 20, openable: true }]);
    const editor = renderFilesEditorFrame("workspace", { id: "workspace", path: "/work/README.md" });
    await page.route("http://atelier.test/", (route) => route.fulfill({ contentType: "text/html", body: `<style>${workspaceStyle}</style><div class="fixed-workspace-presentation"><div data-work-view-reorder-key="files:workspace"><button data-atelier-fullscreen-title-value="Files"><span class="action-item__label-text">Files</span></button></div><section data-workspace-pane-id="files:workspace">${files}</section></div><script type="module" src="${workspaceClientPath}"></script>` }));
    await page.route(/\/workspaces\/workspace\/files(?:\?.*)?$/, (route) => route.fulfill({ contentType: "text/html", body: tree }));
    await page.route(/\/workspaces\/workspace\/files-view\/open(?:\?.*)?$/, (route) => route.fulfill({
      contentType: "text/vnd.turbo-stream.html",
      body: turboStream("replace", filesEditorFrameId("workspace", "workspace"), editor),
    }));
    await page.route(/\/workspaces\/workspace\/files-view\/content(?:\?.*)?$/, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ path: "/work/README.md", content: "# Readme", revision: "one", writable: true }) }));
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

  test("gives directory names the space reserved for file sizes", async () => {
    const page = await newTestPage({ reducedMotion: "no-preference" });
    const name = "a-directory-name-long-enough-to-scroll-across-the-entire-row";
    const tree = renderFilesTreeFrame("workspace", "workspace", [{ name, path: `/work/${name}`, kind: "directory", size: 0, openable: false }]);
    await page.setContent(`<style>${workspaceStyle}\n${filesStyle}</style><div style="width: 300px; height: 200px">${tree}</div>`);
    await page.addScriptTag({ url: `http://atelier.test${workspaceClientPath}`, type: "module" });
    await page.waitForFunction(() => Boolean(window.Stimulus));

    const row = page.getByRole("treeitem");
    const label = row.locator(".action-item__label");
    const [rowBox, labelBox] = await Promise.all([row.boundingBox(), label.boundingBox()]);
    expect(rowBox).not.toBeNull();
    expect(labelBox).not.toBeNull();
    expect(rowBox!.x + rowBox!.width - (labelBox!.x + labelBox!.width)).toBeLessThanOrEqual(5);

    await row.hover();
    expect(await row.evaluate((element) => element.classList.contains("is-label-scrolling"))).toBe(true);
    await page.close();
  });

  test("does not shift a long-running button while its state changes", async () => {
    const page = await newTestPage();
    await page.setContent(`<style>${workspaceStyle}</style>
      <button id="progress" class="button primary progress-button" data-progress-state="initial" style="--button-progress: 1">
        <svg class="progress-button__perimeter" aria-hidden="true"><rect pathLength="100"/></svg>
        <span class="progress-button__content" data-progress-content="initial">Download</span>
        <span class="progress-button__content" data-progress-content="in-progress"><i class="progress-button__spinner"></i>Downloading workspace…</span>
      </button>`);
    const button = page.locator("#progress");
    const initial = await button.boundingBox();

    await button.evaluate((element) => { element.setAttribute("data-progress-state", "in-progress"); });
    const inProgress = await button.boundingBox();

    expect({ width: inProgress?.width, height: inProgress?.height }).toEqual({ width: initial?.width, height: initial?.height });
    await page.close();
  });

  test("opens the next and previous workspace with keyboard shortcuts", async () => {
    const page = await newShortcutTestPage(["first", "second", "third"]);

    await pressCommandOptionShortcut(page, ".", "Period");
    await page.waitForFunction(() => document.querySelector('[data-workspace-entry-id="second"]')?.classList.contains("active"));
    await pressCommandOptionShortcut(page, ",", "Comma");
    await page.waitForFunction(() => document.querySelector('[data-workspace-entry-id="first"]')?.classList.contains("active"));
    await page.close();
  });

  test("cycles Work views with keyboard shortcuts and only opens a closed Work pane", async () => {
    const page = await newShortcutTestPage(["work-shortcuts"], [
      { key: "files:workspace", label: "Files", kind: "contextual", availability: { phase: "live" }, bodyHtml: "<p>Files</p>" },
      { key: "terminal:1", label: "Terminal", kind: "resource", availability: { phase: "live" }, bodyHtml: "<p>Terminal</p>" },
    ]);
    await page.route("**/attention/acknowledge", (route) => route.fulfill({ status: 204 }));

    const presentationElement = page.locator(".fixed-workspace-presentation");
    const selectedView = () => page.locator('[data-work-view-key][aria-selected="true"]').getAttribute("data-work-view-key");

    expect(await presentationElement.getAttribute("class")).not.toContain("is-work-pane-open");
    expect(await selectedView()).toBe("files:workspace");
    await pressCommandOptionShortcut(page, "]", "BracketRight");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.classList.contains("is-work-pane-open"));
    expect(await selectedView()).toBe("files:workspace");

    await pressCommandOptionShortcut(page, "]", "BracketRight");
    await page.waitForFunction(() => document.querySelector('[data-work-view-key="terminal:1"]')?.getAttribute("aria-selected") === "true");
    await page.getByRole("button", { name: "Collapse Work pane", exact: true }).evaluate((button: HTMLButtonElement) => button.click());
    expect(await presentationElement.getAttribute("class")).not.toContain("is-work-pane-open");
    await pressCommandOptionShortcut(page, "[", "BracketLeft");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.classList.contains("is-work-pane-open"));
    expect(await selectedView()).toBe("terminal:1");

    await pressCommandOptionShortcut(page, "[", "BracketLeft");
    await page.waitForFunction(() => document.querySelector('[data-work-view-key="files:workspace"]')?.getAttribute("aria-selected") === "true");
    await page.close();
  }, 10_000);

  test("runs a shortcut popup action after the modifier keys are released", async () => {
    const page = await newShortcutTestPage(["first", "second"]);

    await page.locator("body").dispatchEvent("keydown", {
      key: "Meta", code: "MetaLeft", metaKey: true, altKey: true, bubbles: true,
    });
    const nextAction = page.getByRole("button", { name: /Open next workspace/ });
    await nextAction.hover();
    await page.locator("body").dispatchEvent("keyup", { key: "Meta", code: "MetaLeft", bubbles: true });
    expect(await nextAction.isVisible()).toBe(true);
    await nextAction.click();

    await page.waitForFunction(() => document.querySelector('[data-workspace-entry-id="second"]')?.classList.contains("active"));
    expect(await page.locator(".shortcut-overlay").count()).toBe(0);
    await page.close();
  });

  test("command palette supports combobox keyboard navigation and dismissal", async () => {
    const page = await newShortcutTestPage(["palette-workspace"]);

    await page.locator("body").dispatchEvent("keydown", { key: "k", code: "KeyK", metaKey: true, altKey: true, bubbles: true, cancelable: true });
    const palette = page.getByRole("dialog", { name: "Command palette" });
    const search = palette.getByRole("combobox", { name: "Search command palette" });
    await palette.waitFor({ state: "visible" });
    expect(await search.evaluate((element) => element === document.activeElement)).toBe(true);

    const options = palette.getByRole("option");
    expect(await options.count()).toBeGreaterThan(1);
    const firstId = await options.first().getAttribute("id");
    expect(await search.getAttribute("aria-activedescendant")).toBe(firstId);
    await search.press("ArrowDown");
    expect(await options.nth(1).getAttribute("aria-selected")).toBe("true");
    expect(await search.getAttribute("aria-activedescendant")).toBe(await options.nth(1).getAttribute("id"));

    await search.fill("no palette result can match this");
    await palette.getByText("No results found").waitFor({ state: "visible" });
    expect(await search.getAttribute("aria-activedescendant")).toBeNull();
    await search.press("Escape");
    expect(await palette.isHidden()).toBe(true);
    await page.close();
  });

  test("force deletes the visible workspace with Command-Option-Shift-Backspace", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "force-delete-me", title: "Force delete me" },
      agentConversations: [agentConversation("force-delete-me", "agent-force-delete")],
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
      body: `${shell}<script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.route("**/workspaces/force-delete-me/delete?force=1", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/workspaces/force-delete-me");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");
    await page.waitForFunction(() => document.querySelector('.workspace-detail-resident[data-workspace-id="force-delete-me"]')?.classList.contains("visible"));

    const requestPromise = page.waitForRequest((request) => new URL(request.url()).pathname === "/workspaces/force-delete-me/delete");
    const handled = await page.locator("body").evaluate((body) => {
      const event = new KeyboardEvent("keydown", {
        key: "Backspace",
        code: "Backspace",
        metaKey: true,
        altKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      body.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(handled).toBe(true);
    const request = await requestPromise;

    expect(request.method()).toBe("POST");
    expect(new URL(request.url()).searchParams.get("force")).toBe("1");
    await page.close();
  });

  test("positions and navigates a selected Agent transcript at the latest user message", async () => {
    const agentBody = `<div class="agent-pane" data-controller="agent-pane" data-agent-pane-workspace-id-value="selected" data-agent-pane-conversation-id-value="agent-selected">
      <div class="agent-transcript" id="selected_agent_transcript" data-agent-pane-target="transcript" style="height: 200px; overflow-y: auto">
        <div class="agent-item" style="height: 600px">Earlier messages</div>
        <div class="agent-item" data-latest-user-message style="height: 200px"><div class="agent-user">Latest user message</div></div>
        <div class="agent-item" data-latest-message style="height: 200px">Latest assistant message</div>
        <div class="agent-notices" style="height: 400px"></div>
      </div>
      <div class="composer agent-pane-composer">
        <div class="agent-pane-composer-overlays"><div class="agent-transcript-navs"><button class="button icon-only agent-transcript-nav" type="button" aria-label="Jump to beginning of latest message" data-agent-pane-target="transcriptNav" data-action="agent-pane#jumpToLatestMessage"><span aria-hidden="true">↑</span></button></div></div>
        <div class="composer-surface"><form data-agent-pane-target="form"><textarea class="composer-input" name="text" data-agent-pane-target="input" data-action="input->agent-pane#promptChanged"></textarea><button class="agent-sendstop" data-agent-pane-target="sendStop" data-agent-busy="false"></button></form></div>
      </div>
    </div>`;
    const presentation: WorkspacePresentation = {
      workspace: { id: "selected", title: "Selected" },
      agentConversations: [agentConversation("selected", "agent-selected")],
      workViews: [],
    };
    const other: WorkspacePresentation = {
      workspace: { id: "other", title: "Other" },
      agentConversations: [agentConversation("other", "agent-other")],
      workViews: [],
    };
    const pane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [
      { id: "selected", title: "Selected", active: true },
      { id: "other", title: "Other" },
    ] };
    const page = await newTestPage();
    await page.addInitScript(() => localStorage.removeItem('atelier.agentComposerText:["selected","agent-selected"]'));
    await page.route("http://atelier.test/workspaces/selected", (route) => route.fulfill({
      contentType: "text/html",
      body: `<style>${workspaceStyle}\n${agentStyle}</style>${renderShellFixture(presentation, pane, [other])}<script>
        window.AtelierCable = {
          subscribe(_identifier, options) {
            window.agentCableGeneration = (window.agentCableGeneration || 0) + 1;
            window.agentCableReady = options?.onReady;
          },
          unsubscribe() {},
          connected() { return true; },
        };
      </script><script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.route("**/workspaces/selected/agents/agent-selected/body", (route) => route.fulfill({
      contentType: "text/html",
      body: renderAgentBodyFrame("selected", "agent-selected", agentBody),
    }));
    await page.route("**/active", (route) => route.fulfill({ status: 204 }));
    await page.route("**/attention/acknowledge*", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/workspaces/selected");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");
    await page.locator(".agent-pane").waitFor();
    // SAFETY: The controlled Cable fixture increments this counter when the visible Agent subscribes.
    await page.waitForFunction(() => (window as typeof window & { agentCableGeneration?: number }).agentCableGeneration === 1);
    // SAFETY: The page fixture installs this optional Cable-ready callback before the application module loads.
    await page.evaluate(() => (window as typeof window & { agentCableReady?(): void }).agentCableReady?.());

    const waitForLatestUserAtTop = () => page.waitForFunction(() => {
      const transcript = document.querySelector<HTMLElement>(".agent-transcript");
      const latestUser = document.querySelector<HTMLElement>("[data-latest-user-message]");
      if (!transcript || !latestUser) return false;
      return Math.abs(latestUser.getBoundingClientRect().top - transcript.getBoundingClientRect().top) < 1;
    }, undefined, { timeout: 2_000 });
    await waitForLatestUserAtTop();
    const transcript = page.locator(".agent-transcript");
    const idlePosition = await transcript.evaluate((element) => element.scrollTop);
    expect(idlePosition).toBeGreaterThan(0);

    const navigationState = await transcript.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
      const button = document.querySelector<HTMLButtonElement>('[data-agent-pane-target="transcriptNav"]');
      if (!button) throw new Error("expected transcript navigation button");
      return { direction: button.dataset.direction, disabled: button.disabled };
    });
    const transcriptNav = page.locator('[data-agent-pane-target="transcriptNav"]');
    expect(navigationState).toEqual({ direction: "down", disabled: false });
    await transcriptNav.evaluate((button: HTMLButtonElement) => button.click());
    await waitForLatestUserAtTop();
    expect(await transcriptNav.isDisabled()).toBe(true);

    await transcript.evaluate((element) => { element.scrollTop = 0; });
    await page.locator('[data-workspace-entry-id="other"]').click();
    await page.locator('[data-workspace-entry-id="selected"]').click();
    await waitForLatestUserAtTop();
    expect(await transcript.evaluate((element) => element.scrollTop)).toBe(idlePosition);

    await page.evaluate(async () => {
      window.Turbo?.renderStreamMessage(`<turbo-stream action="update" target="selected_agent_transcript"><template>
        <div class="agent-item" style="height: 800px">Refreshed earlier messages</div>
        <div class="agent-item" data-latest-user-message style="height: 200px"><div class="agent-user">Latest user message</div></div>
        <div class="agent-item" data-latest-message style="height: 200px">Latest assistant message</div>
        <div class="agent-notices" style="height: 400px"></div>
      </template></turbo-stream>`);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      // SAFETY: This fixture installs the Cable-ready callback before loading the application.
      (window as typeof window & { agentCableReady?(): void }).agentCableReady?.();
    });
    await waitForLatestUserAtTop();
    expect(await transcript.evaluate((element) => element.scrollTop)).toBeGreaterThan(idlePosition);

    const composer = page.locator('[data-workspace-pane-id="agent-selected"] textarea[name="text"]');
    await composer.fill("Durable prompt across reconstruction");
    await page.locator('[data-workspace-pane-id="agent-selected"] turbo-frame').evaluate(async (frame) => {
      // SAFETY: The selector matches the Turbo Frame rendered by renderAgentPaneSlot.
      await (frame as HTMLElement & { reload(): Promise<void> }).reload();
    });
    await page.getByText("Earlier messages", { exact: true }).waitFor();
    // SAFETY: The controlled Cable fixture initializes and increments this counter for each Agent subscription.
    await page.waitForFunction(() => (window as typeof window & { agentCableGeneration?: number }).agentCableGeneration === 2);
    // SAFETY: The controlled Cable fixture installs the latest Agent controller's ready callback.
    await page.evaluate(() => (window as typeof window & { agentCableReady?(): void }).agentCableReady?.());
    await waitForLatestUserAtTop();
    expect(await transcript.evaluate((element) => element.scrollTop)).toBe(idlePosition);
    expect(await composer.inputValue()).toBe("Durable prompt across reconstruction");
    await page.evaluate(() => localStorage.removeItem('atelier.agentComposerText:["selected","agent-selected"]'));
    await page.close();
  });

  test("keeps accepted prompt and in-flight attachment changes durable through a busy submission", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "composer-audit", title: "Composer audit" },
      agentConversations: [agentConversation("composer-audit", "agent-audit")],
      workViews: [],
    };
    const pane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [{ id: "composer-audit", title: "Composer audit", active: true }] };
    const composerBody = `<div class="agent-pane" data-controller="agent-pane" data-agent-pane-workspace-id-value="composer-audit" data-agent-pane-conversation-id-value="agent-audit">
      <div class="agent-transcript" data-agent-pane-target="transcript" style="height: 80px; overflow-y: auto"><div style="height: 600px">History</div></div>
      <div class="composer"><div class="agent-pane-composer-overlays"><button type="button" data-agent-pane-target="transcriptNav" data-action="agent-pane#jumpToLatestMessage"></button></div><div class="composer-surface">
        <form id="composer_audit_form" method="post" action="/workspaces/composer-audit/agents/agent-audit/messages" data-agent-pane-target="form" data-action="turbo:submit-end->agent-pane#submitted">
          <div id="composer_audit_attach"><span class="agent-chip" id="submitted_chip"><input type="hidden" name="attachment" value="submitted-attachment"></span></div>
          <textarea id="composer_audit_input" class="composer-input" name="text" data-agent-pane-target="input" data-action="input->agent-pane#promptChanged"></textarea>
          <button class="agent-sendstop" type="submit" data-agent-pane-target="sendStop" data-agent-busy="true" data-agent-abort-form-id="composer_audit_abort"></button>
        </form>
        <form id="composer_audit_abort" action="/workspaces/composer-audit/agents/agent-audit/abort" hidden></form>
      </div></div>
    </div>`;
    let markFirstRequestStarted!: () => void;
    const firstRequestStarted = new Promise<void>((resolve) => { markFirstRequestStarted = resolve; });
    let markSecondRequestStarted!: () => void;
    const secondRequestStarted = new Promise<void>((resolve) => { markSecondRequestStarted = resolve; });
    let releaseFirstResponse!: () => void;
    const firstResponseReleased = new Promise<void>((resolve) => { releaseFirstResponse = resolve; });
    let releaseSecondResponse!: () => void;
    const secondResponseReleased = new Promise<void>((resolve) => { releaseSecondResponse = resolve; });
    const submittedBodies: string[] = [];
    const page = await newTestPage();
    await page.addInitScript(() => localStorage.setItem('atelier.agentComposerText:["composer-audit","agent-audit"]', "Existing durable prompt"));
    await page.route("http://atelier.test/workspaces/composer-audit", (route) => route.fulfill({
      contentType: "text/html",
      body: `${renderShellFixture(presentation, pane)}<script>
        window.AtelierCable = {
          subscribe(_identifier, options) { requestAnimationFrame(() => options?.onReady?.()); },
          unsubscribe() {},
          connected() { return true; },
        };
      </script><script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.route("**/workspaces/composer-audit/agents/agent-audit/body", (route) => route.fulfill({
      contentType: "text/html",
      body: renderAgentBodyFrame("composer-audit", "agent-audit", composerBody),
    }));
    await page.route("**/workspaces/composer-audit/agents/agent-audit/messages", async (route) => {
      const requestIndex = submittedBodies.push(route.request().postData() ?? "") - 1;
      if (requestIndex === 0) {
        markFirstRequestStarted();
        await firstResponseReleased;
      } else {
        markSecondRequestStarted();
        await secondResponseReleased;
      }
      await route.fulfill({
        status: 202,
        contentType: "text/vnd.turbo-stream.html",
        headers: { "x-atelier-attachment-draft-consumed": "true" },
        body: "",
      });
    });
    await page.route("**/attention/acknowledge*", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/workspaces/composer-audit");

    const input = page.locator("#composer_audit_input");
    await input.waitFor();
    expect(await input.inputValue()).toBe("Existing durable prompt");
    await page.evaluate((stream) => window.Turbo!.renderStreamMessage(stream), turboStream("replace", "composer_audit_input", `<textarea id="composer_audit_input" class="composer-input" name="text" data-agent-pane-target="input" data-action="input->agent-pane#promptChanged">Accepted replacement prompt</textarea>`));
    await page.waitForFunction(() => localStorage.getItem('atelier.agentComposerText:["composer-audit","agent-audit"]') === "Accepted replacement prompt");
    expect(await input.inputValue()).toBe("Accepted replacement prompt");

    await input.fill("");
    const primaryAction = page.locator(".agent-sendstop");
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>(".agent-sendstop")?.value === "steer");
    expect(await primaryAction.getAttribute("form")).toBeNull();
    await primaryAction.click();
    await firstRequestStarted;
    expect(new URLSearchParams(submittedBodies[0]!).getAll("attachment")).toEqual(["submitted-attachment"]);
    await page.evaluate((stream) => window.Turbo!.renderStreamMessage(stream), turboStream("append", "composer_audit_attach", `<span class="agent-chip" id="late_chip"><input type="hidden" name="attachment" value="late-attachment"></span>`));
    await page.locator('#late_chip input[name="attachment"]').waitFor({ state: "attached" });
    const transcript = page.locator(".agent-transcript");
    await transcript.evaluate((element) => {
      element.scrollTop = 120;
      element.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelector<HTMLElement>(".agent-transcript")?.scrollTop === 120);
    await input.fill("Typed while send was in flight");
    await page.waitForFunction(() => localStorage.getItem('atelier.agentComposerText:["composer-audit","agent-audit"]') === "Typed while send was in flight");
    releaseFirstResponse();

    await page.locator("#submitted_chip").waitFor({ state: "detached" });
    expect(await page.locator("#late_chip").count()).toBe(1);
    expect(await primaryAction.getAttribute("value")).toBe("steer");
    expect(await input.inputValue()).toBe("Typed while send was in flight");
    expect(await page.evaluate(() => localStorage.getItem('atelier.agentComposerText:["composer-audit","agent-audit"]'))).toBe("Typed while send was in flight");
    expect(await transcript.evaluate((element) => element.scrollTop)).toBe(120);

    await primaryAction.click();
    await secondRequestStarted;
    expect(new URLSearchParams(submittedBodies[1]!).getAll("attachment")).toEqual(["late-attachment"]);
    await input.fill("Temporary post-submit edit");
    await input.fill("Typed while send was in flight");
    releaseSecondResponse();

    await page.locator("#late_chip").waitFor({ state: "detached" });
    expect(await input.inputValue()).toBe("Typed while send was in flight");
    expect(await page.evaluate(() => localStorage.getItem('atelier.agentComposerText:["composer-audit","agent-audit"]'))).toBe("Typed while send was in flight");
    expect(await transcript.evaluate((element) => element.scrollTop)).toBe(await transcript.evaluate((element) => element.scrollHeight - element.clientHeight));
    await page.close();
  });

  test("restores completed attachments through Agent, Workspace, body, eviction, and refresh lifecycles", async () => {
    const first: WorkspacePresentation = {
      workspace: { id: "attachment-a", title: "Attachment A" },
      agentConversations: [
        agentConversation("attachment-a", "agent-a1", "Attached Agent"),
        agentConversation("attachment-a", "agent-a2", "Other Agent"),
      ],
      workViews: [],
    };
    const second: WorkspacePresentation = {
      workspace: { id: "attachment-b", title: "Attachment B" },
      agentConversations: [agentConversation("attachment-b", "agent-b")],
      workViews: [],
    };
    const third: WorkspacePresentation = {
      workspace: { id: "attachment-c", title: "Attachment C" },
      agentConversations: [agentConversation("attachment-c", "agent-c")],
      workViews: [],
    };
    const pane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [
      { id: "attachment-a", title: "Attachment A", active: true },
      { id: "attachment-b", title: "Attachment B" },
      { id: "attachment-c", title: "Attachment C" },
    ] };
    const completedAttachmentBody = (workspaceId: string, conversationId: string): string => agentPaneBody(workspaceId, conversationId).replace(
      '<textarea class="composer-input"',
      '<div class="agent-attach-row"><span class="agent-chip" data-completed-attachment><input type="hidden" name="attachment" value="completed-attachment"><span>completed-notes.txt</span></span></div><textarea class="composer-input"',
    );
    let attachedBodyRequests = 0;
    const page = await newTestPage();
    const shell = renderShellFixture(first, pane).replace('data-workspace-residency-max-resident-value="5"', 'data-workspace-residency-max-resident-value="2"');
    await page.route("http://atelier.test/workspaces/attachment-a", (route) => route.fulfill({
      contentType: "text/html",
      body: `${shell}<script>
        document.addEventListener("atelier:workspace-preparation-invalidated", (event) => {
          if (event.detail.workspaceId !== "attachment-a") return;
          document.body.dataset.attachmentInvalidations = String(Number(document.body.dataset.attachmentInvalidations || 0) + 1);
        });
        window.AtelierCable = { subscribe(_identifier, options) { requestAnimationFrame(() => options?.onReady?.()); }, unsubscribe() {}, connected() { return true; } };
      </script><script type="module" src="${workspaceClientPath}"></script>`,
    }));
    for (const presentation of [first, second, third]) {
      await page.route(`**/workspaces/${presentation.workspace.id}?resident=1`, (route) => route.fulfill({
        contentType: "text/html",
        body: `<div class="workspace-detail-resident" data-workspace-residency-target="resident" data-workspace-id="${presentation.workspace.id}">${renderWorkspacePresentation(presentation)}</div>`,
      }));
    }
    await page.route(/\/workspaces\/([^/]+)\/agents\/([^/]+)\/body$/, (route) => {
      const match = new URL(route.request().url()).pathname.match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/body$/);
      if (!match) throw new Error("expected Agent body route");
      const workspaceId = decodeURIComponent(match[1]!);
      const conversationId = decodeURIComponent(match[2]!);
      if (workspaceId === "attachment-a" && conversationId === "agent-a1") attachedBodyRequests += 1;
      const body = workspaceId === "attachment-a" && conversationId === "agent-a1"
        ? completedAttachmentBody(workspaceId, conversationId)
        : agentPaneBody(workspaceId, conversationId);
      return route.fulfill({ contentType: "text/html", body: renderAgentBodyFrame(workspaceId, conversationId, body) });
    });
    await page.route("**/attention/acknowledge*", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/workspaces/attachment-a");

    const completedAttachment = () => page.locator('[data-workspace-id="attachment-a"] [data-completed-attachment]');
    await completedAttachment().waitFor();
    await completedAttachment().evaluate((chip) => { chip.dataset.attachmentProbe = "retained"; });
    expect(attachedBodyRequests).toBe(1);

    await page.getByRole("tab", { name: "Other Agent" }).evaluate((button: HTMLButtonElement) => button.click());
    await page.getByRole("tab", { name: "Attached Agent" }).evaluate((button: HTMLButtonElement) => button.click());
    expect(await completedAttachment().getAttribute("data-attachment-probe")).toBe("retained");
    expect(attachedBodyRequests).toBe(1);

    await page.locator('[data-workspace-entry-id="attachment-b"]').evaluate((button: HTMLButtonElement) => button.click());
    await page.waitForFunction(() => document.querySelector('.workspace-detail-resident.visible')?.getAttribute("data-workspace-id") === "attachment-b");
    await page.locator('[data-workspace-entry-id="attachment-a"]').evaluate((button: HTMLButtonElement) => button.click());
    await page.waitForFunction(() => document.querySelector('.workspace-detail-resident.visible')?.getAttribute("data-workspace-id") === "attachment-a");
    expect(await completedAttachment().getAttribute("data-attachment-probe")).toBe("retained");
    expect(attachedBodyRequests).toBe(1);

    await page.getByRole("tab", { name: "Other Agent" }).evaluate((button: HTMLButtonElement) => button.click());
    await page.evaluate((stream) => window.Turbo!.renderStreamMessage(stream), workspacePreparationInvalidatedTurboStream("attachment-a", "agent-a1"));
    await page.waitForFunction(() => document.body.dataset.attachmentInvalidations === "1");
    await page.getByRole("tab", { name: "Attached Agent" }).evaluate((button: HTMLButtonElement) => button.click());
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('[data-workspace-id="attachment-a"] [data-completed-attachment]')?.dataset.attachmentProbe);
    expect(attachedBodyRequests).toBe(2);
    expect(await completedAttachment().getAttribute("data-attachment-probe")).toBeNull();

    await page.locator('[data-workspace-entry-id="attachment-b"]').evaluate((button: HTMLButtonElement) => button.click());
    await page.locator('[data-workspace-entry-id="attachment-c"]').evaluate((button: HTMLButtonElement) => button.click());
    await page.waitForFunction(() => !document.querySelector('.workspace-detail-resident[data-workspace-id="attachment-a"]'));
    await page.locator('[data-workspace-entry-id="attachment-a"]').evaluate((button: HTMLButtonElement) => button.click());
    await completedAttachment().waitFor();
    expect(attachedBodyRequests).toBe(3);
    expect(await completedAttachment().locator('input[name="attachment"]').getAttribute("value")).toBe("completed-attachment");

    await page.reload();
    await completedAttachment().waitFor();
    expect(attachedBodyRequests).toBe(4);
    expect(await completedAttachment().getByText("completed-notes.txt").count()).toBe(1);
    await page.close();
  }, 15_000);

  test("runs Agent Cable only for the logically visible surface and visible document", async () => {
    const first: WorkspacePresentation = {
      workspace: { id: "lifecycle-a", title: "Lifecycle A" },
      agentConversations: [
        agentConversation("lifecycle-a", "agent-a1", "A one"),
        agentConversation("lifecycle-a", "agent-a2", "A two"),
      ],
      workViews: [{ key: "terminal:a", label: "Terminal A", kind: "resource", availability: { phase: "live" }, bodyHtml: "<p>Terminal A</p>" }],
    };
    const second: WorkspacePresentation = {
      workspace: { id: "lifecycle-b", title: "Lifecycle B" },
      agentConversations: [agentConversation("lifecycle-b", "agent-b1", "B one")],
      workViews: [{ key: "terminal:b", label: "Terminal B", kind: "resource", availability: { phase: "live" }, bodyHtml: "<p>Terminal B</p>" }],
    };
    const pane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [
      { id: "lifecycle-a", title: "Lifecycle A", active: true },
      { id: "lifecycle-b", title: "Lifecycle B" },
    ] };
    const page = await newTestPage({ viewport: { width: 1200, height: 800 } });
    await page.route("http://atelier.test/workspaces/lifecycle-a", (route) => route.fulfill({
      contentType: "text/html",
      body: `<style>${workspaceStyle}\n${agentStyle}</style>${renderShellFixture(first, pane, [second])}<script>
        window.agentCableEvents = [];
        window.AtelierCable = {
          subscribe(identifier) { window.agentCableEvents.push("subscribe:" + identifier.workspaceId + ":" + identifier.conversationId); },
          unsubscribe(identifier) { window.agentCableEvents.push("unsubscribe:" + identifier.workspaceId + ":" + identifier.conversationId); },
          connected() { return true; },
        };
      </script><script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.route(/\/workspaces\/([^/]+)\/agents\/([^/]+)\/body$/, (route) => {
      const match = new URL(route.request().url()).pathname.match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/body$/);
      if (!match) throw new Error("expected Agent body route");
      const workspaceId = decodeURIComponent(match[1]!);
      const conversationId = decodeURIComponent(match[2]!);
      return route.fulfill({ contentType: "text/html", body: renderAgentBodyFrame(workspaceId, conversationId, agentPaneBody(workspaceId, conversationId)) });
    });
    await page.route("**/active", (route) => route.fulfill({ status: 204 }));
    await page.route("**/attention/acknowledge*", (route) => route.fulfill({ status: 204 }));
    const waitForCableEvents = (expected: string[]) => page.waitForFunction((events) => {
      // SAFETY: The page fixture initializes agentCableEvents as a string array before the application module loads.
      const actual = (window as typeof window & { agentCableEvents: string[] }).agentCableEvents;
      return JSON.stringify(actual) === JSON.stringify(events);
    }, expected);

    await page.goto("http://atelier.test/workspaces/lifecycle-a");
    const events = ["subscribe:lifecycle-a:agent-a1"];
    await waitForCableEvents(events);

    await page.getByRole("tab", { name: "A two" }).evaluate((button: HTMLButtonElement) => button.click());
    events.push("unsubscribe:lifecycle-a:agent-a1", "subscribe:lifecycle-a:agent-a2");
    await waitForCableEvents(events);

    await page.locator('[data-workspace-entry-id="lifecycle-b"]').evaluate((button: HTMLButtonElement) => button.click());
    events.push("unsubscribe:lifecycle-a:agent-a2", "subscribe:lifecycle-b:agent-b1");
    await waitForCableEvents(events);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-mobile-destination="work:terminal:b"]').evaluate((button: HTMLButtonElement) => button.click());
    events.push("unsubscribe:lifecycle-b:agent-b1");
    await waitForCableEvents(events);

    await page.locator('.workspace-detail-resident.visible [data-mobile-destination="agents"]').evaluate((button: HTMLButtonElement) => button.click());
    events.push("subscribe:lifecycle-b:agent-b1");
    await waitForCableEvents(events);

    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    events.push("unsubscribe:lifecycle-b:agent-b1");
    await waitForCableEvents(events);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    events.push("subscribe:lifecycle-b:agent-b1");
    await waitForCableEvents(events);

    expect(await page.locator('[data-workspace-pane-id="agent-b1"]').getAttribute("data-workspace-logically-visible")).toBe("true");
    await page.close();
  });

  test("preserves working history through reconnect and follows the tail after sending", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "reconnect-agent", title: "Reconnect Agent" },
      agentConversations: [agentConversation("reconnect-agent", "agent-live")],
      workViews: [],
    };
    const pane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [{ id: "reconnect-agent", title: "Reconnect Agent", active: true }] };
    const transcriptHtml = (label: string): string => `
      <div class="agent-item" style="height: 500px">${label} history</div>
      <div class="agent-item" style="height: 180px"><div class="agent-user">Latest user</div></div>
      <div class="agent-item" style="height: 400px">${label} working tail</div>`;
    const body = agentPaneBody("reconnect-agent", "agent-live", transcriptHtml("Initial"))
      .replace('class="agent-transcript"', 'class="agent-transcript" style="height: 200px; overflow-y: auto"')
      .replace('data-agent-busy="false"', 'data-agent-busy="true"');
    const page = await newTestPage();
    await page.addInitScript(() => localStorage.removeItem('atelier.agentComposerText:["reconnect-agent","agent-live"]'));
    await page.route("http://atelier.test/workspaces/reconnect-agent", (route) => route.fulfill({
      contentType: "text/html",
      body: `${renderShellFixture(presentation, pane)}<script>
        window.agentSubscriptions = 0;
        window.AtelierCable = {
          subscribe(_identifier, options) { window.agentSubscriptions += 1; window.agentCableOptions = options; },
          unsubscribe() {},
          connected() { return true; },
        };
      </script><script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.route("**/workspaces/reconnect-agent/agents/agent-live/body", (route) => route.fulfill({
      contentType: "text/html",
      body: renderAgentBodyFrame("reconnect-agent", "agent-live", body),
    }));
    await page.route("**/attention/acknowledge*", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/workspaces/reconnect-agent");
    await page.waitForFunction(() => {
      // SAFETY: The controlled Cable fixture stores the subscription options on window.
      return Boolean((window as typeof window & { agentCableOptions?: unknown }).agentCableOptions);
    });
    await page.evaluate((snapshot) => {
      window.Turbo!.renderStreamMessage(snapshot);
      // SAFETY: The controlled Cable fixture stores this callback before the test invokes it.
      const options = (window as typeof window & { agentCableOptions: { onReady?(): void } }).agentCableOptions;
      requestAnimationFrame(() => options.onReady?.());
    }, turboStream("update", "reconnect-agent_agent-live_transcript", transcriptHtml("Snapshot")));

    const transcript = page.locator("#reconnect-agent_agent-live_transcript");
    const waitForTranscriptTail = () => page.waitForFunction(() => {
      const element = document.querySelector<HTMLElement>("#reconnect-agent_agent-live_transcript")!;
      return Math.abs(element.scrollTop - (element.scrollHeight - element.clientHeight)) < 2;
    });
    await waitForTranscriptTail();
    const input = page.locator('[data-workspace-pane-id="agent-live"] textarea[name="text"]');
    await input.fill("Draft survives reconnect");
    await transcript.evaluate((element) => {
      element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      element.scrollTop = 120;
      element.dispatchEvent(new Event("scroll"));
    });

    await page.evaluate(() => {
      // SAFETY: The controlled Cable fixture stores this callback before the test invokes it.
      (window as typeof window & { agentCableOptions: { onDisconnected?(): void } }).agentCableOptions.onDisconnected?.();
    });
    expect(await transcript.getAttribute("aria-busy")).toBe("true");
    await page.evaluate((snapshot) => {
      window.Turbo!.renderStreamMessage(snapshot);
      // SAFETY: The controlled Cable fixture stores this callback before the test invokes it.
      const options = (window as typeof window & { agentCableOptions: { onReady?(): void } }).agentCableOptions;
      requestAnimationFrame(() => options.onReady?.());
    }, turboStream("update", "reconnect-agent_agent-live_transcript", transcriptHtml("Reconnect snapshot")));
    await page.waitForFunction(() => document.querySelector(".agent-pane")?.classList.contains("agent-pane-reconnecting") === false);
    expect(await transcript.evaluate((element) => element.scrollTop)).toBe(120);

    await page.evaluate((html) => window.Turbo!.renderStreamMessage(html), turboStream("append", "reconnect-agent_agent-live_transcript", '<div class="agent-item" style="height: 240px">Continued live update</div>'));
    await page.getByText("Continued live update").waitFor();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await transcript.evaluate((element) => element.scrollTop)).toBe(120);

    await page.locator(".agent-pane form").evaluate((form) => form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true })));
    await waitForTranscriptTail();
    await transcript.evaluate((element) => { element.style.height = "120px"; });
    await waitForTranscriptTail();
    await page.evaluate((html) => window.Turbo!.renderStreamMessage(html), turboStream("append", "reconnect-agent_agent-live_transcript", '<div class="agent-item" style="height: 240px">Continued after sending</div>'));
    await page.getByText("Continued after sending").waitFor();
    await waitForTranscriptTail();
    expect(await input.inputValue()).toBe("Draft survives reconnect");
    expect(await page.evaluate(() => localStorage.getItem('atelier.agentComposerText:["reconnect-agent","agent-live"]'))).toBe("Draft survives reconnect");
    // SAFETY: The controlled Cable fixture initializes this numeric counter before application startup.
    expect(await page.evaluate(() => (window as typeof window & { agentSubscriptions: number }).agentSubscriptions)).toBe(1);
    await page.close();
  });

  test("enhances native selects with anchored design-system popup menus", async () => {
    const page = await newTestPage({ viewport: { width: 360, height: 300 } });
    await page.route("http://atelier.test/", (route) => route.fulfill({
      contentType: "text/html",
      body: `<style>${workspaceStyle}</style><form style="position:fixed;right:4px;bottom:4px"><select class="popup-select" data-popup-select-opens-above="true" aria-label="Thinking level"><option>low</option><option selected>medium</option><option>high</option></select></form><script type="module" src="${workspaceClientPath}"></script>`,
    }));
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
      agentConversations: [agentConversation("short", "agent-short")],
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
      body: `<style>${workspaceStyle}</style><style>.fixed-shell-app { --fixed-workspace-width: 150px; width: 700px; height: 500px; }</style>${renderShellFixture(current, pane)}<script type="module" src="${workspaceClientPath}"></script>`,
    }));
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

  test("shrinks Agent tabs before header actions and scrolls clipped names on hover", async () => {
    const close = { action: "/agents/close", label: "agent" };
    const presentation: WorkspacePresentation = {
      workspace: { id: "agent-tabs", title: "Agent tabs" },
      agentConversations: [
        { ...agentConversation("agent-tabs", "agent-one", "First agent with a deliberately long name"), close },
        { ...agentConversation("agent-tabs", "agent-two", "Second agent with another deliberately long name"), close },
        { ...agentConversation("agent-tabs", "agent-three", "Third agent with an exceptionally long name"), close },
        { ...agentConversation("agent-tabs", "agent-four", "Fourth agent with one more deliberately long name"), close },
      ],
      workViews: [],
      commands: [{ id: "agent.create", label: "New agent", scope: "workspace", placement: "agent-action" }],
    };
    const page = await newTestPage({ viewport: { width: 760, height: 500 }, reducedMotion: "no-preference" });
    await page.route("http://atelier.test/workspaces/agent-tabs", (route) => route.fulfill({
      contentType: "text/html",
      body: `<style>${workspaceStyle}</style><style>.fixed-shell-app { --fixed-workspace-width: 150px; }</style>${renderShellFixture(presentation, { projects: [], projectlessWorkspaces: [{ id: "agent-tabs", title: "Agent tabs", active: true }] })}<script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.goto("http://atelier.test/workspaces/agent-tabs");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");

    const header = page.locator(".fixed-shell-agent-pane > header");
    const tabs = header.locator(".fixed-shell-agent-conversation");
    const geometry = await header.evaluate((element) => {
      const headerBox = element.getBoundingClientRect();
      const navigationBox = element.querySelector(".fixed-shell-agent-navigation")!.getBoundingClientRect();
      const actionBox = element.querySelector(".fixed-shell-agent-actions")!.getBoundingClientRect();
      return { actionsFit: actionBox.right <= headerBox.right, tabsStopBeforeActions: navigationBox.right <= actionBox.left };
    });
    expect(geometry).toEqual({ actionsFit: true, tabsStopBeforeActions: true });
    expect(await tabs.evaluateAll((items) => items.filter((item) => item.getClientRects().length > 0).every((item) => {
      const label = item.querySelector<HTMLElement>(".action-item__label")!;
      const text = item.querySelector<HTMLElement>(".action-item__label-text")!;
      return text.scrollWidth > label.clientWidth;
    }))).toBe(true);

    const firstTab = tabs.first();
    await firstTab.hover();
    expect(await firstTab.evaluate((item) => item.classList.contains("is-label-scrolling"))).toBe(true);
    await page.close();
  });

  test("renders active preparation as a modifier on Workspace Attention across sidebar replacement", async () => {
    const current: WorkspacePresentation = {
      workspace: { id: "a", title: "Current" },
      agentConversations: [agentConversation("a", "agent-a")],
      workViews: [],
    };
    const pane: WorkspacePanePresentation = {
      projects: [],
      projectlessWorkspaces: [
        { id: "a", title: "Current", active: true },
        { id: "b", title: "Unread", attention: true, attentionAt: 123 },
      ],
    };
    let finishPreload!: () => void;
    const preloadBlocked = new Promise<void>((resolve) => { finishPreload = resolve; });
    const page = await newTestPage();
    await page.route("http://atelier.test/", (route) => route.fulfill({
      contentType: "text/html",
      body: `<style>${workspaceStyle}</style>${renderShellFixture(current, pane)}<script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.route("**/workspaces/a/active", (route) => route.fulfill({ status: 204 }));
    await page.route("**/workspaces/b?resident=1", async (route) => {
      await preloadBlocked;
      await route.fulfill({ contentType: "text/html", body: '<div class="workspace-detail-resident visible" data-workspace-residency-target="resident" data-workspace-id="b">Preloaded unread workspace</div>' });
    });
    await page.goto("http://atelier.test/");

    const unread = page.locator('[data-workspace-entry-id="b"]');
    await page.waitForFunction(() => document.querySelector('[data-workspace-entry-id="b"]')?.hasAttribute("data-workspace-preloading"));
    await unread.locator('[aria-label="Attention; preparing workspace"]').waitFor();

    await page.evaluate((html) => window.Turbo!.renderStreamMessage(html), workspacePaneCollectionsTurboStream(pane));
    await unread.locator('[aria-label="Attention; preparing workspace"]').waitFor();

    finishPreload();
    await page.waitForFunction(() => Boolean(document.querySelector('.workspace-detail-resident[data-workspace-id="b"]')));
    await unread.locator('[aria-label="Attention"]').waitFor({ state: "visible" });
    expect(await unread.getAttribute("data-workspace-preloading")).toBeNull();
    await page.close();
  });

  test("does not re-mark a retained Workspace prepared when it is invalidated during surface hydration", async () => {
    const first: WorkspacePresentation = {
      workspace: { id: "generation-a", title: "Generation A" },
      agentConversations: [agentConversation("generation-a", "agent-a")],
      workViews: [{
        key: "probe:view",
        label: "Probe",
        kind: "resource",

        availability: { phase: "live" },
        bodyHtml: '<iframe data-controller="workspace-app-frame" data-workspace-app-frame-workspace-id-value="generation-a" data-workspace-app-frame-app-key-value="probe" data-workspace-app-frame-initial-path-value="/initial"></iframe>',
      }],
    };
    const second: WorkspacePresentation = {
      workspace: { id: "generation-b", title: "Generation B" },
      agentConversations: [agentConversation("generation-b", "agent-b")],
      workViews: [],
    };
    const pane: WorkspacePanePresentation = {
      projects: [],
      projectlessWorkspaces: [
        { id: "generation-a", title: "Generation A", active: true },
        { id: "generation-b", title: "Generation B" },
      ],
    };
    let releaseBlockedSurface!: () => void;
    const blockedSurface = new Promise<void>((resolve) => { releaseBlockedSurface = resolve; });
    let surfaceHydrationStarted!: () => void;
    const hydrationStarted = new Promise<void>((resolve) => { surfaceHydrationStarted = resolve; });
    let firstAgentBodyRequests = 0;
    const page = await newTestPage();
    await page.addInitScript(() => sessionStorage.setItem("atelier:workspace-navigation:generation-a", JSON.stringify({
      activeAgentId: "agent-a",
      activeWorkViewKey: "probe:view",
      workPaneVisible: true,
      phoneDestination: "agents",
      drawers: [],
    })));
    await page.route("http://atelier.test/workspaces/generation-a", (route) => route.fulfill({
      contentType: "text/html",
      body: `<style>${workspaceStyle}</style>${renderShellFixture(first, pane, [second])}<script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.route("**/workspaces/generation-a/agents/agent-a/body", (route) => {
      firstAgentBodyRequests += 1;
      return route.fulfill({ contentType: "text/html", body: renderAgentBodyFrame("generation-a", "agent-a", "<p>Authoritative Agent A</p>") });
    });
    await page.route("**/workspaces/generation-a/apps/probe/initial", (route) => route.fulfill({ contentType: "text/html", body: "<p>Initial surface</p>" }));
    await page.route("**/workspaces/generation-a/apps/probe/blocked", async (route) => {
      surfaceHydrationStarted();
      await blockedSurface;
      await route.fulfill({ contentType: "text/html", body: "<p>Updated surface</p>" });
    });
    await page.route("**/workspaces/*/active", (route) => route.fulfill({ status: 204 }));
    await page.route("**/attention/acknowledge*", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/workspaces/generation-a");
    await page.waitForFunction(() => document.querySelectorAll('[data-navigation-ready="true"]').length === 2);
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('[data-workspace-app-frame-app-key-value="probe"]')?.contentDocument?.body?.textContent?.includes("Initial surface"));
    expect(firstAgentBodyRequests).toBe(1);

    await page.locator('[data-workspace-app-frame-app-key-value="probe"]').evaluate((frame) => {
      frame.setAttribute("data-workspace-app-frame-initial-path-value", "/blocked");
    });
    await page.locator('[data-workspace-entry-id="generation-b"]').click();
    await hydrationStarted;
    await page.evaluate((html) => window.Turbo!.renderStreamMessage(html), workspacePreparationInvalidatedTurboStream("generation-a"));
    releaseBlockedSurface();
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('[data-workspace-app-frame-app-key-value="probe"]')?.contentDocument?.body?.textContent?.includes("Updated surface"));
    await page.waitForTimeout(20);

    await page.locator('[data-workspace-entry-id="generation-a"]').click();
    await page.waitForFunction(() => document.querySelector('.workspace-detail-resident[data-workspace-id="generation-a"]')?.classList.contains("visible"));
    expect(firstAgentBodyRequests).toBe(2);
    await page.close();
  });

  test("reloads a hidden invalidated Agent before selection while keeping a visible Agent connected", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "agent-invalidation", title: "Agent invalidation" },
      agentConversations: [
        agentConversation("agent-invalidation", "agent-a", "Agent A"),
        agentConversation("agent-invalidation", "agent-b", "Agent B"),
      ],
      workViews: [],
    };
    const pane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [{ id: "agent-invalidation", title: "Agent invalidation", active: true }] };
    let markSecondBRequestStarted!: () => void;
    const secondBRequestStarted = new Promise<void>((resolve) => { markSecondBRequestStarted = resolve; });
    let releaseSecondBRequest!: () => void;
    const secondBRequestReleased = new Promise<void>((resolve) => { releaseSecondBRequest = resolve; });
    let bBodyRequests = 0;
    const page = await newTestPage();
    await page.route("http://atelier.test/workspaces/agent-invalidation", (route) => route.fulfill({
      contentType: "text/html",
      body: `${renderShellFixture(presentation, pane)}<script>
        const recordCableEvent = (event) => {
          document.body.dataset.agentCableEvents = [document.body.dataset.agentCableEvents, event].filter(Boolean).join("|");
        };
        document.addEventListener("atelier:workspace-preparation-invalidated", (event) => {
          if (event.detail.workspaceId !== "agent-invalidation") return;
          document.body.dataset.agentInvalidations = String(Number(document.body.dataset.agentInvalidations || 0) + 1);
        });
        window.AtelierCable = {
          subscribe(identifier, options) {
            recordCableEvent("subscribe:" + identifier.conversationId);
            requestAnimationFrame(() => options?.onReady?.());
          },
          unsubscribe(identifier) { recordCableEvent("unsubscribe:" + identifier.conversationId); },
          connected() { return true; },
        };
      </script><script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.route("**/workspaces/agent-invalidation/agents/*/body", async (route) => {
      const conversationId = decodeURIComponent(new URL(route.request().url()).pathname.match(/agents\/([^/]+)\/body$/)![1]!);
      if (conversationId === "agent-b") {
        bBodyRequests += 1;
        if (bBodyRequests === 2) {
          markSecondBRequestStarted();
          await secondBRequestReleased;
        }
      }
      const generation = conversationId === "agent-b" ? bBodyRequests : 1;
      await route.fulfill({
        contentType: "text/html",
        body: renderAgentBodyFrame("agent-invalidation", conversationId, agentPaneBody("agent-invalidation", conversationId, `<p>${conversationId} generation ${generation}</p>`)),
      });
    });
    await page.route("**/active", (route) => route.fulfill({ status: 204 }));
    await page.route("**/attention/acknowledge*", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/workspaces/agent-invalidation");
    await page.waitForFunction(() => document.body.dataset.agentCableEvents === "subscribe:agent-a");

    await page.getByRole("tab", { name: "Agent B" }).evaluate((button: HTMLButtonElement) => button.click());
    await page.getByText("agent-b generation 1").waitFor();
    await page.waitForFunction(() => document.body.dataset.agentCableEvents?.endsWith("subscribe:agent-b"));
    await page.getByRole("tab", { name: "Agent A" }).evaluate((button: HTMLButtonElement) => button.click());
    await page.waitForFunction(() => document.body.dataset.agentCableEvents?.endsWith("subscribe:agent-a"));
    await page.evaluate(() => { document.body.dataset.agentCableEvents = ""; });

    await page.evaluate((stream) => window.Turbo!.renderStreamMessage(stream), workspacePreparationInvalidatedTurboStream("agent-invalidation", "agent-b"));
    await page.waitForFunction(() => document.body.dataset.agentInvalidations === "1");
    expect(await page.locator("body").getAttribute("data-agent-cable-events")).toBe("");
    expect(await page.locator('[data-workspace-pane-id="agent-b"]').getAttribute("data-workspace-logically-visible")).toBe("false");
    await page.getByRole("tab", { name: "Agent B" }).evaluate((button: HTMLButtonElement) => button.click());
    await secondBRequestStarted;
    expect(await page.locator("body").getAttribute("data-agent-cable-events")).toBe("unsubscribe:agent-a");
    expect(await page.getByText("agent-b generation 1").count()).toBe(1);
    releaseSecondBRequest();

    await page.getByText("agent-b generation 2").waitFor();
    await page.waitForFunction(() => document.body.dataset.agentCableEvents === "unsubscribe:agent-a|subscribe:agent-b");
    expect(bBodyRequests).toBe(2);
    expect(await page.getByText("agent-b generation 1").count()).toBe(0);

    await page.evaluate(() => { document.body.dataset.agentCableEvents = ""; });
    const visibleFrame = page.locator('[data-workspace-pane-id="agent-b"] turbo-frame');
    await visibleFrame.evaluate((frame) => { frame.dataset.visibleFrameProbe = "retained"; });
    await page.evaluate((stream) => window.Turbo!.renderStreamMessage(stream), workspacePreparationInvalidatedTurboStream("agent-invalidation", "agent-b"));
    await page.waitForFunction(() => document.body.dataset.agentInvalidations === "2");
    await page.evaluate((html) => window.Turbo!.renderStreamMessage(html), turboStream("update", "agent-invalidation_agent-b_transcript", "<p>Targeted visible Agent update</p>"));
    await page.getByText("Targeted visible Agent update").waitFor();
    expect(await page.locator("body").getAttribute("data-agent-cable-events")).toBe("");
    expect(bBodyRequests).toBe(2);
    expect(await visibleFrame.getAttribute("data-visible-frame-probe")).toBe("retained");
    await page.close();
  }, 10_000);

  test("chains an authoritative Agent reload when invalidated during first body hydration", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "agent-hydration-invalidation", title: "Agent hydration invalidation" },
      agentConversations: [
        agentConversation("agent-hydration-invalidation", "agent-a", "Agent A"),
        agentConversation("agent-hydration-invalidation", "agent-b", "Agent B"),
      ],
      workViews: [],
    };
    const pane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [{ id: "agent-hydration-invalidation", title: "Agent hydration invalidation", active: true }] };
    let markFirstBRequestStarted!: () => void;
    const firstBRequestStarted = new Promise<void>((resolve) => { markFirstBRequestStarted = resolve; });
    let releaseFirstBRequest!: () => void;
    const firstBRequestReleased = new Promise<void>((resolve) => { releaseFirstBRequest = resolve; });
    let markSecondBRequestStarted!: () => void;
    const secondBRequestStarted = new Promise<void>((resolve) => { markSecondBRequestStarted = resolve; });
    let releaseSecondBRequest!: () => void;
    const secondBRequestReleased = new Promise<void>((resolve) => { releaseSecondBRequest = resolve; });
    let bBodyRequests = 0;
    const page = await newTestPage();
    await page.route("http://atelier.test/workspaces/agent-hydration-invalidation", (route) => route.fulfill({
      contentType: "text/html",
      body: `${renderShellFixture(presentation, pane)}<script>
        const recordCableEvent = (event) => {
          document.body.dataset.agentCableEvents = [document.body.dataset.agentCableEvents, event].filter(Boolean).join("|");
        };
        window.AtelierCable = {
          subscribe(identifier, options) {
            recordCableEvent("subscribe:" + identifier.conversationId);
            requestAnimationFrame(() => options?.onReady?.());
          },
          unsubscribe(identifier) { recordCableEvent("unsubscribe:" + identifier.conversationId); },
          connected() { return true; },
        };
      </script><script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.route("**/workspaces/agent-hydration-invalidation/agents/*/body", async (route) => {
      const conversationId = decodeURIComponent(new URL(route.request().url()).pathname.match(/agents\/([^/]+)\/body$/)![1]!);
      if (conversationId === "agent-b") {
        bBodyRequests += 1;
        if (bBodyRequests === 1) {
          markFirstBRequestStarted();
          await firstBRequestReleased;
        } else if (bBodyRequests === 2) {
          markSecondBRequestStarted();
          await secondBRequestReleased;
        }
      }
      const body = conversationId === "agent-b"
        ? bBodyRequests === 1 ? "Stale Agent B body" : "Authoritative Agent B body"
        : "Agent A body";
      await route.fulfill({
        contentType: "text/html",
        body: renderAgentBodyFrame("agent-hydration-invalidation", conversationId, agentPaneBody("agent-hydration-invalidation", conversationId, `<p>${body}</p>`)),
      });
    });
    await page.route("**/active", (route) => route.fulfill({ status: 204 }));
    await page.route("**/attention/acknowledge*", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/workspaces/agent-hydration-invalidation");
    await page.waitForFunction(() => document.body.dataset.agentCableEvents === "subscribe:agent-a");

    await page.getByRole("tab", { name: "Agent B" }).evaluate((button: HTMLButtonElement) => button.click());
    await firstBRequestStarted;
    await page.evaluate((stream) => window.Turbo!.renderStreamMessage(stream), workspacePreparationInvalidatedTurboStream("agent-hydration-invalidation", "agent-b"));
    releaseFirstBRequest();
    await secondBRequestStarted;
    expect(await page.locator("body").getAttribute("data-agent-cable-events")).toBe("subscribe:agent-a|unsubscribe:agent-a");
    releaseSecondBRequest();

    await page.getByText("Authoritative Agent B body").waitFor();
    await page.waitForFunction(() => document.body.dataset.agentCableEvents?.endsWith("subscribe:agent-b"));
    expect(bBodyRequests).toBeGreaterThanOrEqual(2);
    expect(await page.getByText("Stale Agent B body").count()).toBe(0);
    await page.close();
  }, 10_000);

  test("adopts an in-flight preload and keeps the latest foreground selection", async () => {
    const cPresentation: WorkspacePresentation = {
      workspace: { id: "c", title: "Slow C" },
      agentConversations: [agentConversation("c", "agent-c")],
      workViews: [],
    };
    const pane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [
      { id: "a", title: "Current A", active: true },
      { id: "b", title: "Preloading B", attention: true, attentionAt: 1 },
      { id: "c", title: "Slow C" },
      { id: "d", title: "Latest D" },
    ] };
    let releaseB!: () => void;
    const bReleased = new Promise<void>((resolve) => { releaseB = resolve; });
    let markCBodyStarted!: () => void;
    const cBodyStarted = new Promise<void>((resolve) => { markCBodyStarted = resolve; });
    let releaseCBody!: () => void;
    const cBodyReleased = new Promise<void>((resolve) => { releaseCBody = resolve; });
    let bRequests = 0;
    const page = await newTestPage();
    await page.route("http://atelier.test/workspaces/a", (route) => route.fulfill({
      contentType: "text/html",
      body: `${renderShellResidents(pane, '<div class="workspace-detail-resident visible" data-workspace-residency-target="resident" data-workspace-id="a">Current A</div>')}<script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.route("**/workspaces/b?resident=1", async (route) => {
      bRequests += 1;
      await bReleased;
      await route.fulfill({ contentType: "text/html", body: '<div class="workspace-detail-resident" data-workspace-residency-target="resident" data-workspace-id="b">Prepared B</div>' });
    });
    await page.route("**/workspaces/c?resident=1", (route) => route.fulfill({
      contentType: "text/html",
      body: `<div class="workspace-detail-resident" data-workspace-residency-target="resident" data-workspace-id="c">${renderWorkspacePresentation(cPresentation)}</div>`,
    }));
    await page.route("**/workspaces/c/agents/agent-c/body", async (route) => {
      markCBodyStarted();
      await cBodyReleased;
      await route.fulfill({ contentType: "text/html", body: renderAgentBodyFrame("c", "agent-c", agentPaneBody("c", "agent-c", "<p>Stale C preparation finished</p>")) });
    });
    await page.route("**/workspaces/d?resident=1", (route) => route.fulfill({
      contentType: "text/html",
      body: '<div class="workspace-detail-resident" data-workspace-residency-target="resident" data-workspace-id="d">Latest D</div>',
    }));
    await page.route("**/active", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/workspaces/a");

    await page.waitForFunction(() => document.querySelector('[data-workspace-entry-id="b"]')?.hasAttribute("data-workspace-preloading"));
    await page.locator('[data-workspace-entry-id="b"]').evaluate((button: HTMLButtonElement) => button.click());
    expect(new URL(page.url()).pathname).toBe("/workspaces/b");
    expect(await page.locator('[data-workspace-entry-id="b"]').getAttribute("data-workspace-preloading")).toBeNull();
    expect(bRequests).toBe(1);
    releaseB();
    await page.waitForFunction(() => document.querySelector('.workspace-detail-resident.visible[data-workspace-id="b"]'));
    expect(bRequests).toBe(1);

    await page.locator('[data-workspace-entry-id="c"]').evaluate((button: HTMLButtonElement) => button.click());
    await cBodyStarted;
    await page.locator('[data-workspace-entry-id="d"]').evaluate((button: HTMLButtonElement) => button.click());
    await page.waitForFunction(() => document.querySelector('.workspace-detail-resident.visible[data-workspace-id="d"]'));
    releaseCBody();
    await page.getByText("Stale C preparation finished").waitFor({ state: "attached" });
    expect(new URL(page.url()).pathname).toBe("/workspaces/d");
    expect(await page.locator(".workspace-detail-resident.visible").getAttribute("data-workspace-id")).toBe("d");
    await page.close();
  });

  test("starts a fresh foreground load when an aborted resident fetch is reselected", async () => {
    const pane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [
      { id: "abort-a", title: "Workspace A", active: true },
      { id: "abort-b", title: "Workspace B" },
      { id: "abort-c", title: "Workspace C" },
    ] };
    let markFirstBRequestStarted!: () => void;
    const firstBRequestStarted = new Promise<void>((resolve) => { markFirstBRequestStarted = resolve; });
    let releaseFirstBRequest!: () => void;
    const firstBRequestReleased = new Promise<void>((resolve) => { releaseFirstBRequest = resolve; });
    let markSecondBRequestStarted!: () => void;
    const secondBRequestStarted = new Promise<void>((resolve) => { markSecondBRequestStarted = resolve; });
    let bRequests = 0;
    const page = await newTestPage();
    await page.route("http://atelier.test/workspaces/abort-a", (route) => route.fulfill({
      contentType: "text/html",
      body: `${renderShellResidents(pane, '<div class="workspace-detail-resident visible" data-workspace-residency-target="resident" data-workspace-id="abort-a">Workspace A</div>')}<script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.route("**/workspaces/abort-b?resident=1", async (route) => {
      bRequests += 1;
      if (bRequests === 1) {
        markFirstBRequestStarted();
        await firstBRequestReleased;
        if (route.request().failure()) return;
      } else {
        markSecondBRequestStarted();
      }
      await route.fulfill({ contentType: "text/html", body: '<div class="workspace-detail-resident" data-workspace-residency-target="resident" data-workspace-id="abort-b">Fresh Workspace B</div>' });
    });
    await page.route("**/workspaces/abort-c?resident=1", (route) => route.fulfill({
      contentType: "text/html",
      body: '<div class="workspace-detail-resident" data-workspace-residency-target="resident" data-workspace-id="abort-c">Workspace C</div>',
    }));
    await page.route("**/active", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/workspaces/abort-a");

    await page.locator('[data-workspace-entry-id="abort-b"]').evaluate((button: HTMLButtonElement) => button.click());
    await firstBRequestStarted;
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[data-workspace-entry-id="abort-c"]')!.click();
      document.querySelector<HTMLButtonElement>('[data-workspace-entry-id="abort-b"]')!.click();
    });
    await secondBRequestStarted;
    releaseFirstBRequest();

    await page.getByText("Fresh Workspace B").waitFor({ state: "visible" });
    expect(bRequests).toBe(2);
    expect(new URL(page.url()).pathname).toBe("/workspaces/abort-b");
    expect(await page.locator(".workspace-detail-resident.visible").getAttribute("data-workspace-id")).toBe("abort-b");
    expect(await page.getByText(/Could not load workspace/).count()).toBe(0);
    await page.close();
  }, 10_000);

  test("refetches a resident shell when structural streams arrive during its initial fetch", async () => {
    const current: WorkspacePresentation = {
      workspace: { id: "structural-a", title: "Current" },
      agentConversations: [agentConversation("structural-a", "agent-a")],
      workViews: [],
    };
    const stale: WorkspacePresentation = {
      workspace: { id: "structural-b", title: "Destination" },
      agentConversations: [agentConversation("structural-b", "agent-old", "Existing Agent")],
      workViews: [],
    };
    const intendedWork = { key: "browser:1", label: "Browser", kind: "resource", availability: { phase: "live" }, bodyHtml: "<p>Authoritative Browser</p>" } as const;
    const authoritative: WorkspacePresentation = {
      workspace: stale.workspace,
      agentConversations: [...stale.agentConversations, agentConversation("structural-b", "agent-new", "New Agent")],
      workViews: [intendedWork],
    };
    const pane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [
      { id: "structural-a", title: "Current", active: true },
      { id: "structural-b", title: "Destination" },
    ] };
    let markFirstResidentFetchStarted!: () => void;
    const firstResidentFetchStarted = new Promise<void>((resolve) => { markFirstResidentFetchStarted = resolve; });
    let releaseFirstResidentFetch!: () => void;
    const firstResidentFetchReleased = new Promise<void>((resolve) => { releaseFirstResidentFetch = resolve; });
    let residentFetches = 0;
    const page = await newTestPage();
    await page.route("http://atelier.test/workspaces/structural-a", (route) => route.fulfill({
      contentType: "text/html",
      body: `${renderShellFixture(current, pane)}<script>
        document.addEventListener("atelier:workspace-preparation-invalidated", (event) => {
          if (event.detail.workspaceId !== "structural-b") return;
          document.body.dataset.structuralInvalidations = String(Number(document.body.dataset.structuralInvalidations || 0) + 1);
        });
      </script><script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.route("**/workspaces/structural-b?resident=1", async (route) => {
      residentFetches += 1;
      if (residentFetches === 1) {
        markFirstResidentFetchStarted();
        await firstResidentFetchReleased;
      }
      const presentation = residentFetches === 1 ? stale : authoritative;
      await route.fulfill({
        contentType: "text/html",
        body: `<div class="workspace-detail-resident" data-workspace-residency-target="resident" data-workspace-id="structural-b"><span data-shell-generation>${residentFetches === 1 ? "Stale shell" : "Authoritative shell"}</span>${renderWorkspacePresentation(presentation)}</div>`,
      });
    });
    await page.route("**/attention/acknowledge*", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/workspaces/structural-a");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");

    await page.locator('[data-workspace-entry-id="structural-b"]').evaluate((button: HTMLButtonElement) => button.click());
    await firstResidentFetchStarted;
    await page.evaluate(({ agents, work }) => {
      window.Turbo!.renderStreamMessage(agents);
      window.Turbo!.renderStreamMessage(work);
    }, {
      agents: agentTabsTurboStream(authoritative, { addedConversationId: "agent-new" }),
      work: workViewsTurboStream("structural-b", [intendedWork], { openedKey: "browser:1", selectKey: "browser:1", intendSelection: true }),
    });
    await page.waitForFunction(() => Number(document.body.dataset.structuralInvalidations) === 2);
    await page.waitForFunction(() => {
      const stored = sessionStorage.getItem("atelier:workspace-navigation:structural-b");
      return stored ? JSON.parse(stored).activeWorkViewKey === "browser:1" : false;
    });
    releaseFirstResidentFetch();

    await page.getByText("Authoritative shell").waitFor();
    const resident = page.locator('.workspace-detail-resident[data-workspace-id="structural-b"]');
    await page.waitForFunction(() => document.querySelector('.workspace-detail-resident[data-workspace-id="structural-b"]')?.classList.contains("visible"));
    expect(residentFetches).toBe(2);
    expect(await page.getByText("Stale shell").count()).toBe(0);
    expect(await resident.getByRole("tab", { name: "New Agent" }).count()).toBe(1);
    expect(await resident.getByRole("tab", { name: "Browser" }).getAttribute("aria-selected")).toBe("true");
    expect(await resident.locator('[data-workspace-pane-id="browser:1"]').getAttribute("data-workspace-logically-visible")).toBe("true");
    await page.close();
  });

  test("retains at most five residents while preparing one background Workspace at a time", async () => {
    const workspaceIds = ["a", "b", "c", "d", "e", "f", "g"];
    const pane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: workspaceIds.map((id, index) => ({
      id,
      title: `Workspace ${id}`,
      active: index === 0,
      attention: index !== 0,
      attentionAt: index === 0 ? undefined : index,
    })) };
    const requested: string[] = [];
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const page = await newTestPage();
    await page.route("http://atelier.test/workspaces/a", (route) => route.fulfill({
      contentType: "text/html",
      body: `${renderShellResidents(pane, '<div class="workspace-detail-resident visible" data-workspace-residency-target="resident" data-workspace-id="a">Workspace a</div>')}<script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.route(/\/workspaces\/[^/?]+\?resident=1$/, async (route) => {
      const workspaceId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
      requested.push(workspaceId);
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      try {
        await Bun.sleep(50);
        await route.fulfill({ contentType: "text/html", body: `<div class="workspace-detail-resident" data-workspace-residency-target="resident" data-workspace-id="${workspaceId}">Workspace ${workspaceId}</div>` });
      } finally {
        activeRequests -= 1;
      }
    });
    await page.route("**/active", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/workspaces/a");

    await page.waitForFunction(() => document.querySelectorAll(".workspace-detail-resident").length === 5 && !document.querySelector("[data-workspace-preloading]"));
    expect(requested).toEqual(["b", "c", "d", "e"]);
    expect(maximumActiveRequests).toBe(1);
    expect(await page.locator(".workspace-detail-resident").count()).toBe(5);
    expect(await page.locator(".workspace-detail-resident").evaluateAll((residents) => residents.map((resident) => resident.getAttribute("data-workspace-id")))).toEqual(["a", "b", "c", "d", "e"]);
    await page.close();
  });

  test("replays a readiness wakeup that arrives while background preparation is active", async () => {
    const workspaceB: WorkspacePresentation = {
      workspace: { id: "pump-b", title: "Workspace B" },
      agentConversations: [agentConversation("pump-b", "agent-b")],
      workViews: [],
    };
    const initialPane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [
      { id: "pump-a", title: "Workspace A", active: true },
      { id: "pump-b", title: "Workspace B", attention: true, attentionAt: 1, busyViewKeys: ["agent:agent-b"] },
      { id: "pump-c", title: "Workspace C", attention: true, attentionAt: 2 },
    ] };
    const readyPane: WorkspacePanePresentation = { ...initialPane, projectlessWorkspaces: [
      { id: "pump-a", title: "Workspace A", active: true },
      { id: "pump-b", title: "Workspace B", attention: true, attentionAt: 1 },
      { id: "pump-c", title: "Workspace C", attention: true, attentionAt: 2 },
    ] };
    let markCRequestStarted!: () => void;
    const cRequestStarted = new Promise<void>((resolve) => { markCRequestStarted = resolve; });
    let releaseCRequest!: () => void;
    const cRequestReleased = new Promise<void>((resolve) => { releaseCRequest = resolve; });
    let markSecondBRequest!: () => void;
    const secondBRequest = new Promise<void>((resolve) => { markSecondBRequest = resolve; });
    let bResidentRequests = 0;
    let markBBodyRequest!: () => void;
    const bBodyRequest = new Promise<void>((resolve) => { markBBodyRequest = resolve; });
    let activeResidentRequests = 0;
    let maximumActiveResidentRequests = 0;
    const page = await newTestPage();
    await page.route("http://atelier.test/workspaces/pump-a", (route) => route.fulfill({
      contentType: "text/html",
      body: `${renderShellResidents(initialPane, '<div class="workspace-detail-resident visible" data-workspace-residency-target="resident" data-workspace-id="pump-a">Workspace A</div>')}<script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.route("**/workspaces/pump-b?resident=1", async (route) => {
      bResidentRequests += 1;
      if (bResidentRequests === 2) markSecondBRequest();
      activeResidentRequests += 1;
      maximumActiveResidentRequests = Math.max(maximumActiveResidentRequests, activeResidentRequests);
      try {
        await route.fulfill({
          contentType: "text/html",
          body: `<div class="workspace-detail-resident" data-workspace-residency-target="resident" data-workspace-id="pump-b">${renderWorkspacePresentation(workspaceB)}</div>`,
        });
      } finally {
        activeResidentRequests -= 1;
      }
    });
    await page.route("**/workspaces/pump-c?resident=1", async (route) => {
      activeResidentRequests += 1;
      maximumActiveResidentRequests = Math.max(maximumActiveResidentRequests, activeResidentRequests);
      markCRequestStarted();
      try {
        await cRequestReleased;
        await route.fulfill({
          contentType: "text/html",
          body: '<div class="workspace-detail-resident" data-workspace-residency-target="resident" data-workspace-id="pump-c">Workspace C</div>',
        });
      } finally {
        activeResidentRequests -= 1;
      }
    });
    await page.route("**/workspaces/pump-b/agents/agent-b/body", (route) => {
      markBBodyRequest();
      return route.fulfill({
        contentType: "text/html",
        body: renderAgentBodyFrame("pump-b", "agent-b", agentPaneBody("pump-b", "agent-b", "<p>Prepared Agent B</p>")),
      });
    });
    await page.route("**/active", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/workspaces/pump-a");

    await cRequestStarted;
    expect(bResidentRequests).toBe(1);
    await page.evaluate((stream) => new Promise<void>((resolve) => {
      document.addEventListener("atelier:workspace-pane-changed", () => resolve(), { once: true });
      window.Turbo!.renderStreamMessage(stream);
    }), workspacePaneCollectionsTurboStream(readyPane));
    releaseCRequest();

    await secondBRequest;
    await bBodyRequest;
    await page.getByText("Prepared Agent B").waitFor();
    expect(bResidentRequests).toBe(2);
    expect(maximumActiveResidentRequests).toBe(1);
    await page.close();
  }, 10_000);

  test("reprepares a ready Workspace when its prepared resident target is replaced", async () => {
    const workspaceB: WorkspacePresentation = {
      workspace: { id: "target-b", title: "Workspace B" },
      agentConversations: [agentConversation("target-b", "agent-b")],
      workViews: [],
    };
    const pane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [
      { id: "target-a", title: "Workspace A", active: true },
      { id: "target-b", title: "Workspace B", attention: true, attentionAt: 1 },
    ] };
    let residentRequests = 0;
    let agentBodyRequests = 0;
    const residentHtml = (generation: string): string => `<div id="target_b_resident" class="workspace-detail-resident" data-workspace-residency-target="resident" data-workspace-id="target-b"><span data-resident-generation>${generation}</span>${renderWorkspacePresentation(workspaceB)}</div>`;
    const page = await newTestPage();
    await page.route("http://atelier.test/workspaces/target-a", (route) => route.fulfill({
      contentType: "text/html",
      body: `${renderShellResidents(pane, '<div class="workspace-detail-resident visible" data-workspace-residency-target="resident" data-workspace-id="target-a">Workspace A</div>')}<script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.route("**/workspaces/target-b?resident=1", (route) => {
      residentRequests += 1;
      return route.fulfill({ contentType: "text/html", body: residentHtml("initial") });
    });
    await page.route("**/workspaces/target-b/agents/agent-b/body", (route) => {
      agentBodyRequests += 1;
      return route.fulfill({
        contentType: "text/html",
        body: renderAgentBodyFrame("target-b", "agent-b", agentPaneBody("target-b", "agent-b", `<p>Hydrated body ${agentBodyRequests}</p>`)),
      });
    });
    await page.route("**/active", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/workspaces/target-a");
    await page.getByText("Hydrated body 1").waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-workspace-entry-id="target-b"]')?.hasAttribute("data-workspace-preloading"));

    await page.evaluate((stream) => window.Turbo!.renderStreamMessage(stream), turboStream("replace", "target_b_resident", residentHtml("replacement")));

    await page.getByText("Hydrated body 2").waitFor();
    expect(residentRequests).toBe(1);
    expect(agentBodyRequests).toBe(2);
    expect(await page.locator("[data-resident-generation]").textContent()).toBe("replacement");
    await page.close();
  });

  test("acknowledges Workspace attention only for the visible foreground resident", async () => {
    const current: WorkspacePresentation = {
      workspace: { id: "ack-a", title: "Workspace A" },
      agentConversations: [agentConversation("ack-a", "agent-a")],
      workViews: [],
    };
    const initialPane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [
      { id: "ack-a", title: "Workspace A", active: true },
      { id: "ack-b", title: "Workspace B", attention: true, attentionAt: 2, attentionTokens: { workspace: 71 } },
    ] };
    const firstAttentionPane: WorkspacePanePresentation = { ...initialPane, projectlessWorkspaces: [
      { id: "ack-a", title: "Workspace A", active: true, attentionTokens: { workspace: 41 } },
      initialPane.projectlessWorkspaces![1]!,
    ] };
    const secondAttentionPane: WorkspacePanePresentation = { ...initialPane, projectlessWorkspaces: [
      { id: "ack-a", title: "Workspace A", active: true, attentionTokens: { workspace: 42 } },
      initialPane.projectlessWorkspaces![1]!,
    ] };
    const acknowledgementUrls: string[] = [];
    const page = await newTestPage();
    await page.addInitScript(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    });
    await page.route("http://atelier.test/workspaces/ack-a", (route) => route.fulfill({
      contentType: "text/html",
      body: `${renderShellFixture(current, initialPane)}<script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.route("**/workspaces/ack-b?resident=1", (route) => route.fulfill({
      contentType: "text/html",
      body: '<div class="workspace-detail-resident" data-workspace-residency-target="resident" data-workspace-id="ack-b">Workspace B</div>',
    }));
    await page.route(/\/workspaces\/[^/]+\/attention\/acknowledge/, (route) => {
      acknowledgementUrls.push(route.request().url());
      return route.fulfill({ status: 204 });
    });
    await page.route("**/active", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/workspaces/ack-a");
    await page.waitForFunction(() => Boolean(document.querySelector('.workspace-detail-resident[data-workspace-id="ack-b"]')));

    await page.evaluate((stream) => window.Turbo!.renderStreamMessage(stream), workspacePaneCollectionsTurboStream(firstAttentionPane));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(acknowledgementUrls).toEqual([]);

    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForFunction(() => performance.getEntriesByType("resource").some((entry) => new URL(entry.name).searchParams.get("attentionTokens") === '{"workspace":41}'));
    await page.evaluate((stream) => window.Turbo!.renderStreamMessage(stream), workspacePaneCollectionsTurboStream(secondAttentionPane));
    await page.waitForFunction(() => performance.getEntriesByType("resource").some((entry) => new URL(entry.name).searchParams.get("attentionTokens") === '{"workspace":42}'));

    expect(acknowledgementUrls.map((url) => new URL(url).pathname)).toEqual([
      "/workspaces/ack-a/attention/acknowledge",
      "/workspaces/ack-a/attention/acknowledge",
    ]);
    expect(acknowledgementUrls.map((url) => JSON.parse(new URL(url).searchParams.get("attentionTokens")!))).toEqual([{ workspace: 41 }, { workspace: 42 }]);
    await page.close();
  });

  test("preloading hydrates only the intended Agent and visible Work view without making them logically visible", async () => {
    const current: WorkspacePresentation = {
      workspace: { id: "a", title: "Current" },
      agentConversations: [agentConversation("a", "agent-a")],
      workViews: [],
    };
    const preloaded: WorkspacePresentation = {
      workspace: { id: "b", title: "Preloaded" },
      agentConversations: [agentConversation("b", "agent-b"), agentConversation("b", "agent-b-inactive", "Inactive")],
      workViews: [
        { key: "review:workspace", label: "Review", kind: "contextual", availability: { phase: "live" }, bodyUrl: "/workspaces/b/work-views/review%3Aworkspace/body" },
        { key: "files:workspace", label: "Files", kind: "contextual", availability: { phase: "live" }, bodyUrl: "/workspaces/b/work-views/files%3Aworkspace/body" },
      ],
    };
    const pane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [
      { id: "a", title: "Current", active: true },
      { id: "b", title: "Preloaded", attention: true, attentionAt: 123, attentionTokens: { "agent:agent-b": 7 } },
    ] };
    const agentBodyRequests: string[] = [];
    const workBodyRequests: string[] = [];
    const page = await newTestPage();
    await page.addInitScript(() => {
      sessionStorage.setItem("atelier:workspace-navigation:b", JSON.stringify({ activeAgentId: "agent-b", activeWorkViewKey: "review:workspace", workPaneVisible: true, phoneDestination: "agents", drawers: [] }));
    });
    await page.route("http://atelier.test/workspaces/a", (route) => route.fulfill({
      contentType: "text/html",
      body: `<style>${workspaceStyle}</style>${renderShellFixture(current, pane)}<script>
        window.AtelierCable = {
          subscribe(identifier) { window.agentSubscriptions.push(identifier.conversationId); },
          unsubscribe() {},
          connected() { return true; },
        };
        window.agentSubscriptions = [];
      </script><script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.route("**/workspaces/a/active", (route) => route.fulfill({ status: 204 }));
    await page.route("**/workspaces/b/active", (route) => route.fulfill({ status: 204 }));
    await page.route("**/workspaces/b?resident=1", (route) => route.fulfill({
      contentType: "text/html",
      body: `<div class="workspace-detail-resident" data-workspace-residency-target="resident" data-workspace-id="b">${renderWorkspacePresentation(preloaded)}</div>`,
    }));
    await page.route("**/workspaces/b/agents/*/body", async (route) => {
      const conversationId = decodeURIComponent(new URL(route.request().url()).pathname.match(/agents\/([^/]+)\/body$/)![1]!);
      agentBodyRequests.push(conversationId);
      await Bun.sleep(100);
      await route.fulfill({ contentType: "text/html", body: renderAgentBodyFrame("b", conversationId, agentPaneBody("b", conversationId, `<p>Hydrated ${conversationId}</p>`)) });
    });
    await page.route("**/workspaces/b/work-views/*/body", async (route) => {
      const key = decodeURIComponent(new URL(route.request().url()).pathname.match(/work-views\/([^/]+)\/body$/)![1]!);
      workBodyRequests.push(key);
      await Bun.sleep(100);
      await route.fulfill({ contentType: "text/html", body: renderWorkViewBodyFrame("b", key, `<p>Hydrated ${key}</p>`) });
    });
    await page.route("**/workspaces/b/attention/acknowledge*", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/workspaces/a");

    const row = page.locator('[data-workspace-entry-id="b"]');
    await page.getByText("Hydrated agent-b").waitFor({ state: "attached" });
    await page.getByText("Hydrated review:workspace").waitFor({ state: "attached" });
    await page.waitForFunction(() => !document.querySelector('[data-workspace-entry-id="b"]')?.hasAttribute("data-workspace-preloading"));
    expect(await row.getAttribute("data-workspace-preloading")).toBeNull();
    expect(agentBodyRequests).toEqual(["agent-b"]);
    expect(workBodyRequests).toEqual(["review:workspace"]);
    // SAFETY: The page fixture initializes agentSubscriptions as an array before the application module loads.
    expect(await page.evaluate(() => (window as typeof window & { agentSubscriptions: string[] }).agentSubscriptions)).toEqual([]);
    expect(await page.locator('[data-workspace-id="b"] [data-workspace-pane-id="agent-b"]').getAttribute("data-workspace-logically-visible")).toBe("false");
    await row.click();
    await page.getByText("Hydrated review:workspace").waitFor({ state: "visible" });
    // SAFETY: The page fixture initializes agentSubscriptions as an array before the application module loads.
    await page.waitForFunction(() => (window as typeof window & { agentSubscriptions: string[] }).agentSubscriptions.includes("agent-b"));
    await page.waitForFunction(() => document.querySelector('[data-workspace-id="b"] [data-workspace-pane-id="agent-b"]')?.getAttribute("data-workspace-logically-visible") === "true");
    expect(agentBodyRequests).toEqual(["agent-b"]);
    expect(workBodyRequests).toEqual(["review:workspace"]);
    await page.close();
  });

  test("hydrates each selected Work view before emitting its visibility lifecycle", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "active", title: "Active" },
      agentConversations: [agentConversation("active", "agent")],
      workViews: [
        { key: "files:workspace", label: "Files", kind: "contextual", availability: { phase: "live" }, bodyUrl: "/workspaces/active/work-views/files%3Aworkspace/body" },
        { key: "review:workspace", label: "Review", kind: "contextual", availability: { phase: "live" }, bodyUrl: "/workspaces/active/work-views/review%3Aworkspace/body" },
      ],
    };
    const pane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [{ id: "active", title: "Active", active: true }] };
    const requests: string[] = [];
    const page = await newTestPage();
    await page.addInitScript(() => {
      sessionStorage.setItem("atelier:workspace-navigation:active", JSON.stringify({ activeAgentId: "agent", activeWorkViewKey: "files:workspace", workPaneVisible: true, phoneDestination: "agents", drawers: [] }));
    });
    await page.route("http://atelier.test/workspaces/active", (route) => route.fulfill({
      contentType: "text/html",
      body: `<style>${workspaceStyle}</style>${renderShellFixture(presentation, pane)}<script>
        document.addEventListener("atelier:workspace-pane-visible", (event) => {
          const pane = event.target;
          if (!(pane instanceof HTMLElement) || pane.dataset.workspacePaneRole !== "work") return;
          const sample = pane.dataset.workspacePaneId + ":" + Boolean(pane.querySelector("[data-hydrated-work]"));
          document.body.dataset.workVisibilityEvents = [document.body.dataset.workVisibilityEvents, sample].filter(Boolean).join("|");
        });
      </script><script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.route("**/workspaces/active/active", (route) => route.fulfill({ status: 204 }));
    await page.route("**/attention/acknowledge*", (route) => route.fulfill({ status: 204 }));
    await page.route("**/workspaces/active/work-views/*/body", (route) => {
      const match = new URL(route.request().url()).pathname.match(/work-views\/([^/]+)\/body$/);
      const key = decodeURIComponent(match![1]!);
      requests.push(key);
      return route.fulfill({ contentType: "text/html", body: renderWorkViewBodyFrame("active", key, `<p data-hydrated-work>${key} hydrated</p>`) });
    });
    await page.goto("http://atelier.test/workspaces/active");

    await page.getByText("files:workspace hydrated").waitFor({ state: "attached" });
    await page.waitForFunction(() => document.body.dataset.workVisibilityEvents === "files:workspace:true");
    await page.locator('[data-work-view-key="review:workspace"]').click();
    await page.getByText("review:workspace hydrated").waitFor();
    await page.waitForFunction(() => document.body.dataset.workVisibilityEvents === "files:workspace:true|review:workspace:true");
    expect(requests).toEqual(["files:workspace", "review:workspace"]);
    expect(await page.locator("body").getAttribute("data-work-visibility-events")).toBe("files:workspace:true|review:workspace:true");
    await page.close();
  });

  test("adds an Agent through targeted streams without replacing existing Agent or Work surfaces", async () => {
    const initial: WorkspacePresentation = {
      workspace: { id: "targeted-agent", title: "Targeted Agent" },
      agentConversations: [agentConversation("targeted-agent", "agent-1", "Plan")],
      workViews: [{ key: "terminal:1", label: "Terminal", kind: "resource", availability: { phase: "live" }, bodyHtml: '<textarea data-work-draft>command</textarea>' }],
    };
    const updated: WorkspacePresentation = {
      ...initial,
      agentConversations: [...initial.agentConversations, agentConversation("targeted-agent", "agent-2", "Build")],
    };
    const page = await newTestPage();
    await page.route("http://atelier.test/workspaces/targeted-agent", (route) => route.fulfill({
      contentType: "text/html",
      body: `${renderShellFixture(initial, { projects: [] })}<script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.goto("http://atelier.test/workspaces/targeted-agent");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");
    await page.locator('[data-workspace-pane-id="agent-1"] turbo-frame').waitFor();
    await page.evaluate(() => {
      const agentFrame = document.querySelector<HTMLElement>('[data-workspace-pane-id="agent-1"] turbo-frame')!;
      const workPane = document.querySelector<HTMLElement>('[data-workspace-pane-id="terminal:1"]')!;
      workPane.querySelector<HTMLTextAreaElement>("textarea")!.value = "unsaved command";
      // SAFETY: The test fixture owns this probe and initializes it before any assertion reads it.
      (window as typeof window & { targetedAgentProbe?: unknown }).targetedAgentProbe = { agentFrame, workPane };
    });

    await page.evaluate((stream) => window.Turbo!.renderStreamMessage(stream), agentTabsTurboStream(updated, { addedConversationId: "agent-2", selectConversationId: "agent-2" }));
    await page.waitForFunction(() => document.querySelector('[data-workspace-pane-id="agent-2"]')?.classList.contains("is-active"));
    expect(await page.getByRole("tab", { name: "Build" }).getAttribute("aria-selected")).toBe("true");
    expect(await page.evaluate(() => {
      // SAFETY: The preceding evaluation initializes this controlled probe with the asserted element shape.
      const probe = (window as typeof window & { targetedAgentProbe: { agentFrame: HTMLElement; workPane: HTMLElement } }).targetedAgentProbe;
      return {
        agentFrameKept: probe.agentFrame === document.querySelector('[data-workspace-pane-id="agent-1"] turbo-frame'),
        workPaneKept: probe.workPane === document.querySelector('[data-workspace-pane-id="terminal:1"]'),
        workDraft: probe.workPane.querySelector<HTMLTextAreaElement>("textarea")!.value,
      };
    })).toEqual({ agentFrameKept: true, workPaneKept: true, workDraft: "unsaved command" });
    await page.close();
  });

  test("keeps the visible Agent frame live while targeted actions converge in two browsers", async () => {
    const initial: WorkspacePresentation = {
      workspace: { id: "multi-agent", title: "Multi-browser Agent" },
      agentConversations: [agentConversation("multi-agent", "agent-1", "Plan")],
      workViews: [],
    };
    const updated: WorkspacePresentation = {
      ...initial,
      agentConversations: [...initial.agentConversations, agentConversation("multi-agent", "agent-2", "Build")],
    };
    const bodyRequests = [0, 0];
    const pages = [await newTestPage(), await newTestPage()];
    for (const [index, page] of pages.entries()) {
      await page.route("http://atelier.test/workspaces/multi-agent", (route) => route.fulfill({
        contentType: "text/html",
        body: `${renderShellFixture(initial, { projects: [] })}<script>
          window.agentCableEvents = [];
          document.addEventListener("atelier:workspace-preparation-invalidated", () => { document.body.dataset.multiAgentInvalidated = "true"; });
          window.AtelierCable = {
            subscribe(identifier, options) { window.agentCableEvents.push("subscribe:" + identifier.conversationId); requestAnimationFrame(() => options?.onReady?.()); },
            unsubscribe(identifier) { window.agentCableEvents.push("unsubscribe:" + identifier.conversationId); },
            connected() { return true; },
          };
        </script><script type="module" src="${workspaceClientPath}"></script>`,
      }));
      await page.route("**/workspaces/multi-agent/agents/agent-1/body", (route) => {
        bodyRequests[index] += 1;
        return route.fulfill({ contentType: "text/html", body: renderAgentBodyFrame("multi-agent", "agent-1", agentPaneBody("multi-agent", "agent-1", "<p>Initial Agent state</p>")) });
      });
      await page.route("**/attention/acknowledge*", (route) => route.fulfill({ status: 204 }));
      await page.goto("http://atelier.test/workspaces/multi-agent");
      await page.waitForFunction(() => document.querySelector('[data-workspace-pane-id="agent-1"] .agent-pane'));
      await page.waitForFunction(() => {
        // SAFETY: The controlled Cable fixture initializes this string array before application startup.
        return (window as typeof window & { agentCableEvents: string[] }).agentCableEvents.includes("subscribe:agent-1");
      });
      await page.locator('textarea[name="text"]').fill(`Browser ${index + 1} draft`);
      await page.evaluate(() => {
        // SAFETY: This browser fixture owns the retained frame probe for its lifetime.
        (window as typeof window & { multiAgentFrame?: Element }).multiAgentFrame = document.querySelector('[data-workspace-pane-id="agent-1"] turbo-frame')!;
        // SAFETY: The controlled Cable fixture initializes this string array before application startup.
        (window as typeof window & { agentCableEvents: string[] }).agentCableEvents = [];
      });
    }

    const broadcast = agentTabsTurboStream(updated, { addedConversationId: "agent-2" })
      + workspacePreparationInvalidatedTurboStream("multi-agent", "agent-1")
      + turboStream("update", "multi-agent_agent-1_transcript", "<p>Broadcast visible Agent action</p>");
    await Promise.all(pages.map(async (page) => await page.evaluate((html) => window.Turbo!.renderStreamMessage(html), broadcast)));

    for (const [index, page] of pages.entries()) {
      await page.getByText("Broadcast visible Agent action").waitFor();
      await page.waitForFunction(() => document.body.dataset.multiAgentInvalidated === "true");
      expect(await page.getByRole("tab", { name: "Build" }).count()).toBe(1);
      expect(await page.locator('textarea[name="text"]').inputValue()).toBe(`Browser ${index + 1} draft`);
      expect(bodyRequests[index]).toBe(1);
      expect(await page.evaluate(() => {
        // SAFETY: The browser fixture initialized both the retained frame and Cable-event probes above.
        const fixture = window as typeof window & { multiAgentFrame: Element; agentCableEvents: string[] };
        return {
          retained: fixture.multiAgentFrame === document.querySelector('[data-workspace-pane-id="agent-1"] turbo-frame'),
          cableEvents: fixture.agentCableEvents,
        };
      })).toEqual({ retained: true, cableEvents: [] });
      await page.close();
    }
  });

  test("preloads a closed working section when it is hovered", async () => {
    const ctx: AgentRenderContext = { workspaceId: "lazy-working", conversationId: "agent-lazy" };
    const historical: TranscriptItem = {
      type: "working",
      key: "worked",
      startedAt: 1_000,
      completedAt: 181_000,
      items: [{ type: "note", key: "activity", text: "Deferred historical activity", tone: "system" }],
    };
    const page = await newTestPage();
    let detailRequests = 0;
    await page.route("http://atelier.test/lazy-working", (route) => route.fulfill({
      contentType: "text/html",
      body: `<div>${renderTranscriptItem(ctx, historical)}</div><script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.route("**/workspaces/lazy-working/agents/agent-lazy/transcript-items/worked", (route) => {
      detailRequests += 1;
      return route.fulfill({ contentType: "text/html", body: renderTranscriptItemDetailFrame(ctx, historical) });
    });
    await page.goto("http://atelier.test/lazy-working");

    const working = page.locator(`#${agentIds.item(ctx, "worked")}`);
    expect(await working.getAttribute("open")).toBeNull();
    expect(await page.getByText("Deferred historical activity").count()).toBe(0);
    expect(detailRequests).toBe(0);

    await working.hover();
    await page.getByText("Deferred historical activity").waitFor({ state: "attached" });
    expect(await working.getAttribute("open")).toBeNull();
    expect(detailRequests).toBe(1);

    await working.locator(":scope > summary").click();
    await page.getByText("Deferred historical activity").waitFor();
    expect(detailRequests).toBe(1);
    await page.close();
  });

  test("preserves manual active Working and tool disclosure choices until the final answer", async () => {
    const ctx: AgentRenderContext = { workspaceId: "disclosure", conversationId: "agent-disclosure" };
    const runningTool: ToolView = { callId: "call-read", name: "read", args: { path: "README.md" }, status: "running", startedAt: 1_000 };
    const activeWorking: TranscriptItem = {
      type: "working",
      key: "working",
      startedAt: 1_000,
      live: true,
      items: [{ type: "tool", key: "tool", tool: runningTool }],
    };
    const transcriptId = agentIds.transcript(ctx);
    const workingId = agentIds.item(ctx, "working");
    const toolId = agentIds.item(ctx, "tool");
    const page = await newTestPage();
    await page.route("http://atelier.test/disclosure", (route) => route.fulfill({
      contentType: "text/html",
      body: `<div id="${transcriptId}">${renderTranscriptItem(ctx, activeWorking)}</div><script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.goto("http://atelier.test/disclosure");

    const working = page.locator(`#${workingId}`);
    const tool = page.locator(`#${toolId} details.agent-tool`);
    expect(await working.getAttribute("open")).toBe("");
    expect(await tool.getAttribute("open")).toBe("");

    await working.locator(":scope > summary").click();
    expect(await working.getAttribute("open")).toBeNull();
    const firstUpdate = renderActiveToolContent(ctx, "tool", { ...runningTool, args: { path: "docs/requirements.md" } });
    await page.evaluate((stream) => window.Turbo!.renderStreamMessage(stream),
      turboStream("update", agentIds.itemSummaryContent(ctx, "tool"), firstUpdate.summary)
      + turboStream("update", agentIds.detailFrame(ctx, "tool"), firstUpdate.detail ?? ""));
    expect(await working.getAttribute("open")).toBeNull();

    await working.locator(":scope > summary").click();
    expect(await tool.getAttribute("open")).toBe("");
    await tool.locator(":scope > summary").click();
    expect(await tool.getAttribute("open")).toBeNull();
    const secondUpdate = renderActiveToolContent(ctx, "tool", { ...runningTool, args: { path: "docs/final.md" } });
    await page.evaluate((stream) => window.Turbo!.renderStreamMessage(stream),
      turboStream("update", agentIds.itemSummaryContent(ctx, "tool"), secondUpdate.summary)
      + turboStream("update", agentIds.detailFrame(ctx, "tool"), secondUpdate.detail ?? ""));
    expect(await working.getAttribute("open")).toBe("");
    expect(await tool.getAttribute("open")).toBeNull();

    const completedWorking: TranscriptItem = {
      ...activeWorking,
      completedAt: 2_500,
      items: [{ type: "tool", key: "tool", tool: { ...runningTool, status: "ok", resultText: "Final file contents" } }],
    };
    const finalAnswer: TranscriptItem = { type: "text", key: "final", text: "Final answer is ready.", final: true };
    await page.evaluate((stream) => window.Turbo!.renderStreamMessage(stream),
      turboStream("replace", workingId, renderTranscriptItem(ctx, completedWorking))
      + turboStream("append", transcriptId, renderTranscriptItem(ctx, finalAnswer)));
    await page.getByText("Final answer is ready.").waitFor();
    expect(await working.getAttribute("open")).toBeNull();
    expect(await tool.getAttribute("open")).toBeNull();
    await page.close();
  });

  test("selects the Workspace requested by a creation stream", async () => {
    const first: WorkspacePresentation = {
      workspace: { id: "first", title: "First" },
      agentConversations: [agentConversation("first", "agent-1")],
      workViews: [],
    };
    const created: WorkspacePresentation = {
      workspace: { id: "created", title: "Created" },
      agentConversations: [agentConversation("created", "agent-2")],
      workViews: [],
    };
    const pane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [
      { id: "first", title: "First", active: true },
      { id: "created", title: "Created" },
    ] };
    const page = await newTestPage();
    await page.route("http://atelier.test/", (route) => route.fulfill({ contentType: "text/html", body: `${renderShellFixture(first, pane, [created])}<script type="module" src="${workspaceClientPath}"></script>` }));
    await page.route("**/active", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");

    await page.evaluate(() => window.Turbo!.renderStreamMessage('<turbo-stream action="select-workspace" target="workspace_detail" data-workspace-id="created"></turbo-stream>'));
    await page.waitForFunction(() => document.querySelector('.workspace-detail-resident[data-workspace-id="created"]')?.classList.contains("visible"));

    expect(new URL(page.url()).pathname).toBe("/workspaces/created");
    expect(await page.locator('[data-workspace-entry-id="created"]').getAttribute("aria-current")).toBe("page");
    await page.close();
  });

  test("Back and Forward restore cached Workspace selection", async () => {
    const pane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [
      { id: "history-a", title: "History A", active: true },
      { id: "history-b", title: "History B" },
    ] };
    const residents = `<div class="workspace-detail-resident visible" data-workspace-residency-target="resident" data-workspace-id="history-a">Cached A</div>
      <div class="workspace-detail-resident" data-workspace-residency-target="resident" data-workspace-id="history-b">Cached B</div>`;
    let residentRequests = 0;
    const page = await newTestPage();
    await page.route("http://atelier.test/workspaces/history-a", (route) => route.fulfill({
      contentType: "text/html",
      body: `${renderShellResidents(pane, residents)}<script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.route(/\/workspaces\/history-[ab]\?resident=1$/, (route) => {
      residentRequests += 1;
      const workspaceId = new URL(route.request().url()).pathname.split("/").at(-1)!;
      return route.fulfill({ contentType: "text/html", body: `<div class="workspace-detail-resident" data-workspace-residency-target="resident" data-workspace-id="${workspaceId}">Fetched ${workspaceId}</div>` });
    });
    await page.route("**/active", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/workspaces/history-a");
    await page.waitForFunction(() => document.querySelector('.workspace-detail-resident.visible[data-workspace-id="history-a"]'));

    await page.locator('[data-workspace-entry-id="history-b"]').evaluate((button: HTMLButtonElement) => button.click());
    await page.waitForFunction(() => document.querySelector('.workspace-detail-resident.visible[data-workspace-id="history-b"]'));
    expect(new URL(page.url()).pathname).toBe("/workspaces/history-b");

    await page.goBack();
    await page.waitForFunction(() => document.querySelector('.workspace-detail-resident.visible[data-workspace-id="history-a"]'));
    expect(new URL(page.url()).pathname).toBe("/workspaces/history-a");
    expect(await page.locator('[data-workspace-entry-id="history-a"]').getAttribute("aria-current")).toBe("page");

    await page.goForward();
    await page.waitForFunction(() => document.querySelector('.workspace-detail-resident.visible[data-workspace-id="history-b"]'));
    expect(new URL(page.url()).pathname).toBe("/workspaces/history-b");
    expect(await page.locator('[data-workspace-entry-id="history-b"]').getAttribute("aria-current")).toBe("page");
    expect(residentRequests).toBe(0);
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
      </div><script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.route("**/workspaces/demo/completion-catalog", (route) => route.fulfill({
      contentType: "text/html",
      body: '<div class="autocomplete-menu"><button class="agent-completion-option" data-completion-kind="prompt-template" data-command-trigger="/review">Review</button><button class="agent-completion-option" data-completion-kind="prompt-template" data-command-trigger="/simplify">Simplify</button></div>',
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
    const item = actionItemHtml({
      kind: "compound",
      label: { kind: "text", text: "Server" },
      container: { className: "fixed-shell-work-view-selector" },
      primary: { tag: "button", attributesHtml: 'type="button" role="tab" aria-selected="false" tabindex="-1" data-controller="atelier-fullscreen" data-atelier-fullscreen-mode-value="view" data-atelier-fullscreen-view-key-value="server" data-atelier-fullscreen-title-value="Server"' },
      engagedActionsHtml: '<button type="button">Close Server</button>',
    });
    await page.setContent(`<style>${workspaceStyle}</style><button type="button">Agent surface</button>${item}`);
    await page.addScriptTag({ url: `http://atelier.test${workspaceClientPath}`, type: "module" });
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

  test("grows an armed Work view tab toward inline-start and keeps it visible", async () => {
    const page = await newTestPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
    let closeRequests = 0;
    await page.route("http://atelier.test/close-server", (route) => {
      closeRequests += 1;
      return route.fulfill({ status: 204 });
    });
    const confirmation = destructiveConfirmationHtml({
      buttonHtml: '<button class="fixed-shell-view-close button danger icon-only" type="button" aria-label="Close Server">×</button>',
      confirmCaption: "Yes, close",
      cancelCaption: "Oops",
    });
    const item = actionItemHtml({
      kind: "compound",
      label: { kind: "text", text: "Server" },
      container: { className: "fixed-shell-work-view-selector" },
      primary: { tag: "button", attributesHtml: 'type="button" role="tab" aria-selected="true"' },
      engagedActionsHtml: `<form method="post" action="/close-server" data-turbo="true">${confirmation}</form>`,
    });
    await page.setContent(`<base href="http://atelier.test/"><style>${workspaceStyle}</style><div style="display:flex;width:110px;margin-left:200px">${item}</div>`);
    await page.addScriptTag({ url: `http://atelier.test${workspaceClientPath}`, type: "module" });
    await page.waitForFunction(() => document.querySelector(".destructive-confirmation")?.getAttribute("data-controller") === "destructive-confirmation");

    const close = page.getByRole("button", { name: "Close Server" });
    const tabBox = (await page.getByRole("tab", { name: "Server" }).locator("..").boundingBox())!;
    const closeBox = (await close.boundingBox())!;
    const pointer = { x: closeBox.x + closeBox.width / 2, y: closeBox.y + closeBox.height / 2 };
    await page.mouse.click(pointer.x, pointer.y);
    await page.waitForFunction(() => document.querySelector(".destructive-confirmation")?.getAttribute("data-destructive-confirmation-state") === "confirming");

    const decision = page.locator(".destructive-confirmation__decision");
    const decisionBox = (await decision.boundingBox())!;
    const armedTabBox = (await page.getByRole("tab", { name: "Server" }).locator("..").boundingBox())!;
    expect(armedTabBox.width).toBeGreaterThan(tabBox.width);
    expect(decisionBox.x).toBeGreaterThanOrEqual(armedTabBox.x);
    expect(decisionBox.x + decisionBox.width).toBeLessThanOrEqual(armedTabBox.x + armedTabBox.width);
    expect(Math.abs((armedTabBox.x + armedTabBox.width) - (tabBox.x + tabBox.width))).toBeLessThanOrEqual(1);
    const cancelBox = (await page.getByRole("button", { name: "Oops" }).boundingBox())!;
    expect(pointer.x).toBeGreaterThanOrEqual(cancelBox.x);
    expect(pointer.x).toBeLessThanOrEqual(cancelBox.x + cancelBox.width);
    expect(pointer.y).toBeGreaterThanOrEqual(cancelBox.y);
    expect(pointer.y).toBeLessThanOrEqual(cancelBox.y + cancelBox.height);
    await page.mouse.click(pointer.x, pointer.y);
    expect(closeRequests).toBe(0);

    await close.click();
    await page.mouse.move(640, 400);
    const closeRequest = page.waitForRequest("http://atelier.test/close-server");
    await page.getByRole("button", { name: "Yes, close" }).click();
    await closeRequest;
    expect(closeRequests).toBe(1);
    await page.close();
  });

  test("opens and closes a live Browser view with Atelier's fullscreen implementation", async () => {
    const page = await newTestPage();
    await page.setContent(`<style>${workspaceStyle}</style><div class="fixed-workspace-presentation is-work-pane-open" data-workspace-id="demo">
      <section class="fixed-shell-work-pane" style="height: 400px">
        <header><div class="fixed-shell-work-view-selectors"><button type="button" data-controller="atelier-fullscreen" data-atelier-fullscreen-mode-value="view" data-atelier-fullscreen-view-key-value="browser-1" data-atelier-fullscreen-title-value="Browser">Browser</button></div></header>
        <div class="fixed-shell-work-bodies"><section class="fixed-shell-surface is-active" data-workspace-pane-role="work" data-source-work-view-key="browser-1" data-atelier-fullscreen-view-key="browser-1"><button type="button">Preview content</button></section></div>
      </section>
    </div>`);
    await page.addScriptTag({ url: `http://atelier.test${workspaceClientPath}`, type: "module" });
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
      agentConversations: [agentConversation("deleted-demo", "agent-1")],
      workViews: [],
    };
    const pane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [{ id: "deleted-demo", title: "Delete me" }] };
    const page = await newTestPage();
    await page.route("http://atelier.test/workspaces/deleted-demo", (route) => route.fulfill({ contentType: "text/html", body: `${renderShellFixture(presentation, pane)}<script type="module" src="${workspaceClientPath}"></script>` }));
    await page.goto("http://atelier.test/workspaces/deleted-demo");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");
    await page.locator('[data-workspace-pane-id="agent-1"] turbo-frame').waitFor();

    await page.evaluate(() => window.Turbo!.renderStreamMessage('<turbo-stream action="remove-workspace-resident" target="fixed_workspace_deleted-demo"></turbo-stream>'));

    await page.waitForFunction(() => !document.querySelector('[data-workspace-id="deleted-demo"]'));
    expect(await page.locator('[data-workspace-pane-id="agent-1"]').count()).toBe(0);
    expect(await page.locator("[data-workspace-residency-target='empty']").getAttribute("hidden")).toBeNull();
    expect(new URL(page.url()).pathname).toBe("/");
    await page.close();
  });

  test("hides mobile navigation while the Agent composer is focused", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "mobile-compose", title: "Mobile compose" },
      agentConversations: [agentConversation("mobile-compose", "agent-1")],
      workViews: [],
    };
    const pane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [{ id: "mobile-compose", title: "Mobile compose", active: true }] };
    const page = await newTestPage({ viewport: { width: 390, height: 844 } });
    await page.route("http://atelier.test/workspaces/mobile-compose", (route) => route.fulfill({ contentType: "text/html", body: `<style>${workspaceStyle}</style>${renderShellFixture(presentation, pane)}<script type="module" src="${workspaceClientPath}"></script>` }));
    await page.route("**/workspaces/mobile-compose/agents/agent-1/body", (route) => route.fulfill({ contentType: "text/html", body: renderAgentBodyFrame("mobile-compose", "agent-1", '<div data-mobile-editing-region><textarea aria-label="Agent prompt"></textarea></div>') }));
    await page.route("**/workspaces/mobile-compose/active", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/workspaces/mobile-compose");

    const input = page.getByRole("textbox", { name: "Agent prompt" });
    const globalNavigation = page.locator(".fixed-shell-global-mobile-nav");
    expect(await globalNavigation.isVisible()).toBe(true);

    await input.focus();
    expect(await globalNavigation.isVisible()).toBe(false);

    await input.evaluate((textarea: HTMLTextAreaElement) => textarea.blur());
    expect(await globalNavigation.isVisible()).toBe(true);
    await page.close();
  });

  test("uses the phone keyboard Send key to submit a completed slash command without restoring composer focus", async () => {
    const agentBody = `<div class="agent-pane" data-controller="agent-pane agent-completions" data-agent-pane-workspace-id-value="phone-send" data-agent-pane-label-value="Agent" data-agent-completions-url-value="/workspaces/phone-send/agents/agent-1/completions">
      <div class="agent-transcript" data-agent-pane-target="transcript"></div>
      <div class="composer agent-pane-composer" data-mobile-editing-region>
        <form method="post" action="/send" data-agent-pane-target="form" data-action="turbo:submit-end->agent-pane#submitted">
          <textarea class="composer-input" aria-label="Agent prompt" enterkeyhint="send" data-agent-pane-target="input" data-agent-completions-target="input" data-action="keydown->agent-completions#keydown input->agent-completions#input keydown->agent-pane#inputKeydown input->agent-pane#promptChanged"></textarea>
          <button class="agent-sendstop" type="submit" name="mode" value="send" data-agent-pane-target="sendStop" data-agent-busy="false">Send</button>
        </form>
        <div class="agent-completion-menu-host" data-agent-completions-target="menu" hidden></div>
      </div>
    </div>`;
    const presentation: WorkspacePresentation = {
      workspace: { id: "phone-send", title: "Phone send" },
      agentConversations: [agentConversation("phone-send", "agent-1")],
      workViews: [],
    };
    const pane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [{ id: "phone-send", title: "Phone send", active: true }] };
    const page = await newTestPage({ viewport: { width: 900, height: 844 } });
    await page.route("http://atelier.test/workspaces/phone-send", (route) => route.fulfill({ contentType: "text/html", body: `${renderShellFixture(presentation, pane)}<script type="module" src="${workspaceClientPath}"></script>` }));
    await page.route("**/workspaces/phone-send/agents/agent-1/body", (route) => route.fulfill({ contentType: "text/html", body: renderAgentBodyFrame("phone-send", "agent-1", agentBody) }));
    await page.route("**/workspaces/phone-send/active", (route) => route.fulfill({ status: 204 }));
    await page.route("**/workspaces/phone-send/completion-catalog", (route) => route.fulfill({
      contentType: "text/html",
      body: renderSlashCommandCatalog([{ name: "repro", trigger: "/repro", description: "Reproduce mobile focus", prompt: "Expanded reproduction prompt" }], []),
    }));
    let releaseSendResponse!: () => void;
    const sendResponseReleased = new Promise<void>((resolve) => { releaseSendResponse = resolve; });
    await page.route("**/send", async (route) => {
      await sendResponseReleased;
      await route.fulfill({ status: 204 });
    });
    await page.goto("http://atelier.test/workspaces/phone-send");

    const input = page.locator(".composer-input");
    await input.fill("Desktop line");
    await input.press("Enter");
    await input.pressSequentially("Desktop continuation");
    expect(await input.inputValue()).toBe("Desktop line\nDesktop continuation");

    await input.fill("First line");
    await page.setViewportSize({ width: 390, height: 844 });
    await input.press("Shift+Enter");
    await input.pressSequentially("Second line");
    expect(await input.inputValue()).toBe("First line\nSecond line");

    await input.fill("/rep");
    await page.getByRole("option", { name: /\/repro/ }).waitFor();
    await input.press("Enter");
    expect(await input.inputValue()).toBe("/repro ");

    const sendRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/send");
    const sendResponseReceived = page.waitForResponse((response) => new URL(response.url()).pathname === "/send");
    await input.press("Enter");
    const request = await sendRequest;
    expect(request.postData()).toContain("mode=send");
    expect(await input.evaluate((element) => element !== document.activeElement)).toBe(true);

    releaseSendResponse();
    await sendResponseReceived;
    expect(await input.evaluate((element) => element !== document.activeElement)).toBe(true);
    await page.close();
  });

  test("keeps global mobile navigation available for a provisioning resident", async () => {
    const pane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [{ id: "starting", title: "Starting", active: true, state: "starting" }] };
    const shell = renderShellResidents(pane, '<div class="workspace-detail-resident workspace-boot visible" data-workspace-residency-target="resident" data-workspace-id="starting"><p>Preparing workspace…</p></div>');
    const page = await newTestPage({ viewport: { width: 390, height: 844 } });
    await page.route("http://atelier.test/workspaces/starting", (route) => route.fulfill({ contentType: "text/html", body: `<style>${workspaceStyle}</style>${shell}<script type="module" src="${workspaceClientPath}"></script>` }));
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
      agentConversations: [agentConversation("park-current", "agent-current")],
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
    await page.route("http://atelier.test/workspaces/park-current", (route) => route.fulfill({ contentType: "text/html", body: `${renderShellFixture(current, pane)}<script type="module" src="${workspaceClientPath}"></script>` }));
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

  test("opens the Work pane on the newest view requesting Attention during initial hydration", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "attention-demo", title: "Attention" },
      agentConversations: [agentConversation("attention-demo", "agent-1")],
      workViews: [
        { key: "files:workspace", label: "Files", kind: "contextual", attentionSequence: 3, availability: { phase: "live" }, bodyHtml: "<p>Files</p>" },
        { key: "browser:1", label: "Browser", kind: "resource", attentionSequence: 7, availability: { phase: "live" }, bodyHtml: "<p>Browser</p>" },
      ],
    };
    const page = await newTestPage({ viewport: { width: 1440, height: 900 } });
    await page.route("http://atelier.test/workspaces/attention-demo", (route) => route.fulfill({ contentType: "text/html", body: `<style>${workspaceStyle}</style><div class="workspace-detail-resident visible">${renderWorkspacePresentation(presentation)}</div><script type="module" src="${workspaceClientPath}"></script>` }));
    await page.goto("http://atelier.test/workspaces/attention-demo");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");

    expect(await page.getByRole("region", { name: "Work" }).isVisible()).toBe(true);
    expect(await page.locator('[data-work-view-key="browser:1"]').getAttribute("aria-selected")).toBe("true");
    await page.close();
  });

  test("restores personal Agent and Work navigation without relying on rendered Agent DOM", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "fixed-demo", title: "Fixed shell" },
      agentConversations: [
        agentConversation("fixed-demo", "agent-1", "Plan"),
        agentConversation("fixed-demo", "agent-2", "Build"),
      ],
      workViews: [
        { key: "terminal:1", label: "Terminal", kind: "resource", availability: { phase: "live" }, bodyHtml: "<p>Terminal</p>", close: { action: "/terminal/close", label: "Terminal" } },
        { key: "files:workspace", label: "Files", kind: "contextual", availability: { phase: "live" }, bodyHtml: "<p>Files</p>", close: { action: "/files/close", label: "Files" } },
      ],
    };
    const page = await newTestPage({ viewport: { width: 1440, height: 900 } });
    await page.route("http://atelier.test/workspaces/fixed-demo", (route) => route.fulfill({ contentType: "text/html", body: `${renderWorkspacePresentation(presentation)}<script type="module" src="${workspaceClientPath}"></script>` }));
    await page.route("**/attention/acknowledge*", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/workspaces/fixed-demo");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");

    expect(await page.locator(".fixed-workspace-presentation").getAttribute("class")).not.toContain("is-work-pane-open");
    await page.locator('[data-work-view-key="terminal:1"]').click({ force: true });
    await page.locator('[data-agent-conversation-id="agent-2"]').click();
    await page.reload();
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");
    expect(await page.locator('[data-agent-conversation-id="agent-2"]').getAttribute("aria-selected")).toBe("true");
    expect(await page.locator('[data-agent-conversation-id="agent-2"]').locator("..").getAttribute("class")).toContain("active");
    expect(await page.locator('[data-agent-conversation-id="agent-1"]').locator("..").getAttribute("class")).not.toContain("active");
    expect(await page.locator('[data-work-view-key="terminal:1"]').getAttribute("aria-selected")).toBe("true");
    expect(await page.locator(".fixed-workspace-presentation").getAttribute("class")).toContain("is-work-pane-open");
    await page.close();
  });

  test("gives viewport width changes to Work when it is open and Agent when it is closed", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "width-demo", title: "Pane widths" },
      agentConversations: [agentConversation("width-demo", "agent-1")],
      workViews: [{ key: "files:workspace", label: "Files", kind: "contextual", attentionSequence: 1, availability: { phase: "live" }, bodyHtml: "<p>Files</p>" }],
    };
    const pane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [{ id: "width-demo", title: "Pane widths", active: true }] };
    const page = await newTestPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => {
      sessionStorage.setItem("atelier:workspace-navigation:width-demo", JSON.stringify({ activeAgentId: "agent-1", activeWorkViewKey: "files:workspace", workPaneVisible: true, phoneDestination: "agents", drawers: [] }));
    });
    await page.route("http://atelier.test/workspaces/width-demo", (route) => route.fulfill({ contentType: "text/html", body: `<style>${workspaceStyle}</style>${renderShellFixture(presentation, pane)}<script type="module" src="${workspaceClientPath}"></script>` }));
    await page.route("**/attention/acknowledge*", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/workspaces/width-demo");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");
    await page.waitForFunction(() => document.querySelector('.workspace-detail-resident[data-workspace-id="width-demo"]')?.classList.contains("visible"));

    const widths = () => page.locator(".fixed-shell-workspace-pane, .fixed-shell-agent-pane, .fixed-shell-work-pane").evaluateAll((panes) => panes.map((pane) => pane.getBoundingClientRect().width));
    const openBefore = await widths();
    await page.setViewportSize({ width: 1600, height: 900 });
    const openAfter = await widths();
    expect(openAfter[0]).toBeCloseTo(openBefore[0]!, 0);
    expect(openAfter[1]).toBeCloseTo(openBefore[1]!, 0);
    expect(openAfter[2]! - openBefore[2]!).toBeCloseTo(160, 0);

    await page.setViewportSize({ width: 1100, height: 900 });
    await page.waitForFunction(() => {
      const presentation = document.querySelector(".fixed-workspace-presentation")!.getBoundingClientRect();
      const work = document.querySelector(".fixed-shell-work-pane")!.getBoundingClientRect();
      return work.right - presentation.right <= 1;
    });
    await page.setViewportSize({ width: 1600, height: 900 });

    await page.getByRole("button", { name: "Collapse Work pane" }).evaluate((button: HTMLButtonElement) => button.click());
    const closedBefore = (await widths()).slice(0, 2);
    await page.setViewportSize({ width: 1400, height: 900 });
    const closedAfter = (await widths()).slice(0, 2);
    expect(closedAfter[0]).toBeCloseTo(closedBefore[0]!, 0);
    expect(closedAfter[1]! - closedBefore[1]!).toBeCloseTo(-200, 0);
    await page.close();
  });

  test("deep links reveal Work only in the visible Workspace", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "deep-demo", title: "Deep link" },
      agentConversations: [agentConversation("deep-demo", "agent-1")],
      workViews: [
        { key: "files:workspace", label: "Files", kind: "contextual", availability: { phase: "live" }, bodyHtml: "<p>Files</p>" },
        { key: "browser:1", label: "Browser", kind: "resource", attentionSequence: 1, availability: { phase: "live" }, bodyHtml: "<p>Browser</p>" },
      ],
    };
    const page = await newTestPage({ viewport: { width: 1440, height: 900 } });
    await page.route("http://atelier.test/workspaces/deep-demo?workView=browser%3A1", (route) => route.fulfill({ contentType: "text/html", body: `<div class="workspace-detail-resident visible">${renderWorkspacePresentation(presentation)}</div><script type="module" src="${workspaceClientPath}"></script>` }));
    await page.goto("http://atelier.test/workspaces/deep-demo?workView=browser%3A1");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");
    expect(await page.locator(".fixed-workspace-presentation").getAttribute("class")).toContain("is-work-pane-open");
    expect(await page.locator('[data-work-view-key="browser:1"]').getAttribute("aria-selected")).toBe("true");

    await page.getByRole("tab", { name: "Files" }).click();
    expect(new URL(page.url()).searchParams.has("workView")).toBe(false);
    expect(await page.locator('[data-work-view-key="files:workspace"]').getAttribute("aria-selected")).toBe("true");
    await page.locator(".workspace-detail-resident").evaluate((resident) => resident.classList.remove("visible"));
    await page.evaluate(() => {
      const target = document.querySelector<HTMLElement>(".fixed-workspace-presentation")!;
      window.Turbo!.renderStreamMessage(`<turbo-stream action="present-work-view" target="${target.id}" data-work-view-key="browser:1"></turbo-stream>`);
    });
    expect(await page.locator('[data-work-view-key="files:workspace"]').getAttribute("aria-selected")).toBe("true");
    await page.close();
  });

  test("records an attention-seeking Work view as hidden intent and reveals it only with its Workspace", async () => {
    const pane: WorkspacePanePresentation = { projects: [{ id: "project", title: "Project", workspaces: [
      { id: "visible-demo", title: "Visible", active: true },
      { id: "present-demo", title: "Presented" },
    ] }] };
    const visible: WorkspacePresentation = {
      workspace: { id: "visible-demo", title: "Visible" },
      agentConversations: [agentConversation("visible-demo", "agent-visible")],
      workViews: [],
    };
    const cached: WorkspacePresentation = {
      workspace: { id: "present-demo", title: "Presented" },
      agentConversations: [agentConversation("present-demo", "agent-present")],
      workViews: [],
    };
    const intendedWork = { key: "browser:1", label: "Browser", kind: "resource", attentionSequence: 2, availability: { phase: "live" }, bodyHtml: "<p>Browser</p>" } as const;
    const page = await newTestPage({ viewport: { width: 1440, height: 900 } });
    await page.route("http://atelier.test/workspaces/visible-demo", (route) => route.fulfill({ contentType: "text/html", body: `<style>${workspaceStyle}</style>${renderShellFixture(visible, pane, [cached])}<script type="module" src="${workspaceClientPath}"></script>` }));
    await page.route("**/attention/acknowledge*", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/workspaces/visible-demo");
    await page.waitForFunction(() => document.querySelectorAll('[data-navigation-ready="true"]').length === 2);

    const stream = workViewsTurboStream("present-demo", [intendedWork], { openedKey: "browser:1", selectKey: "browser:1", intendSelection: true });
    await page.evaluate((html) => window.Turbo!.renderStreamMessage(html), stream);
    const cachedResident = page.locator('.workspace-detail-resident[data-workspace-id="present-demo"]');
    await cachedResident.locator('[data-work-view-key="browser:1"]').waitFor({ state: "attached" });
    expect(await cachedResident.locator('[data-work-view-key="browser:1"] [aria-label="Attention"]').count()).toBe(1);
    expect(await cachedResident.locator('[data-workspace-pane-id="browser:1"]').getAttribute("data-workspace-logically-visible")).toBe("false");
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("atelier:workspace-navigation:present-demo")!))).toMatchObject({
      activeWorkViewKey: "browser:1",
      workPaneVisible: true,
      phoneDestination: "work:browser:1",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.fixed-shell-workspace-pane [data-workspace-entry-id="present-demo"]').evaluate((button: HTMLButtonElement) => button.click());
    const resident = page.locator('.workspace-detail-resident[data-workspace-id="present-demo"]');
    await page.waitForFunction(() => document.querySelector('.workspace-detail-resident[data-workspace-id="present-demo"]')?.classList.contains("visible"));

    expect(await resident.locator(".fixed-workspace-presentation").getAttribute("class")).toContain("is-work-pane-open");
    const browserPane = resident.locator('[data-workspace-pane-role="work"][data-workspace-pane-id="browser:1"]');
    expect(await browserPane.getAttribute("data-workspace-logically-visible")).toBe("true");
    expect(await resident.locator('[data-workspace-pane-role="agent"]').getAttribute("data-workspace-logically-visible")).toBe("false");
    expect(await resident.locator(".fixed-workspace-presentation").getAttribute("data-phone-destination")).toBe("work:browser:1");
    await page.close();
  });

  test("finishes a visible Work preparation request only when the document is visible", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "visibility-attention", title: "Visibility attention" },
      agentConversations: [agentConversation("visibility-attention", "agent-visible")],
      workViews: [{ key: "browser:1", label: "Browser", kind: "resource", availability: { phase: "live" }, bodyHtml: "<p>Browser</p>" }],
    };
    const pane: WorkspacePanePresentation = { projects: [], projectlessWorkspaces: [{ id: "visibility-attention", title: "Visibility attention", active: true }] };
    const intendedWork = { key: "browser:1", label: "Browser", kind: "resource", attentionSequence: 1, availability: { phase: "live" }, bodyHtml: "<p>Browser</p>" } as const;
    const page = await newTestPage();
    await page.addInitScript(() => {
      // SAFETY: This isolated browser fixture owns the numeric event probe on window.
      const probe = window as typeof window & { preparationAcknowledgements: number };
      probe.preparationAcknowledgements = 0;
      document.addEventListener("atelier:workspace-preparation-request-acknowledged", () => {
        probe.preparationAcknowledgements += 1;
      });
    });
    await page.route("http://atelier.test/workspaces/visibility-attention", (route) => route.fulfill({
      contentType: "text/html",
      body: `${renderShellFixture(presentation, pane)}<script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.goto("http://atelier.test/workspaces/visibility-attention");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await page.evaluate((html) => window.Turbo!.renderStreamMessage(html), workViewsTurboStream("visibility-attention", [intendedWork], { openedKey: "browser:1", selectKey: "browser:1", intendSelection: true }));
    await page.waitForFunction(() => document.querySelector('[data-workspace-pane-id="browser:1"]')?.getAttribute("data-workspace-logically-visible") === "true");
    // SAFETY: The init script owns this numeric browser-test probe.
    expect(await page.evaluate(() => (window as typeof window & { preparationAcknowledgements: number }).preparationAcknowledgements)).toBe(0);

    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // SAFETY: The init script owns this numeric browser-test probe.
    await page.waitForFunction(() => (window as typeof window & { preparationAcknowledgements: number }).preparationAcknowledgements === 1);
    await page.close();
  });

  test("expands and collapses the parked Workspace count", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "active", title: "Active" },
      agentConversations: [agentConversation("active", "agent-1")],
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
      agentConversations: [agentConversation("parked-1", "agent-parked")],
      workViews: [],
    };
    let unparkRequests = 0;
    const page = await newTestPage({ viewport: { width: 1000, height: 700 } });
    await page.addInitScript(() => localStorage.removeItem("atelier:workspace-project-disclosures"));
    await page.route("http://atelier.test/", (route) => route.fulfill({ contentType: "text/html", body: `<style>${workspaceStyle}</style>${renderShellFixture(presentation, pane)}<script type="module" src="${workspaceClientPath}"></script>` }));
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

  test("starts the Projects section collapsed and preserves its expanded state across updates", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "used-workspace", title: "Used workspace" },
      agentConversations: [agentConversation("used-workspace", "agent-1")],
      workViews: [],
    };
    const pane: WorkspacePanePresentation = {
      projects: [],
      projectlessWorkspaces: [{ id: "used-workspace", title: "Used workspace", active: true }],
      emptyProjects: [
        { id: "used-1", title: "Used one" },
        { id: "unused-1", title: "Unused one" },
        { id: "unused-2", title: "Unused two" },
      ],
    };
    const page = await newTestPage({ viewport: { width: 1000, height: 700 } });
    await page.addInitScript(() => localStorage.removeItem("atelier:workspace-project-disclosures"));
    await page.route("http://atelier.test/", (route) => route.fulfill({ contentType: "text/html", body: `<style>${workspaceStyle}</style>${renderShellFixture(presentation, pane)}<script type="module" src="${workspaceClientPath}"></script>` }));
    await page.goto("http://atelier.test/");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");
    await page.evaluate(() => new Promise(requestAnimationFrame));

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
    await page.evaluate(() => new Promise(requestAnimationFrame));
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
      agentConversations: [agentConversation(id, `agent-${id}`)],
      workViews: [],
    });
    const pane: WorkspacePanePresentation = { projects: [{ id: "project", title: "Project", workspaces: [
      { id: "a", title: "Workspace a", active: true },
      { id: "b", title: "Workspace b" },
    ] }] };
    const page = await newTestPage({ viewport: { width: 1000, height: 700 } });
    await page.route("http://atelier.test/workspaces/a", (route) => route.fulfill({ contentType: "text/html", body: `<style>${workspaceStyle}</style>${renderShellFixture(makePresentation("a"), pane, [makePresentation("b")])}<script type="module" src="${workspaceClientPath}"></script>` }));
    await page.goto("http://atelier.test/workspaces/a");
    await page.waitForFunction(() => document.querySelectorAll('[data-navigation-ready="true"]').length === 2);
    const residentB = page.locator('.workspace-detail-resident[data-workspace-id="b"]');

    await page.locator('[data-workspace-entry-id="b"]').evaluate((button: HTMLButtonElement) => button.click());

    await page.waitForFunction(() => document.querySelector('.workspace-detail-resident[data-workspace-id="b"]')?.classList.contains("visible"));
    expect(await page.locator(".fixed-shell-workspace-pane").count()).toBe(1);
    expect(await residentB.locator(".fixed-shell-workspace-pane").count()).toBe(0);
    await page.close();
  });

  test("collapses the Workspace pane and restores it from the Agent header", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "workspace-pane-demo", title: "Workspace pane" },
      agentConversations: [agentConversation("workspace-pane-demo", "agent-1")],
      workViews: [],
    };
    const page = await newTestPage({ viewport: { width: 1440, height: 900 } });
    await page.route("http://atelier.test/workspaces/workspace-pane-demo", (route) => route.fulfill({ contentType: "text/html", body: `<style>${workspaceStyle}</style>${renderShellFixture(presentation, { projects: [] })}<script type="module" src="${workspaceClientPath}"></script>` }));
    await page.goto("http://atelier.test/workspaces/workspace-pane-demo");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");
    await page.waitForFunction(() => document.querySelector('.workspace-detail-resident[data-workspace-id="workspace-pane-demo"]')?.classList.contains("visible"));

    const collapse = page.getByRole("button", { name: "Collapse Workspace pane" });
    await collapse.evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.locator(".fixed-shell-workspace-pane").isHidden()).toBe(true);
    const show = page.getByRole("button", { name: "Show Workspace pane" });
    expect(await show.isVisible()).toBe(true);
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Show Workspace pane");

    await show.evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.locator(".fixed-shell-workspace-pane").isVisible()).toBe(true);
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Collapse Workspace pane");
    await page.close();
  });

  test("reveals and collapses the Work pane", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "motion-demo", title: "Motion" },
      agentConversations: [agentConversation("motion-demo", "agent-1")],
      workViews: [{ key: "browser:1", label: "Browser", kind: "resource", availability: { phase: "live" }, bodyHtml: "<p>Browser</p>" }],
    };
    const page = await newTestPage({ viewport: { width: 1440, height: 900 } });
    await page.route("http://atelier.test/workspaces/motion-demo", (route) => route.fulfill({ contentType: "text/html", body: `<style>${workspaceStyle}</style>${renderShellFixture(presentation, { projects: [] })}<script type="module" src="${workspaceClientPath}"></script>` }));
    await page.goto("http://atelier.test/workspaces/motion-demo");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");
    await page.waitForFunction(() => document.querySelector('.workspace-detail-resident[data-workspace-id="motion-demo"]')?.classList.contains("visible"));
    expect(await page.getByRole("button", { name: "Show Work pane" }).isVisible()).toBe(true);

    await page.getByRole("button", { name: "Show Work pane" }).evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.locator(".fixed-workspace-presentation").getAttribute("class")).toContain("is-work-pane-open");
    expect(await page.getByRole("button", { name: "Collapse Work pane" }).isVisible()).toBe(true);

    await page.getByRole("button", { name: "Collapse Work pane" }).evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.locator(".fixed-workspace-presentation").getAttribute("class")).not.toContain("is-work-pane-open");
    expect(await page.getByRole("button", { name: "Show Work pane" }).isVisible()).toBe(true);
    await page.close();
  });

  test("closes the mobile More menu after launching a new terminal", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "mobile-launcher", title: "Mobile launcher" },
      agentConversations: [agentConversation("mobile-launcher", "agent-1")],
      workViews: [],
      commands: [{ id: "terminal.create", label: "New Terminal", scope: "workspace", placement: "work-launcher" }],
    };
    const page = await newTestPage({ viewport: { width: 340, height: 844 } });
    await page.route("http://atelier.test/workspaces/mobile-launcher", (route) => route.fulfill({ contentType: "text/html", body: `<style>${workspaceStyle}</style>${renderShellFixture(presentation, { projects: [] })}<script type="module" src="${workspaceClientPath}"></script>` }));
    await page.route("**/workspaces/mobile-launcher/agents/agent-1/body", (route) => route.fulfill({ contentType: "text/html", body: renderAgentBodyFrame("mobile-launcher", "agent-1", agentPaneBody("mobile-launcher", "agent-1")) }));
    await page.route("**/workspaces/mobile-launcher/commands/terminal.create", (route) => route.fulfill({ contentType: "text/vnd.turbo-stream.html", body: "" }));
    await page.goto("http://atelier.test/workspaces/mobile-launcher");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");

    const moreButton = page.getByRole("button", { name: "More" });
    const moreMenu = page.getByRole("menu", { name: "More" });
    await moreButton.click();
    await moreMenu.getByRole("menuitem", { name: "New Terminal" }).click();

    expect(await moreMenu.isHidden()).toBe(true);
    expect(await moreButton.getAttribute("aria-expanded")).toBe("false");
    await page.close();
  });

  test("keeps the single-pane phone layout in landscape", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "landscape-phone", title: "Landscape phone" },
      agentConversations: [agentConversation("landscape-phone", "agent-1")],
      workViews: [{ key: "browser:preview", label: "Browser", kind: "resource", availability: { phase: "live" }, bodyHtml: "<p>Browser</p>" }],
    };
    const page = await newTestPage({ viewport: { width: 844, height: 390 }, mobile: true });
    await page.route("http://atelier.test/workspaces/landscape-phone", (route) => route.fulfill({ contentType: "text/html", body: `<style>${workspaceStyle}</style>${renderShellFixture(presentation, { projects: [] })}<script type="module" src="${workspaceClientPath}"></script>` }));
    await page.goto("http://atelier.test/workspaces/landscape-phone");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");

    await page.locator(".fixed-workspace-presentation .fixed-shell-mobile-nav").waitFor({ state: "visible" });
    await page.locator(".fixed-shell-agent-pane").waitFor({ state: "visible" });
    expect(await page.locator(".fixed-shell-workspace-pane").isVisible()).toBe(false);
    expect(await page.locator(".fixed-shell-work-pane").isVisible()).toBe(false);
    await page.close();
  });

  test("prioritizes Agents, Browser, and Review in mobile navigation and moves surplus Work views into More", async () => {
    const presentation: WorkspacePresentation = {
      workspace: { id: "phone-demo", title: "Phone" },
      agentConversations: [
        agentConversation("phone-demo", "agent-1", "First Agent"),
        agentConversation("phone-demo", "agent-2", "Second Agent"),
      ],
      workViews: [
        { key: "terminal:1", label: "Terminal", kind: "resource", availability: { phase: "live" }, bodyHtml: '<textarea data-probe="terminal">command</textarea>', close: { action: "/terminal/close", label: "Terminal Work view" } },
        { key: "files:workspace", label: "Files", kind: "contextual", attentionSequence: 1, availability: { phase: "live" }, bodyHtml: "<p>Files</p>", close: { action: "/files/close", label: "Files Work view" } },
        { key: "browser:preview", label: "Browser", kind: "resource", availability: { phase: "live" }, bodyHtml: "<p>Browser</p>" },
        { key: "review:workspace", label: "Review", kind: "contextual", availability: { phase: "live" }, bodyHtml: "<p>Review</p>" },
        { key: "terminal:2", label: "Terminal 2", kind: "resource", attentionSequence: 2, availability: { phase: "live" }, bodyHtml: "<p>Terminal 2</p>", close: { action: "/terminal-2/close", label: "Terminal 2 Work view" } },
      ],
      commands: [{ id: "files.create", label: "New Files", scope: "workspace", placement: "work-launcher" }, { id: "terminal.create", label: "New Terminal", scope: "workspace", placement: "work-launcher" }],
    };
    const page = await newTestPage({ viewport: { width: 340, height: 844 } });
    await page.route("http://atelier.test/workspaces/phone-demo", (route) => route.fulfill({ contentType: "text/html", body: `<style>${workspaceStyle}</style>${renderShellFixture(presentation, { projects: [] })}<script>
      window.AtelierCable = { subscribe() {}, unsubscribe() {}, connected() { return true; } };
    </script><script type="module" src="${workspaceClientPath}"></script>` }));
    await page.route("**/workspaces/phone-demo/agents/*/body", (route) => {
      const match = new URL(route.request().url()).pathname.match(/agents\/([^/]+)\/body$/);
      if (!match) throw new Error("expected Agent body route");
      const conversationId = decodeURIComponent(match[1]!);
      return route.fulfill({ contentType: "text/html", body: renderAgentBodyFrame("phone-demo", conversationId, agentPaneBody("phone-demo", conversationId)) });
    });
    await page.route("**/attention/acknowledge*", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/workspaces/phone-demo");
    await page.waitForFunction(() => document.querySelector(".fixed-workspace-presentation")?.getAttribute("data-navigation-ready") === "true");
    const mobileNavigation = page.locator(".fixed-workspace-presentation .fixed-shell-mobile-nav");
    expect(await mobileNavigation.getAttribute("class")).toContain("button-group");
    expect(await mobileNavigation.evaluate((element) => getComputedStyle(element).gap)).toBe("8px");
    const mobileDestinations = mobileNavigation.locator("[data-mobile-destination], [data-mobile-more]");
    expect(await mobileDestinations.evaluateAll((destinations) => destinations.every((destination) => destination.classList.contains("action-item") && destination.classList.contains("action-item__primary")))).toBe(true);
    expect(await mobileNavigation.locator(".fixed-shell-mobile-scroll").getAttribute("class")).toContain("button-group");
    const mobileDestinationHeights = await mobileDestinations.evaluateAll((destinations) => destinations.filter((destination) => !destination.hasAttribute("hidden")).map((destination) => destination.getBoundingClientRect().height));
    expect(new Set(mobileDestinationHeights).size).toBe(1);
    await page.locator('[data-mobile-destination="agents"]').waitFor({ state: "visible" });
    await page.locator('[data-mobile-destination="work:browser:preview"]').waitFor({ state: "visible" });
    await page.locator('[data-mobile-destination="work:review:workspace"]').waitFor({ state: "visible" });
    expect(await page.locator('[data-mobile-destination="work:terminal:2"]').isHidden()).toBe(true);
    const workspaceDestination = page.locator("[data-mobile-workspace-destination]");
    await workspaceDestination.evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.locator(".fixed-shell-app").getAttribute("class")).toContain("is-mobile-workspace-pane-open");
    expect(await workspaceDestination.getAttribute("aria-expanded")).toBe("true");
    expect(await page.locator(".fixed-shell-workspace-pane").evaluate((pane) => getComputedStyle(pane).visibility)).toBe("visible");
    await workspaceDestination.evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.locator(".fixed-shell-app").getAttribute("class")).not.toContain("is-mobile-workspace-pane-open");
    expect(await workspaceDestination.getAttribute("aria-expanded")).toBe("false");
    await page.locator('[data-more-work-key="terminal:2"]').evaluate((button: HTMLButtonElement) => button.click());
    const workspaceUpdate = workspacePaneCollectionsTurboStream({ projects: [], projectlessWorkspaces: [{ id: "phone-demo", title: "Phone" }, { id: "new-mobile-workspace", title: "New mobile workspace" }] });
    await page.evaluate((stream) => window.Turbo!.renderStreamMessage(stream), workspaceUpdate);
    await page.getByRole("button", { name: "New mobile workspace", includeHidden: true }).waitFor({ state: "attached" });
    expect(await page.locator('[data-mobile-destination="work:terminal:2"]').isHidden()).toBe(true);
    expect(await page.locator('[data-mobile-more] [aria-label="Hidden Attention"]').count()).toBe(1);
    await page.locator("[data-mobile-more]").evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.getByRole("menuitem", { name: "Close current view" }).count()).toBe(1);
    await page.locator("[data-mobile-more]").evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.locator('[data-more-work-key="terminal:2"]').count()).toBe(1);
    expect(await page.locator(".fixed-shell-mobile-fixed, .fixed-shell-mobile-scroll > button").evaluateAll((buttons) => buttons.every((button) => !button.textContent?.trim()))).toBe(true);
    expect(await page.locator('[data-mobile-destination="work:terminal:1"] svg').count()).toBe(1);
    const agentsDestination = page.locator('[data-mobile-destination="agents"]');
    expect(await agentsDestination.count()).toBe(1);
    await agentsDestination.evaluate((button: HTMLButtonElement) => button.click());
    const agentHeader = page.locator(".fixed-shell-agent-pane > header");
    expect(await agentHeader.isVisible()).toBe(true);
    const firstAgentTab = agentHeader.getByRole("tab", { name: "First Agent" });
    expect(await firstAgentTab.isVisible()).toBe(true);
    expect(await agentHeader.getByRole("button", { name: "Park workspace" }).isVisible()).toBe(true);
    expect(await agentHeader.getByRole("button", { name: "Delete workspace" }).isVisible()).toBe(true);
    expect(await agentHeader.getByRole("button", { name: "Show Work pane" }).isHidden()).toBe(true);
    const firstComposer = page.locator('[data-workspace-pane-id="agent-1"] textarea[name="text"]');
    await firstComposer.waitFor();
    expect(await firstComposer.evaluate((input) => input === document.activeElement)).toBe(false);
    await agentHeader.getByRole("tab", { name: "Second Agent" }).evaluate((button: HTMLButtonElement) => button.click());
    const secondComposer = page.locator('[data-workspace-pane-id="agent-2"] textarea[name="text"]');
    await secondComposer.waitFor();
    expect(await secondComposer.evaluate((input) => input === document.activeElement)).toBe(false);
    expect(await page.locator(".fixed-shell-workspace-pane, .fixed-shell-agent-pane, .fixed-shell-work-pane").evaluateAll((panes) => panes.map((pane) => getComputedStyle(pane).visibility))).toEqual(["hidden", "visible", "hidden"]);
    await page.locator("[data-mobile-more]").evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.getByRole("menuitem", { name: "Close current view" }).count()).toBe(0);
    await page.locator("[data-mobile-more]").evaluate((button: HTMLButtonElement) => button.click());
    await page.locator('[data-mobile-destination="work:terminal:1"]').evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.locator(".fixed-shell-workspace-pane, .fixed-shell-agent-pane, .fixed-shell-work-pane").evaluateAll((panes) => panes.map((pane) => getComputedStyle(pane).visibility))).toEqual(["hidden", "hidden", "visible"]);
    await agentsDestination.evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.locator('[data-workspace-pane-role="agent"][data-workspace-pane-id="agent-2"]').getAttribute("class")).toContain("is-active");
    await page.locator('[data-mobile-destination="work:terminal:1"]').evaluate((button: HTMLButtonElement) => button.click());
    await page.locator("[data-mobile-more]").evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.getByRole("menuitem", { name: "Close current view" }).count()).toBe(1);
    expect(await page.locator(".fixed-shell-more-scrim").count()).toBe(0);
    expect(await page.getByRole("heading", { name: "Secondary Work views" }).count()).toBe(0);
    expect(await page.getByRole("menu", { name: "More" }).isVisible()).toBe(true);
    expect(await page.locator('[data-more-work-key="terminal:2"] .fixed-shell-work-view-icon[data-icon="terminal"]').count()).toBe(1);
    await page.locator('[data-more-work-key="terminal:2"]').evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.locator(".fixed-workspace-presentation").getAttribute("data-phone-destination")).toBe("work:terminal:2");
    expect(await page.locator("[data-mobile-more]").getAttribute("aria-current")).toBe("page");
    expect(await page.locator('[data-mobile-destination="work:terminal:2"]').isHidden()).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.setViewportSize({ width: 340, height: 844 });
    expect(await page.locator('[data-work-view-key="terminal:2"]').getAttribute("aria-selected")).toBe("true");
    await page.close();
  });

  test("recalls LaunchComposer prompts globally across projects", async () => {
    const page = await newTestPage();
    const composer = (project: string, prompt = "") => `<dialog data-controller="launch-composer-dialog"><h1>${project}</h1><form data-action="submit->launch-composer-dialog#submit:prevent"><textarea name="text">${prompt}</textarea></form></dialog>`;
    await page.addInitScript(() => localStorage.removeItem("atelier:launch-composer-prompt-history"));
    await page.route("http://atelier.test/", (route) => route.fulfill({ contentType: "text/html", body: `<main id="host">${composer("Project one", "First project's launch prompt")}</main><script type="module" src="${workspaceClientPath}"></script>` }));

    const waitForComposer = () => page.locator("dialog[data-controller='launch-composer-dialog'][open]").waitFor();
    await page.goto("http://atelier.test/");
    await waitForComposer();
    await page.locator("form").dispatchEvent("submit");
    await page.locator("#host").evaluate((host, nextComposer) => { host.innerHTML = nextComposer; }, composer("Project two"));
    await waitForComposer();
    const input = page.getByRole("textbox");
    await input.press("ArrowUp");

    expect(await input.inputValue()).toBe("First project's launch prompt");
    await input.press("ArrowDown");
    expect(await input.inputValue()).toBe("");
    await page.close();
  });

  test("uses the phone keyboard Send key to submit the LaunchComposer", async () => {
    const page = await newTestPage({ viewport: { width: 900, height: 844 } });
    await page.route("http://atelier.test/", (route) => route.fulfill({
      contentType: "text/html",
      body: `<turbo-frame id="launch_composer"><dialog class="launch-composer-dialog" data-controller="launch-composer-dialog submit-shortcut" data-launch-composer-dialog-discard-url-value="/draft/discard"><form method="post" action="/launch" data-action="keydown->submit-shortcut#keydown submit->submit-shortcut#submit submit->launch-composer-dialog#submit turbo:submit-end->submit-shortcut#submitted"><textarea name="text" enterkeyhint="send"></textarea><button type="submit">Send prompt</button></form></dialog></turbo-frame><script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.route("http://atelier.test/launch", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/");

    const input = page.getByRole("textbox");
    await input.fill("Desktop line");
    await input.press("Enter");
    await input.pressSequentially("Desktop continuation");
    expect(await input.inputValue()).toBe("Desktop line\nDesktop continuation");

    await page.setViewportSize({ width: 390, height: 844 });
    await input.fill("First line");
    await input.press("Shift+Enter");
    await input.pressSequentially("Second line");
    expect(await input.inputValue()).toBe("First line\nSecond line");

    const launchRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/launch");
    await input.press("Enter");
    expect((await launchRequest).postData()).toContain("text=First+line%0ASecond+line");
    expect(await page.locator(".launch-composer-dialog").evaluate((dialog: HTMLDialogElement) => dialog.open)).toBe(false);
    await page.close();
  });

  test("closes the LaunchComposer as soon as its prompt is submitted", async () => {
    const page = await newTestPage({ viewport: { width: 390, height: 844 } });
    let finishRequest!: () => void;
    const requestMayFinish = new Promise<void>((resolve) => { finishRequest = resolve; });
    let discardRequests = 0;
    await page.route("http://atelier.test/", (route) => route.fulfill({
      contentType: "text/html",
      body: `<turbo-frame id="launch_composer"><dialog class="launch-composer-dialog" data-controller="launch-composer-dialog" data-launch-composer-dialog-discard-url-value="/draft/discard"><form method="post" action="/launch" data-action="submit->launch-composer-dialog#submit"><textarea name="text">Mobile prompt</textarea><button type="submit">Send prompt</button></form></dialog></turbo-frame><script type="module" src="${workspaceClientPath}"></script>`,
    }));
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
