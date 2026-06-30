import { escapeHtml, turboStream, turboStreamResponse, type SettingsContribution, type WorkspaceModule, type WorkspaceServerModuleContext } from "@atelier/shared";
import { pollIntervalMs, updaterPort, updateSidebarContributionId } from "./constants.ts";
import { isReleaseChannel, targetImageForChannel, type ReleaseChannel } from "./channels.ts";
import { detectSelfUpdateRuntime, dockerExec, pullChannelImage, type DockerExec, type PullProgress, type SelfUpdateRuntime } from "./docker.ts";
import { fetchChannelImageMetadata, type ImageMetadata } from "./registry.ts";
import { fetchReleaseNotes } from "./release-notes.ts";
import { readStoredReleaseChannel, writeStoredReleaseChannel } from "./settings-store.ts";

export type UpdateState = "idle" | "checking" | "available" | "pulling" | "ready_to_restart" | "failed" | "restarting";

export interface StateSnapshot {
  state: UpdateState;
  percent?: number;
  error?: string;
  selfUpdatable: boolean;
  currentRevision?: string;
  target?: ImageMetadata;
  releaseChannel: ReleaseChannel;
}

export interface UpdateManagerDeps {
  detectRuntime?: () => Promise<SelfUpdateRuntime | undefined>;
  fetchMetadata?: (channel: ReleaseChannel) => Promise<ImageMetadata>;
  pullImage?: (channel: ReleaseChannel, onProgress: (progress: PullProgress) => void) => Promise<void>;
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
  private releaseChannel: ReleaseChannel = "stable";
  private pullPromise: Promise<void> | undefined;
  private restarting = false;
  private releaseNotesHtml: string | undefined;
  private readonly subscribers = new Set<(snapshot: StateSnapshot) => void>();

  constructor(private readonly deps: UpdateManagerDeps = {}) {}

  async initialize(context: WorkspaceServerModuleContext): Promise<void> {
    this.context = context;
    this.runtime = await (this.deps.detectRuntime ?? detectSelfUpdateRuntime)();
    if (this.runtime) this.releaseChannel = await readStoredReleaseChannel() ?? this.runtime.releaseChannel;
    this.updateSidebar();
    if (!this.runtime) return;
    await this.checkNow();
    const interval = (this.deps.setInterval ?? setInterval)(() => void this.checkNow().catch((error) => this.fail(error)), pollIntervalMs);
    interval.unref?.();
  }

  snapshot(): StateSnapshot {
    return { state: this.state, percent: this.percent, error: this.error, selfUpdatable: Boolean(this.runtime), currentRevision: this.runtime?.currentRevision, target: this.target, releaseChannel: this.releaseChannel };
  }

  subscribe(handler: (snapshot: StateSnapshot) => void): () => void {
    this.subscribers.add(handler);
    handler(this.snapshot());
    return () => this.subscribers.delete(handler);
  }

  private visible(): boolean {
    return Boolean(this.runtime) && this.state !== "idle" && this.state !== "checking";
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
    const channel = this.releaseChannel;
    if (this.state === "idle") this.setState("checking");
    const target = await (this.deps.fetchMetadata ?? fetchChannelImageMetadata)(channel);
    const oldDigest = this.target?.digest;
    this.target = target;
    this.releaseNotesHtml = undefined;
    const current = this.runtime.currentRevision ?? this.runtime.currentDigest;
    const remote = target.revision ?? target.digest;
    const available = Boolean(remote && current && remote !== current);
    if (!available) this.setState("idle");
    else if (this.state === "idle" || this.state === "checking") this.setState("available");
    else if (this.state === "ready_to_restart" && oldDigest && oldDigest !== target.digest) await this.startPull();
    else this.updateSidebar();
  }

  async setReleaseChannel(channel: ReleaseChannel): Promise<void> {
    if (!this.runtime) throw new Error("Atelier is not running in a self-updatable Docker container");
    if (this.pullPromise || this.restarting) throw new Error("Cannot switch release channels while an update is in progress");
    if (this.releaseChannel === channel) return await this.checkNow();
    await writeStoredReleaseChannel(channel);
    this.releaseChannel = channel;
    this.target = undefined;
    this.releaseNotesHtml = undefined;
    this.setState("checking");
    await this.checkNow();
  }

  async startPull(): Promise<void> {
    if (!this.runtime) throw new Error("Atelier is not running in a self-updatable Docker container");
    if (this.pullPromise) return await this.pullPromise;
    this.setState("pulling", { percent: undefined });
    const onProgress = (progress: PullProgress) => {
      this.percent = progress.percent;
      this.updateSidebar();
    };
    const pull = (this.deps.pullImage ?? pullChannelImage)(this.releaseChannel, onProgress);
    this.pullPromise = pull.then(() => {
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
    const returnUrl = new URL("/", url);
    const updaterUrl = new URL(returnUrl);
    updaterUrl.protocol = "http:";
    updaterUrl.port = String(updaterPort);
    await removeStaleUpdateHelpers(this.deps.docker ?? dockerExec);
    const result = await (this.deps.docker ?? dockerExec)([
      "run", "-d", "--rm", "--name", name, "--network", "host",
      "-v", "/var/run/docker.sock:/var/run/docker.sock",
      this.runtime.imageId,
      "atelier-update-helper", "--server-container", this.runtime.containerId, "--target-image", targetImageForChannel(this.releaseChannel), "--release-channel", this.releaseChannel, "--return-url", returnUrl.toString(),
    ]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || "could not start update helper");
    const theme = url.searchParams.get("theme") ?? "";
    updaterUrl.pathname = "/up";
    updaterUrl.search = "";
    await (this.deps.waitForUpdater ?? waitForUpdater)(updaterUrl.toString());
    updaterUrl.pathname = "/";
    updaterUrl.searchParams.set("theme", theme);
    return Response.redirect(updaterUrl.toString(), 303);
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

async function removeStaleUpdateHelpers(docker: DockerExec): Promise<void> {
  const listed = await docker(["ps", "-aq", "--filter", "name=^/atelier-updater-"]);
  if (listed.code !== 0) throw new Error(listed.stderr.trim() || "could not list update helpers");
  const ids = listed.stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.length === 0) return;
  const removed = await docker(["rm", "-f", ...ids]);
  if (removed.code !== 0) throw new Error(removed.stderr.trim() || "could not remove stale update helpers");
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

function updateStatusText(snapshot: StateSnapshot): { label: string; detail: string } {
  if (!snapshot.selfUpdatable) return { label: "Self-update unavailable", detail: "Atelier is not running in a managed Docker install." };
  if (snapshot.state === "checking") return { label: "Checking for updates…", detail: `Checking the ${snapshot.releaseChannel} channel.` };
  if (snapshot.state === "idle") return { label: "Up to date", detail: `Atelier is up to date on the ${snapshot.releaseChannel} channel.` };
  if (snapshot.state === "available") return { label: "Update available", detail: `A newer ${snapshot.releaseChannel} build is available.` };
  if (snapshot.state === "pulling") return { label: "Pulling update…", detail: snapshot.percent === undefined ? "Downloading the update." : `Downloading the update (${snapshot.percent}%).` };
  if (snapshot.state === "ready_to_restart") return { label: "Restart required", detail: "The update has been downloaded and is ready to install." };
  if (snapshot.state === "failed") return { label: "Update failed", detail: snapshot.error ?? "The update failed." };
  return { label: "Restarting", detail: "Atelier is restarting to finish the update." };
}

function renderUpdateSettings(updateManager: UpdateManager): string {
  const snapshot = updateManager.snapshot();
  const status = updateStatusText(snapshot);
  const disabled = snapshot.selfUpdatable && snapshot.state !== "pulling" && snapshot.state !== "restarting" ? "" : " disabled";
  const checkDisabled = snapshot.selfUpdatable && snapshot.state !== "checking" && snapshot.state !== "pulling" && snapshot.state !== "restarting" ? "" : " disabled";
  const options = (["stable", "latest"] as const).map((channel) => `<option value="${channel}"${snapshot.releaseChannel === channel ? " selected" : ""}>${channel === "stable" ? "Stable" : "Latest"}</option>`).join("");
  const checkNow = `<form method="post" action="/update/check-now" data-turbo="true"><button class="settings-link" type="submit"${checkDisabled}>Check now</button></form>`;
  const action = snapshot.state === "available" || snapshot.state === "failed"
    ? `<form method="post" action="/update/start" data-turbo="true"><button class="settings-btn primary" type="submit">${snapshot.state === "failed" ? "Retry update" : "Update now"}</button></form>`
    : snapshot.state === "ready_to_restart"
      ? `<form method="get" action="/update/restart-confirm" data-turbo="true"><button class="settings-btn primary" type="submit">Restart to update</button></form>`
      : "";
  return `<section class="settings-sec settings-sec-inline update-settings-row" id="settings-sec-update"><div><h2>Updates</h2><p class="settings-sub">${escapeHtml(status.label)} — ${escapeHtml(status.detail)}</p></div><div class="settings-provider-actions">${checkNow}<form method="post" action="/settings/update-channel" data-turbo="true" data-controller="settings-autosave" data-action="change->settings-autosave#save submit->settings-autosave#submit"><select class="settings-select" name="channel"${disabled}>${options}</select></form>${action}</div></section>`;
}

const updateSettingsContribution: SettingsContribution = {
  id: "update",
  label: "Updates",
  order: 15,
  render: async () => renderUpdateSettings(manager),
  async handleAction({ request, url }) {
    if (url.pathname !== "/settings/update-channel" || request.method !== "POST") return undefined;
    if (!manager.snapshot().selfUpdatable) return turboStreamResponse(turboStream("replace", "settings-sec-update", renderUpdateSettings(manager)));
    const form = await request.formData();
    const channel = String(form.get("channel") ?? "");
    if (!isReleaseChannel(channel)) throw new Error(`unsupported release channel: ${channel}`);
    await manager.setReleaseChannel(channel);
    return turboStreamResponse(turboStream("replace", "settings-sec-update", renderUpdateSettings(manager)));
  },
};

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
    if (url.pathname === "/update" && request.method === "GET") return Response.redirect(new URL("/", url).toString(), 303);
    if (url.pathname === "/update/start" && request.method === "POST") {
      void updateManager.startPull();
      return turboStreamResponse(turboStream("replace", "settings-sec-update", renderUpdateSettings(updateManager)));
    }
    if (url.pathname === "/update/check-now" && request.method === "POST") {
      await updateManager.checkNow();
      return turboStreamResponse(turboStream("replace", "settings-sec-update", renderUpdateSettings(updateManager)));
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
  settingsContributions: [updateSettingsContribution],
  staticFiles: {
    "/update-client.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  },
  async initialize(context) {
    await manager.initialize(context);
  },
  routes: [{ handle: createUpdateRouteHandler(manager) }],
};
