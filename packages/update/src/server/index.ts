import { dialogHtml } from "@atelier/design-system/dialog";
import { Icons } from "@atelier/design-system/icons";
import { buttonHtml } from "@atelier/design-system/button";
import { destructiveConfirmationHtml } from "@atelier/design-system/destructive-confirmation";
import { progressButtonHtml } from "@atelier/design-system/progress-button";
import { transientFeedbackHtml } from "@atelier/design-system/transient-feedback";
import { escapeHtml, turboStream, turboStreamResponse, type SettingsContribution, type WorkspaceModule, type WorkspaceServerModuleContext } from "@atelier/shared";
import { pollIntervalMs, updaterPort, updateSidebarContributionId } from "./constants.ts";
import { targetImageForChannel, type ReleaseChannel } from "./channels.ts";
import { detectSelfUpdateRuntime, dockerExec, pullChannelImage, type DockerExec, type PullProgress, type SelfUpdateRuntime } from "./docker.ts";
import { fetchChannelImageMetadata, type ImageMetadata } from "./registry.ts";

export type UpdateState = "idle" | "checking" | "available" | "incompatible" | "pulling" | "ready_to_restart" | "failed" | "restarting";

export interface StateSnapshot {
  state: UpdateState;
  percent?: number;
  error?: string;
  selfUpdatable: boolean;
  target?: ImageMetadata;
  releaseChannel: ReleaseChannel;
  compatibilityMismatch: boolean;
}

export interface UpdateManagerDeps {
  detectRuntime?: () => Promise<SelfUpdateRuntime | undefined>;
  fetchMetadata?: (channel: ReleaseChannel) => Promise<ImageMetadata>;
  pullImage?: (channel: ReleaseChannel, onProgress: (progress: PullProgress) => void) => Promise<void>;
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

  constructor(private readonly deps: UpdateManagerDeps = {}) {}

  async initialize(context: WorkspaceServerModuleContext): Promise<void> {
    this.context = context;
    this.runtime = await (this.deps.detectRuntime ?? detectSelfUpdateRuntime)();
    if (this.runtime) this.releaseChannel = this.runtime.releaseChannel;
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
    return { state: this.state, percent: this.percent, error: this.error, selfUpdatable: Boolean(this.runtime), target: this.target, releaseChannel: this.releaseChannel, compatibilityMismatch: this.hasCompatibilityMismatch() };
  }

  private updateSidebar(checked = false): void {
    const sidebarHtml = renderSidebarRow(this.snapshot());
    this.context?.globalSidebarContributions.set(updateSidebarContributionId, sidebarHtml || undefined, {
      broadcastHtml: updateSettingsStream(this, checked),
    });
  }

  private setState(state: UpdateState, options: { percent?: number; error?: string } = {}, checked = false): void {
    this.state = state;
    this.percent = options.percent;
    this.error = options.error;
    this.updateSidebar(checked);
  }

  private fail(message: string): void {
    this.setState("failed", { error: message });
  }

  private hasCompatibilityMismatch(): boolean {
    return Boolean(this.runtime?.selfUpdateCompatibility && this.target?.selfUpdateCompatibility && this.runtime.selfUpdateCompatibility !== this.target.selfUpdateCompatibility);
  }

  async checkNow(options: { announceCurrent?: boolean } = {}): Promise<void> {
    if (!this.runtime) return;
    const channel = this.releaseChannel;
    if (this.state === "idle") this.setState("checking");
    const target = await (this.deps.fetchMetadata ?? fetchChannelImageMetadata)(channel);
    this.target = target;
    const current = this.runtime.currentRevision ?? this.runtime.currentDigest;
    const remote = target.revision ?? target.digest;
    const available = Boolean(remote && current && remote !== current);
    const incompatible = this.hasCompatibilityMismatch();
    if (!available) this.setState("idle", {}, options.announceCurrent ?? false);
    else if (incompatible) this.setState("incompatible");
    else if (this.state === "idle" || this.state === "checking" || this.state === "incompatible") this.setState("available");
    else if (this.state === "ready_to_restart" && this.pulledDigest !== target.digest) this.setState("available");
    else this.updateSidebar();
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
      this.setState("ready_to_restart", { error: error instanceof Error ? error.message : String(error) });
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

function renderCheckButton(state: "initial" | "in-progress"): string {
  return progressButtonHtml({
    initialContent: { kind: "text", text: "Check now" },
    progressContent: { kind: "text", text: "Checking…" },
    state,
    variant: "secondary",
    type: "submit",
  });
}

function renderCheckForm(): string {
  return `<form method="post" action="/update/check-now" data-turbo="true">${renderCheckButton("initial")}</form>`;
}

function renderDownloadControl(snapshot: StateSnapshot): string {
  const content = {
    initialContent: { kind: "text" as const, text: "Download Update" },
    progressContent: { kind: "text" as const, text: "Downloading…" },
    variant: "primary" as const,
    type: "submit" as const,
  };
  if (snapshot.state === "pulling") return progressButtonHtml({ ...content, state: "in-progress", progress: snapshot.percent ?? 1 });
  const button = progressButtonHtml({ ...content, state: "initial" });
  return `<form method="post" action="/update/start" data-turbo="true">${button}</form>`;
}

type UpdateControlSurface = "settings" | "sidebar";

function restartFeedbackId(surface: UpdateControlSurface): string {
  return `update_restart_feedback_${surface}`;
}

function restartFormHtml(surface: UpdateControlSurface): string {
  const confirmation = destructiveConfirmationHtml({
    trigger: { type: "button", variant: "primary", content: { kind: "caption", caption: "Restart to update" } },
    confirmCaption: "Restart to update",
    cancelCaption: "Cancel",
  });
  return `<form method="post" action="/update/restart?surface=${surface}" data-turbo="false" data-controller="update-restart" data-action="submit->update-restart#submit">${confirmation}</form>`;
}

function renderRestartFeedback(surface: UpdateControlSurface, message?: string): string {
  return transientFeedbackHtml({
    element: { tag: "div",  attributesHtml: `id="${restartFeedbackId(surface)}"` },
    initialContent: { kind: "html", html: restartFormHtml(surface) },
    feedbackContent: { kind: "html", html: `<span class="transient-feedback__status update-restart-error">Could not restart Atelier: ${escapeHtml(message ?? "")}</span>` },
    state: message === undefined ? "initial" : "feedback",
  });
}

function renderCheckFeedback(state: "initial" | "in-progress", feedback = false): string {
  return transientFeedbackHtml({
    element: { tag: "div" },
    initialContent: { kind: "html", html: state === "initial" ? renderCheckForm() : renderCheckButton("in-progress") },
    feedbackContent: { kind: "html", html: '<span class="transient-feedback__status">You\'re up to date!</span>' },
    state: feedback ? "feedback" : "initial",
  });
}

function renderUpdateControl(snapshot: StateSnapshot, surface: UpdateControlSurface): string {
  if (snapshot.state === "checking") return renderCheckFeedback("in-progress");
  if (!snapshot.selfUpdatable || snapshot.state === "idle") return renderCheckFeedback("initial");
  if (snapshot.state === "available" || snapshot.state === "failed" || snapshot.state === "incompatible" || snapshot.state === "pulling") return renderDownloadControl(snapshot);
  if (snapshot.state === "ready_to_restart") return renderRestartFeedback(surface);
  return progressButtonHtml({
    initialContent: { kind: "text", text: "Restart to update" },
    progressContent: { kind: "text", text: "Restarting…" },
    state: "in-progress",
    variant: "primary",
  });
}

function renderUpdateSettings(updateManager: UpdateManager, checked = false): string {
  const snapshot = updateManager.snapshot();
  const control = checked && snapshot.state === "idle" ? renderCheckFeedback("initial", true) : renderUpdateControl(snapshot, "settings");
  return `<section class="settings-sec update-settings-control" id="settings-sec-update"><h2>Updates</h2>${control}</section>`;
}

function updateSettingsStream(updateManager: UpdateManager, checked = false): string {
  return turboStream("replace", "settings-sec-update", renderUpdateSettings(updateManager, checked), { method: "morph" });
}

const updateSettingsContribution: SettingsContribution = {
  id: "update",
  label: "Updates",
  order: 15,
  render: async () => renderUpdateSettings(manager),
};

export function renderSidebarRow(snapshot: StateSnapshot): string {
  if (!snapshot.selfUpdatable || snapshot.state === "idle" || snapshot.state === "checking") return "";
  return `<section class="update-sidebar-section"><div id="update_sidebar_row" class="update-sidebar-row"><p>There's a new version of Atelier!</p>${renderUpdateControl(snapshot, "sidebar")}</div></section>`;
}

function installerCommand(channel: ReleaseChannel): string {
  return `curl -fsSL https://lucasmeijer.com/get-atelier | sudo bash${channel === "latest" ? " -s -- --channel latest" : ""}`;
}

function renderInstallerRequiredModal(updateManager: UpdateManager): string {
  const snapshot = updateManager.snapshot();
  const command = installerCommand(snapshot.releaseChannel);
  const closeButton = buttonHtml({
    type: "button",
    variant: "primary",
    content: { kind: "caption", caption: "Got it" },
    attributesHtml: 'data-action="dialog#close"',
  });
  return dialogHtml({
    element: { id: "installer-required-modal", attributesHtml: "data-dialog-auto-show" },
    iconHtml: Icons.Settings,
    titleCaption: "Run the installer to update Atelier",
    bodyHtml: `<p>This release changes how Atelier is hosted, so the smooth in-app restart cannot safely apply it.</p><p>SSH into the Atelier host and run:</p><pre><code>${escapeHtml(command)}</code></pre><p>Your projects, workspaces, and containers will remain in place.</p>`,
    footerHtml: closeButton,
  });
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
      await updateManager.checkNow({ announceCurrent: true });
      return turboStreamResponse(updateSettingsStream(updateManager, true));
    }
    if (url.pathname === "/update/restart" && request.method === "POST") {
      if (!wantsTurboStream(request)) return await updateManager.launchUpdater(url);
      try {
        const response = await updateManager.launchUpdater(url);
        const location = response.headers.get("location");
        return location ? turboStreamResponse("", { headers: { location } }) : turboStreamResponse("");
      } catch (error) {
        const surface = url.searchParams.get("surface");
        if (surface !== "settings" && surface !== "sidebar") return new Response("Missing update control surface", { status: 400 });
        const message = error instanceof Error ? error.message : String(error);
        return turboStreamResponse(turboStream("replace", restartFeedbackId(surface), renderRestartFeedback(surface, message)));
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
