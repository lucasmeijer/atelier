import { escapeHtml, progressButtonHtml, turboStream, turboStreamResponse, type SettingsContribution, type WorkspaceModule, type WorkspaceServerModuleContext } from "@atelier/shared";
import { pollIntervalMs, updaterPort, updateSidebarContributionId } from "./constants.ts";
import { isReleaseChannel, targetImageForChannel, type ReleaseChannel } from "./channels.ts";
import { detectSelfUpdateRuntime, dockerExec, pullChannelImage, type DockerExec, type PullProgress, type SelfUpdateRuntime } from "./docker.ts";
import { fetchChannelImageMetadata, type ImageMetadata } from "./registry.ts";
import { fetchReleaseNotes } from "./release-notes.ts";
import { readStoredReleaseChannel, writeStoredReleaseChannel } from "./settings-store.ts";

export type UpdateState = "idle" | "checking" | "available" | "incompatible" | "pulling" | "ready_to_restart" | "failed" | "restarting";

export interface StateSnapshot {
  state: UpdateState;
  percent?: number;
  error?: string;
  selfUpdatable: boolean;
  currentRevision?: string;
  target?: ImageMetadata;
  releaseChannel: ReleaseChannel;
  compatibilityMismatch: boolean;
}

export interface UpdateManagerDeps {
  detectRuntime?: () => Promise<SelfUpdateRuntime | undefined>;
  fetchMetadata?: (channel: ReleaseChannel) => Promise<ImageMetadata>;
  pullImage?: (channel: ReleaseChannel, onProgress: (progress: PullProgress) => void) => Promise<void>;
  fetchNotes?: (currentSha: string | undefined, stableSha: string | undefined) => Promise<string>;
  docker?: DockerExec;
  checkUpdaterPortAvailable?: () => Promise<void>;
  waitForUpdater?: (url: string) => Promise<void>;
  setInterval?: (handler: () => void, interval: number) => void;
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
  private pulledDigest: string | undefined;
  private restarting = false;
  private releaseNotesHtml: string | undefined;

  constructor(private readonly deps: UpdateManagerDeps = {}) {}

  async initialize(context: WorkspaceServerModuleContext): Promise<void> {
    this.context = context;
    this.runtime = await (this.deps.detectRuntime ?? detectSelfUpdateRuntime)();
    if (this.runtime) this.releaseChannel = await readStoredReleaseChannel() ?? this.runtime.releaseChannel;
    this.updateSidebar();
    if (!this.runtime) return;
    await this.checkNow();
    const checkForUpdate = () => void this.checkNow().catch((error) => this.fail(error instanceof Error ? error.message : String(error)));
    if (this.deps.setInterval) {
      this.deps.setInterval(checkForUpdate, pollIntervalMs);
    } else {
      const interval = setInterval(checkForUpdate, pollIntervalMs);
      interval.unref?.();
    }
  }

  snapshot(): StateSnapshot {
    return { state: this.state, percent: this.percent, error: this.error, selfUpdatable: Boolean(this.runtime), currentRevision: this.runtime?.currentRevision, target: this.target, releaseChannel: this.releaseChannel, compatibilityMismatch: this.hasCompatibilityMismatch() };
  }

  private visible(): boolean {
    return Boolean(this.runtime) && this.state !== "idle" && this.state !== "checking";
  }

  private updateSidebar(): void {
    this.context?.globalSidebarContributions.set(updateSidebarContributionId, this.visible() ? renderSidebarRow(this.snapshot()) : undefined, {
      broadcastHtml: updateSettingsStream(this),
    });
  }

  private setState(state: UpdateState, options: { percent?: number; error?: string } = {}): void {
    this.state = state;
    this.percent = options.percent;
    this.error = options.error;
    this.updateSidebar();
  }

  private fail(message: string): void {
    this.setState("failed", { error: message });
  }

  private hasCompatibilityMismatch(): boolean {
    return Boolean(this.runtime?.selfUpdateCompatibility && this.target?.selfUpdateCompatibility && this.runtime.selfUpdateCompatibility !== this.target.selfUpdateCompatibility);
  }

  async checkNow(): Promise<void> {
    if (!this.runtime) return;
    const channel = this.releaseChannel;
    if (this.state === "idle") this.setState("checking");
    const target = await (this.deps.fetchMetadata ?? fetchChannelImageMetadata)(channel);
    this.target = target;
    this.releaseNotesHtml = undefined;
    const current = this.runtime.currentRevision ?? this.runtime.currentDigest;
    const remote = target.revision ?? target.digest;
    const available = Boolean(remote && current && remote !== current);
    const incompatible = this.hasCompatibilityMismatch();
    if (!available) this.setState("idle");
    else if (incompatible) this.setState("incompatible");
    else if (this.state === "idle" || this.state === "checking" || this.state === "incompatible") this.setState("available");
    else if (this.state === "ready_to_restart" && this.pulledDigest !== target.digest) await this.startPull();
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
    if (this.hasCompatibilityMismatch()) throw new Error("This update requires rerunning the Atelier installer");
    if (this.pullPromise) return await this.pullPromise;
    this.pullPromise = this.pullNewestTarget().catch((error) => {
      this.fail(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      this.pullPromise = undefined;
    });
    return await this.pullPromise;
  }

  private async pullNewestTarget(): Promise<void> {
    const pullImage = this.deps.pullImage ?? pullChannelImage;
    const reportProgress = (progress: PullProgress) => {
      this.percent = progress.percent;
      this.updateSidebar();
    };
    while (true) {
      const digest = this.target!.digest;
      this.setState("pulling", { percent: undefined });
      await pullImage(this.releaseChannel, reportProgress);
      this.pulledDigest = digest;
      if (this.target!.digest === digest) {
        this.setState("ready_to_restart", { percent: 100 });
        return;
      }
      if (this.hasCompatibilityMismatch()) {
        this.setState("incompatible");
        return;
      }
    }
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
    updaterUrl.protocol = "https:";
    updaterUrl.port = String(updaterPort);
    const docker = this.deps.docker ?? dockerExec;
    try {
      await removeStaleUpdateHelpers(docker);
      await (this.deps.checkUpdaterPortAvailable ?? checkUpdaterPortAvailable)();
      const result = await docker([
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
    } catch (error) {
      this.restarting = false;
      this.fail(error instanceof Error ? error.message : String(error));
      throw error;
    }
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

async function checkUpdaterPortAvailable(): Promise<void> {
  try {
    const server = Bun.serve({ hostname: "127.0.0.1", port: updaterPort, fetch: () => new Response("ok") });
    server.stop(true);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "EADDRINUSE") throw new Error(`Update helper port ${updaterPort} is already in use on 127.0.0.1. Stop the process using 127.0.0.1:${updaterPort} and retry the update.`);
    throw error;
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

const updateSpinnerHtml = `<i class="activity-spinner" aria-hidden="true"></i>`;

interface UpdateStatusText {
  label: string;
  detail: string;
}

function updateStatusText(snapshot: StateSnapshot): UpdateStatusText {
  if (!snapshot.selfUpdatable) return { label: "Self-update unavailable", detail: "Atelier is not running in a managed Docker install." };
  if (snapshot.state === "checking") return { label: "Checking for updates…", detail: `Checking the ${snapshot.releaseChannel} channel.` };
  if (snapshot.state === "idle") return { label: "Up to date", detail: `Atelier is up to date on the ${snapshot.releaseChannel} channel.` };
  if (snapshot.state === "available") return { label: "Update available", detail: `A newer ${snapshot.releaseChannel} build is available.` };
  if (snapshot.state === "incompatible") return { label: "Installer required", detail: "This release changes how Atelier is hosted and needs the installer to be run again." };
  if (snapshot.state === "pulling") return { label: "Pulling update…", detail: snapshot.percent === undefined ? "Downloading the update." : `Downloading the update (${snapshot.percent}%).` };
  if (snapshot.state === "ready_to_restart") return { label: "Restart required", detail: "The update has been downloaded and is ready to install." };
  if (snapshot.state === "failed") return { label: "Update failed", detail: snapshot.error ?? "The update failed." };
  return { label: "Restarting", detail: "Atelier is restarting to finish the update." };
}

function renderUpdateDownloadButton(snapshot: StateSnapshot): string {
  return progressButtonHtml({
    initialHtml: snapshot.state === "failed" ? "Retry update" : "Update Atelier",
    inProgressHtml: `${updateSpinnerHtml}Updating Atelier…`,
    state: snapshot.state === "pulling" ? "in-progress" : "initial",
    progress: snapshot.state === "pulling" ? snapshot.percent ?? 1 : 0,
    variant: snapshot.state === "failed" ? "danger" : "primary",
    type: "submit",
  });
}

function renderUpdateSettings(updateManager: UpdateManager): string {
  const snapshot = updateManager.snapshot();
  const status = updateStatusText(snapshot);
  const controlsDisabled = !snapshot.selfUpdatable || snapshot.state === "pulling" || snapshot.state === "restarting";
  const channelToggle = `<form class="button-toggle" role="group" aria-label="Update channel" method="post" action="/settings/update-channel" data-turbo="true">${(["stable", "latest"] as const).map((channel) => `<button class="button-toggle__option" type="submit" name="channel" value="${channel}" aria-pressed="${snapshot.releaseChannel === channel}"${controlsDisabled ? " disabled" : ""}>${channel === "stable" ? "Stable" : "Latest"}</button>`).join("")}</form>`;
  const checkButton = progressButtonHtml({
    initialHtml: "Check now",
    inProgressHtml: `${updateSpinnerHtml}Checking…`,
    state: snapshot.state === "checking" ? "in-progress" : "initial",
    progress: snapshot.state === "checking" ? 1 : 0,
    variant: "secondary",
    type: "submit",
    disabled: controlsDisabled,
  });
  const checkNow = `<form method="post" action="/update/check-now" data-turbo="true">${checkButton}</form>`;
  const updateAction = snapshot.state === "available" || snapshot.state === "failed" || snapshot.state === "pulling"
    ? `<form method="post" action="/update/start" data-turbo="true">${renderUpdateDownloadButton(snapshot)}</form>`
    : snapshot.state === "incompatible"
      ? `<form method="get" action="/update/installer-required" data-turbo="true"><button class="button primary" type="submit">Show installer command</button></form>`
      : snapshot.state === "ready_to_restart"
        ? `<form method="get" action="/update/restart-confirm" data-turbo="true"><button class="button primary" type="submit">Restart to update</button></form>`
        : "";
  return `<section class="settings-sec settings-sec-inline update-settings-row" id="settings-sec-update"><div><h2>Updates</h2><p class="settings-sub">${escapeHtml(status.label)} — ${escapeHtml(status.detail)}</p></div><div class="settings-provider-actions">${checkNow}${channelToggle}${updateAction}</div></section>`;
}

function updateSettingsStream(updateManager: UpdateManager): string {
  return turboStream("replace", "settings-sec-update", renderUpdateSettings(updateManager), { method: "morph" });
}

const updateSettingsContribution: SettingsContribution = {
  id: "update",
  label: "Updates",
  order: 15,
  render: async () => renderUpdateSettings(manager),
  async handleAction({ request, url }) {
    if (url.pathname !== "/settings/update-channel" || request.method !== "POST") return undefined;
    if (!manager.snapshot().selfUpdatable) return turboStreamResponse(updateSettingsStream(manager));
    const form = await request.formData();
    const channel = String(form.get("channel") ?? "");
    if (!isReleaseChannel(channel)) throw new Error(`unsupported release channel: ${channel}`);
    await manager.setReleaseChannel(channel);
    return turboStreamResponse(updateSettingsStream(manager));
  },
};

export function renderSidebarRow(snapshot: StateSnapshot): string {
  const whatsNew = `<form method="get" action="/update/whats-new" data-turbo="true"><button class="button secondary" type="submit">What’s new</button></form>`;
  const left = snapshot.state === "incompatible"
    ? `<form method="get" action="/update/installer-required" data-turbo="true"><button class="button secondary" type="submit">Installer required</button></form>`
    : snapshot.state === "ready_to_restart"
      ? `<form method="get" action="/update/restart-confirm" data-turbo="true"><button class="button primary" type="submit">Restart to update</button></form>`
      : snapshot.state === "restarting"
        ? progressButtonHtml({ initialHtml: "Restart Atelier", inProgressHtml: `${updateSpinnerHtml}Restarting Atelier…`, state: "in-progress", progress: 1, variant: "primary" })
        : `<form method="post" action="/update/start" data-turbo="true">${renderUpdateDownloadButton(snapshot)}</form>`;
  return `<section class="update-sidebar-section"><div id="update_sidebar_row" class="update-sidebar-row"><div class="update-sidebar-primary">${left}</div>${whatsNew}</div></section>`;
}

function renderWhatsNewModal(autoShow = true): string {
  return `<dialog id="whats-new-modal" class="dialog dialog--sheet settings-dialog update-whats-new-dialog" data-controller="modal"${autoShow ? ` data-modal-auto-show-value="true"` : ""}>
  <div class="settings-sheet"><main class="settings-main">
    <button class="settings-close button secondary icon-only" type="button" title="Close what’s new" aria-label="Close what’s new" data-action="modal#close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    <div class="settings-title">Changes since your current version</div>
    <section class="settings-sec update-notes-sec">
      <turbo-frame id="update_whats_new_notes" src="/update/whats-new/notes">
        <div class="update-notes-loading" role="status" aria-live="polite">
          <i class="activity-spinner" aria-hidden="true"></i>
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

function renderRestartModal(): string {
  return `<dialog id="restart-update-modal" class="dialog dialog--compact update-restart-modal" data-controller="modal" data-modal-auto-show-value="true">
  <form class="dialog__form" method="post" action="/update/restart" data-turbo="false" data-controller="update-restart" data-action="submit->update-restart#submit">
    <header class="dialog__header"><h2 class="title">Restart Atelier to finish updating?</h2></header>
    <div class="dialog__body"><p>Active agent sessions and terminal connections will be interrupted. Your projects, workspaces, and containers will remain in place.</p><p data-update-restart-status role="status" aria-live="polite">Atelier should be back in a few seconds.</p></div>
    <footer class="dialog__actions button-group"><button class="button secondary" type="button" data-update-restart-cancel data-action="modal#close">Cancel</button>${progressButtonHtml({ initialHtml: "Restart Atelier", inProgressHtml: `${updateSpinnerHtml}Preparing restart…`, state: "initial", variant: "primary", type: "submit", id: "update_restart_submit" })}</footer>
  </form>
</dialog>`;
}

function renderRestartErrorModal(message: string): string {
  return `<dialog id="restart-update-error-modal" class="dialog dialog--compact update-restart-modal" data-controller="modal" data-modal-auto-show-value="true">
  <form class="dialog__form" method="dialog">
    <header class="dialog__header"><h2 class="title">Could not restart Atelier</h2></header>
    <div class="dialog__body"><p>${escapeHtml(message)}</p></div>
    <footer class="dialog__actions button-group"><button class="button primary" value="close">OK</button></footer>
  </form>
</dialog>`;
}

function installerCommand(channel: ReleaseChannel): string {
  return `curl -fsSL https://lucasmeijer.com/get-atelier | sudo bash${channel === "latest" ? " -s -- --channel latest" : ""}`;
}

function renderInstallerRequiredModal(updateManager: UpdateManager): string {
  const snapshot = updateManager.snapshot();
  const command = installerCommand(snapshot.releaseChannel);
  return `<dialog id="installer-required-modal" class="dialog dialog--compact update-restart-modal" data-controller="modal" data-modal-auto-show-value="true">
  <header class="dialog__header"><h2 class="title">Run the installer to update Atelier</h2></header>
  <div class="dialog__body"><p>This release changes how Atelier is hosted, so the smooth in-app restart cannot safely apply it.</p><p>SSH into the Atelier host and run:</p><pre><code>${escapeHtml(command)}</code></pre><p>Your projects, workspaces, and containers will remain in place.</p></div>
  <footer class="dialog__actions button-group"><button class="button primary" type="button" data-action="modal#close">Got it</button></footer>
</dialog>`;
}

function modalStream(html: string): Response {
  return turboStreamResponse(turboStream("update", "update_modal_host", html));
}

function wantsTurboStream(request: Request): boolean {
  return request.headers.get("accept")?.includes("text/vnd.turbo-stream.html") ?? false;
}

export function createUpdateRouteHandler(updateManager: UpdateManager): (request: Request, url: URL) => Promise<Response | undefined> {
  return async (request, url) => {
    if (url.pathname === "/update" && request.method === "GET") return Response.redirect(new URL("/", url).toString(), 303);
    if (url.pathname === "/update/start" && request.method === "POST") {
      if (updateManager.snapshot().compatibilityMismatch) return modalStream(renderInstallerRequiredModal(updateManager));
      void updateManager.startPull();
      return turboStreamResponse(updateSettingsStream(updateManager));
    }
    if (url.pathname === "/update/check-now" && request.method === "POST") {
      await updateManager.checkNow();
      return turboStreamResponse(updateSettingsStream(updateManager));
    }
    if (url.pathname === "/update/whats-new" && request.method === "GET") return modalStream(renderWhatsNewModal());
    if (url.pathname === "/update/whats-new/notes" && request.method === "GET") return new Response(await renderWhatsNewNotes(updateManager), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    if (url.pathname === "/update/installer-required" && request.method === "GET") return modalStream(renderInstallerRequiredModal(updateManager));
    if (url.pathname === "/update/restart-confirm" && request.method === "GET") return modalStream(renderRestartModal());
    if (url.pathname === "/update/restart" && request.method === "POST") {
      if (!wantsTurboStream(request)) return await updateManager.launchUpdater(url);
      try {
        const response = await updateManager.launchUpdater(url);
        const location = response.headers.get("location");
        return location ? turboStreamResponse("", { headers: { location } }) : turboStreamResponse("");
      } catch (error) {
        return modalStream(renderRestartErrorModal(error instanceof Error ? error.message : String(error)));
      }
    }
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
