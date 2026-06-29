import { escapeHtml, turboStream, turboStreamResponse, type WorkspaceModule, type WorkspaceServerModuleContext } from "@atelier/shared";
import { targetImage, updaterPort, updateSidebarContributionId } from "./constants.ts";
import { detectSelfUpdateRuntime, dockerExec, pullStableImage, type DockerExec, type PullProgress, type SelfUpdateRuntime } from "./docker.ts";
import { fetchStableImageMetadata, type ImageMetadata } from "./registry.ts";
import { fetchReleaseNotes } from "./release-notes.ts";

export type UpdateState = "idle" | "available" | "pulling" | "ready_to_restart" | "failed" | "restarting";

export interface StateSnapshot {
  state: UpdateState;
  percent?: number;
  error?: string;
  selfUpdatable: boolean;
  currentRevision?: string;
  target?: ImageMetadata;
}

export interface UpdateManagerDeps {
  detectRuntime?: () => Promise<SelfUpdateRuntime | undefined>;
  fetchMetadata?: () => Promise<ImageMetadata>;
  pullImage?: (onProgress: (progress: PullProgress) => void) => Promise<void>;
  fetchNotes?: (currentSha: string | undefined, stableSha: string | undefined) => Promise<string>;
  docker?: DockerExec;
  waitForUpdater?: (url: string) => Promise<void>;
  setInterval?: typeof setInterval;
}

export class UpdateManager {
  private context: WorkspaceServerModuleContext | undefined;
  private runtime: SelfUpdateRuntime | undefined;
  private state: UpdateState = "idle";
  private percent: number | undefined;
  private error: string | undefined;
  private target: ImageMetadata | undefined;
  private pullPromise: Promise<void> | undefined;
  private restarting = false;
  private releaseNotesHtml: string | undefined;
  private readonly subscribers = new Set<(snapshot: StateSnapshot) => void>();

  constructor(private readonly deps: UpdateManagerDeps = {}) {}

  async initialize(context: WorkspaceServerModuleContext): Promise<void> {
    this.context = context;
    this.runtime = await (this.deps.detectRuntime ?? detectSelfUpdateRuntime)();
    this.updateSidebar();
    if (!this.runtime) return;
    await this.checkNow();
    const interval = (this.deps.setInterval ?? setInterval)(() => void this.checkNow().catch((error) => this.fail(error)), 5 * 60 * 1000);
    interval.unref?.();
  }

  snapshot(): StateSnapshot {
    return { state: this.state, percent: this.percent, error: this.error, selfUpdatable: Boolean(this.runtime), currentRevision: this.runtime?.currentRevision, target: this.target };
  }

  subscribe(handler: (snapshot: StateSnapshot) => void): () => void {
    this.subscribers.add(handler);
    handler(this.snapshot());
    return () => this.subscribers.delete(handler);
  }

  private visible(): boolean {
    return Boolean(this.runtime) && this.state !== "idle";
  }

  private notify(): void {
    const snapshot = this.snapshot();
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(snapshot);
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
  }

  private updateSidebar(): void {
    this.context?.globalSidebarContributions.set(updateSidebarContributionId, this.visible() ? renderSidebarRow(this.snapshot()) : undefined);
    this.notify();
  }

  private setState(state: UpdateState, options: { percent?: number; error?: string } = {}): void {
    this.state = state;
    this.percent = options.percent;
    this.error = options.error;
    this.updateSidebar();
  }

  private fail(error: unknown): void {
    this.setState("failed", { error: error instanceof Error ? error.message : String(error) });
  }

  async checkNow(): Promise<void> {
    if (!this.runtime) return;
    const target = await (this.deps.fetchMetadata ?? fetchStableImageMetadata)();
    const oldDigest = this.target?.digest;
    this.target = target;
    this.releaseNotesHtml = undefined;
    const current = this.runtime.currentRevision ?? this.runtime.currentDigest;
    const remote = target.revision ?? target.digest;
    const available = Boolean(remote && current && remote !== current);
    if (!available) this.setState("idle");
    else if (this.state === "idle") this.setState("available");
    else if (this.state === "ready_to_restart" && oldDigest && oldDigest !== target.digest) await this.startPull();
    else this.updateSidebar();
  }

  async startPull(): Promise<void> {
    if (!this.runtime) throw new Error("Atelier is not running in a self-updatable Docker container");
    if (this.pullPromise) return await this.pullPromise;
    this.setState("pulling", { percent: undefined });
    this.pullPromise = (this.deps.pullImage ?? pullStableImage)((progress) => {
      this.percent = progress.percent;
      this.updateSidebar();
    }).then(() => {
      this.setState("ready_to_restart", { percent: 100 });
    }).catch((error) => {
      this.fail(error);
    }).finally(() => {
      this.pullPromise = undefined;
    });
    return await this.pullPromise;
  }

  async releaseNotes(): Promise<string> {
    if (this.releaseNotesHtml) return this.releaseNotesHtml;
    this.releaseNotesHtml = await (this.deps.fetchNotes ?? fetchReleaseNotes)(this.runtime?.currentRevision, this.target?.revision);
    return this.releaseNotesHtml;
  }

  async launchUpdater(url: URL): Promise<Response> {
    if (!this.runtime) throw new Error("Atelier is not running in a self-updatable Docker container");
    if (this.restarting) throw new Error("Restart is already in progress");
    if (this.state !== "ready_to_restart") throw new Error("No pulled update is ready to restart");
    this.restarting = true;
    this.setState("restarting");
    const name = `atelier-updater-${crypto.randomUUID().slice(0, 8)}`;
    const host = url.hostname;
    const result = await (this.deps.docker ?? dockerExec)([
      "run", "-d", "--rm", "--name", name, "--network", "host",
      "-v", "/var/run/docker.sock:/var/run/docker.sock",
      this.runtime.imageId,
      "atelier-update-helper", "--server-container", this.runtime.containerId, "--target-image", targetImage, "--return-host", host,
    ]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || "could not start update helper");
    const theme = url.searchParams.get("theme") ?? "";
    const updaterUrl = `http://${host}:${updaterPort}`;
    await (this.deps.waitForUpdater ?? waitForUpdater)(`${updaterUrl}/up`);
    return Response.redirect(`${updaterUrl}/?theme=${encodeURIComponent(theme)}`, 303);
  }

  sseResponse(): Response {
    let unsubscribe = () => {};
    const stream = new ReadableStream({
      start: (controller) => {
        const encoder = new TextEncoder();
        const send = (snapshot: StateSnapshot) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`));
        unsubscribe = this.subscribe(send);
      },
      cancel: () => unsubscribe(),
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" } });
  }
}

async function waitForUpdater(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(url).catch(() => undefined);
    if (response?.ok) return;
    await Bun.sleep(250);
  }
  throw new Error("Update helper did not become ready within 30 seconds");
}

const manager = new UpdateManager();

function progressBar(percent?: number): string {
  const style = typeof percent === "number" ? ` style="width:${percent}%"` : "";
  return `<div class="update-sidebar-progress${percent === undefined ? " indeterminate" : ""}" aria-label="Pulling update" title="Pulling update…"><span${style}></span></div>`;
}

export function renderSidebarRow(snapshot: StateSnapshot): string {
  const dataState = snapshot.state === "ready_to_restart" ? "ready" : snapshot.state === "failed" ? "failed" : snapshot.state;
  const whatsNew = `<form method="get" action="/update/whats-new" data-turbo="true"><button class="update-sidebar-link" type="submit">What’s new</button></form>`;
  const left = snapshot.state === "pulling"
    ? `<div class="update-sidebar-left pulling">${progressBar(snapshot.percent)}</div>`
    : snapshot.state === "ready_to_restart"
      ? `<form method="get" action="/update/restart-confirm" data-turbo="true"><button class="update-sidebar-button ready" type="submit">Restart to update</button></form>`
      : snapshot.state === "failed"
        ? `<form method="post" action="/update/start" data-turbo="true"><button class="update-sidebar-button failed" type="submit">Retry update</button></form>`
        : `<form method="post" action="/update/start" data-turbo="true"><button class="update-sidebar-button" type="submit">Update Atelier</button></form>`;
  return `<section class="update-sidebar-section"><div id="update_sidebar_row" class="update-sidebar-row" data-controller="update-progress" data-update-state="${escapeHtml(dataState)}"><div class="update-sidebar-primary">${left}</div>${whatsNew}</div></section>`;
}

function renderWhatsNewModal(autoShow = true): string {
  return `<dialog id="whats-new-modal" class="settings-dialog update-whats-new-dialog" data-controller="modal"${autoShow ? ` data-modal-auto-show-value="true"` : ""}>
  <div class="settings-sheet"><main class="settings-main">
    <button class="settings-close" type="button" aria-label="Close" data-action="modal#close">×</button>
    <div class="settings-title">Changes since your current version</div>
    <section class="settings-sec update-notes-sec">
      <turbo-frame id="update_whats_new_notes" src="/update/whats-new/notes">
        <div class="update-notes-loading" role="status" aria-live="polite">
          <span class="status-spinner" aria-hidden="true"></span>
          <div><b>Preparing what’s new…</b><p>Comparing releases can take a moment. The notes will appear here when they’re ready.</p></div>
        </div>
      </turbo-frame>
    </section>
  </main></div>
</dialog>`;
}

async function renderWhatsNewNotes(updateManager: UpdateManager): Promise<string> {
  return `<turbo-frame id="update_whats_new_notes">${await updateManager.releaseNotes()}</turbo-frame>`;
}

async function renderRestartModal(updateManager: UpdateManager): Promise<string> {
  return `<dialog id="restart-update-modal" class="modal update-restart-modal" data-controller="modal" data-modal-auto-show-value="true">
  <form method="post" action="/update/restart" data-turbo="false" data-controller="update-restart" data-action="submit->update-restart#submit">
    <h2>Restart Atelier to finish updating?</h2>
    <p>Active agent sessions and terminal connections will be interrupted. Your projects, workspaces, and containers will remain in place.</p>
    <p>Atelier should be back in a few seconds.</p>
    <div class="modal-actions"><button class="btn" type="button" data-action="modal#close">Cancel</button><button class="btn primary" type="submit">Restart Atelier</button></div>
  </form>
</dialog>`;
}

function modalStream(html: string): Response {
  return turboStreamResponse(turboStream("update", "update_modal_host", html));
}

export function createUpdateRouteHandler(updateManager: UpdateManager): (request: Request, url: URL) => Promise<Response | undefined> {
  return async (request, url) => {
    if (url.pathname === "/update/start" && request.method === "POST") {
      void updateManager.startPull();
      return turboStreamResponse("");
    }
    if (url.pathname === "/update/whats-new" && request.method === "GET") return modalStream(renderWhatsNewModal());
    if (url.pathname === "/update/whats-new/notes" && request.method === "GET") return new Response(await renderWhatsNewNotes(updateManager), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    if (url.pathname === "/update/restart-confirm" && request.method === "GET") return modalStream(await renderRestartModal(updateManager));
    if (url.pathname === "/update/restart" && request.method === "POST") return await updateManager.launchUpdater(url);
    if (url.pathname === "/update/state" && request.method === "GET") return new Response(JSON.stringify(updateManager.snapshot()), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    if (url.pathname === "/update/events" && request.method === "GET") return updateManager.sseResponse();
    return undefined;
  };
}

export const atelierServerModule: WorkspaceModule = {
  id: "atelier-update",
  staticFiles: {
    "/update-client.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  },
  async initialize(context) {
    await manager.initialize(context);
  },
  routes: [{ handle: createUpdateRouteHandler(manager) }],
};
