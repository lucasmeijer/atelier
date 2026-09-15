import { toggleHtml } from "@atelier/design-system/toggle";
import { Icons } from "@atelier/design-system/icons";
import { buttonHtml } from "@atelier/design-system/button";
import { destructiveConfirmationHtml } from "@atelier/design-system/destructive-confirmation";
import { progressButtonHtml } from "@atelier/design-system/progress-button";
import { transientFeedbackHtml } from "@atelier/design-system/transient-feedback";
import { escapeHtml, turboStream, turboStreamResponse, type SettingsContribution, type WorkspaceModule, type WorkspaceServerModuleContext } from "@atelier/shared";
import { pollIntervalMs, repository, updateSidebarContributionId } from "./constants.ts";
import { isReleaseChannel, type ReleaseChannel } from "./channels.ts";
import { detectSelfUpdateRuntime, prepareUpdate, type PreparedUpdate, type PullProgress, type SelfUpdateRuntime } from "./docker.ts";
import { requestSupervisorUpdate } from "./supervisor.ts";
import { fetchChannelImageMetadata, type ImageMetadata } from "./registry.ts";
import { readStoredReleaseChannel, writeStoredReleaseChannel } from "./settings-store.ts";

export type UpdateState = "idle" | "checking" | "available" | "pulling" | "ready_to_restart" | "failed" | "restarting";

export interface StateSnapshot {
  state: UpdateState;
  percent?: number;
  error?: string;
  selfUpdatable: boolean;
  target?: ImageMetadata;
  releaseChannel: ReleaseChannel;
  progressMessage?: string;
}

export interface UpdateManagerDeps {
  readChannel?: () => Promise<ReleaseChannel | undefined>;
  writeChannel?: (channel: ReleaseChannel) => Promise<void>;
  detectRuntime?: () => Promise<SelfUpdateRuntime | undefined>;
  fetchMetadata?: (channel: ReleaseChannel) => Promise<ImageMetadata>;
  prepareUpdate?: (reference: string, onProgress: (progress: PullProgress) => void) => Promise<PreparedUpdate>;
  requestUpdate?: (imageId: string) => Promise<void>;
  setInterval?: (handler: () => void, interval: number) => void;
}

class UpdateConflictError extends Error {}

export class UpdateManager {
  private context: WorkspaceServerModuleContext | undefined;
  private runtime: SelfUpdateRuntime | undefined;
  private state: UpdateState = "idle";
  private percent: number | undefined;
  private error: string | undefined;
  private target: ImageMetadata | undefined;
  private releaseChannel: ReleaseChannel = "stable";
  private pullPromise: Promise<void> | undefined;
  private prepared: PreparedUpdate | undefined;
  private progressMessage: string | undefined;
  private restarting = false;
  private switchingChannel = false;
  private channelGeneration = 0;

  constructor(private readonly deps: UpdateManagerDeps = {}) {}

  async initialize(context: WorkspaceServerModuleContext): Promise<void> {
    this.context = context;
    this.runtime = await (this.deps.detectRuntime ?? detectSelfUpdateRuntime)();
    this.releaseChannel = await this.deps.readChannel?.() ?? "stable";
    this.updateSidebar();
    if (!this.runtime) return;
    await this.checkNow().catch((error) => console.error("Update check failed", error));
    const checkForUpdate = () => void this.checkNow().catch((error) => console.error("Update check failed", error));
    if (this.deps.setInterval) {
      this.deps.setInterval(checkForUpdate, pollIntervalMs);
    } else {
      const interval = setInterval(checkForUpdate, pollIntervalMs);
      interval.unref?.();
    }
  }

  snapshot(): StateSnapshot {
    return { state: this.state, percent: this.percent, error: this.error, selfUpdatable: Boolean(this.runtime), target: this.target, releaseChannel: this.releaseChannel, progressMessage: this.progressMessage };
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

  async checkNow(options: { announceCurrent?: boolean } = {}): Promise<void> {
    if (!this.runtime || this.switchingChannel || this.pullPromise || this.prepared || this.restarting) return;
    const generation = this.channelGeneration;
    const channel = this.releaseChannel;
    if (this.state === "idle" || this.state === "failed") this.setState("checking");
    let target: ImageMetadata;
    try {
      target = await (this.deps.fetchMetadata ?? fetchChannelImageMetadata)(channel);
    } catch (error) {
      // A superseded channel's failures are as stale as its successful responses.
      if (generation !== this.channelGeneration || this.pullPromise || this.prepared || this.restarting) return;
      this.setState("failed", { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    if (generation !== this.channelGeneration || this.pullPromise || this.prepared || this.restarting) return;
    this.target = target;
    const current = this.runtime.currentRevision ?? this.runtime.currentDigest;
    const remote = target.revision ?? target.digest;
    const available = Boolean(remote && current && remote !== current);
    if (!available) this.setState("idle", {}, options.announceCurrent ?? false);
    else this.setState("available");
  }

  async setReleaseChannel(channel: ReleaseChannel): Promise<void> {
    if (!this.runtime) throw new Error("Atelier is not running in a System-managed installation");
    if (this.switchingChannel || this.pullPromise || this.restarting) throw new Error("Cannot switch release channels while an update is in progress");
    if (channel === this.releaseChannel) return await this.checkNow();
    this.switchingChannel = true;
    try {
      await this.deps.writeChannel?.(channel);
      this.channelGeneration += 1;
      this.releaseChannel = channel;
      this.target = undefined;
      this.prepared = undefined;
      this.setState("idle");
    } finally {
      this.switchingChannel = false;
    }
    await this.checkNow();
  }

  startPull(): Promise<void> {
    if (!this.runtime) throw new UpdateConflictError("Atelier is not running in a System-managed installation");
    if (this.switchingChannel) throw new UpdateConflictError("Release channel change is in progress");
    if (this.pullPromise) return this.pullPromise;
    if (!this.target || (this.state !== "available" && this.state !== "failed")) {
      throw new UpdateConflictError("No update is available to download. Check the selected channel first.");
    }
    this.pullPromise = this.pullNewestTarget().catch((error) => {
      this.setState("failed", { error: error instanceof Error ? error.message : String(error) });
    }).finally(() => {
      this.pullPromise = undefined;
    });
    return this.pullPromise;
  }

  private async pullNewestTarget(): Promise<void> {
    const reference = `ghcr.io/${repository}@${this.target!.digest}`;
    this.prepared = undefined;
    this.setState("pulling");
    this.prepared = await (this.deps.prepareUpdate ?? prepareUpdate)(reference, (progress) => {
      this.percent = progress.percent;
      this.progressMessage = progress.message;
      this.updateSidebar();
    });
    this.progressMessage = undefined;
    this.setState("ready_to_restart", { percent: 100 });
  }

  async restart(): Promise<void> {
    if (!this.runtime) throw new UpdateConflictError("Atelier is not running in a System-managed installation");
    if (this.switchingChannel || this.restarting) throw new UpdateConflictError("An update is already in progress");
    if (this.state !== "ready_to_restart" || !this.prepared) throw new UpdateConflictError("No prepared update is ready to restart");
    this.restarting = true;
    this.setState("restarting");
    try {
      await (this.deps.requestUpdate ?? requestSupervisorUpdate)(this.prepared.imageId);
    } catch (error) {
      this.restarting = false;
      this.setState("ready_to_restart", { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  clearError(): void {
    this.error = undefined;
    this.updateSidebar();
  }
}

const manager = new UpdateManager({ readChannel: readStoredReleaseChannel, writeChannel: writeStoredReleaseChannel });

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
    initialContent: { kind: "text" as const, text: "Download Atelier" },
    progressContent: { kind: "text" as const, text: "Download Atelier" },
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
    trigger: { type: "button", variant: "primary", content: { kind: "caption", caption: "Restart" } },
    confirmCaption: "Restart",
    cancelCaption: "Cancel",
  });
  return `<form method="post" action="/update/restart?surface=${surface}" data-turbo="false" data-controller="update-restart" data-action="submit->update-restart#submit">${confirmation}<p role="alert" data-update-restart-target="error" hidden></p></form>`;
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
  if (!snapshot.selfUpdatable) return "";
  if ((snapshot.state === "failed" && !snapshot.target) || snapshot.state === "idle") return renderCheckFeedback("initial");
  if (snapshot.state === "available" || snapshot.state === "failed" || snapshot.state === "pulling") return renderDownloadControl(snapshot);
  if (snapshot.state === "ready_to_restart") return renderRestartFeedback(surface);
  return progressButtonHtml({
    initialContent: { kind: "text", text: "Restart" },
    progressContent: { kind: "text", text: "Restarting…" },
    state: "in-progress",
    variant: "primary",
  });
}

function renderUpdateSettings(updateManager: UpdateManager, checked = false): string {
  const snapshot = updateManager.snapshot();
  const control = checked && snapshot.state === "idle" ? renderCheckFeedback("initial", true) : renderUpdateControl(snapshot, "settings");
  const disabled = !snapshot.selfUpdatable || snapshot.state === "pulling" || snapshot.state === "restarting";
  const channel = toggleHtml({
    variant: "button",
    label: "Update channel",
    name: "channel",
    value: snapshot.releaseChannel,
    form: { action: "/settings/update-channel" },
    options: [
      { value: "stable", label: "Stable", disabled },
      { value: "latest", label: "Latest", disabled },
    ],
  });
  const description = snapshot.selfUpdatable
    ? "Stable is the default; Latest follows the newest builds."
    : "Updates are available when Atelier runs inside Atelier System.";
  return `<section class="settings-sec update-settings-control" id="settings-sec-update"><div><h2>Updates</h2><p class="settings-sub">${description}</p></div><div class="update-settings-actions">${control}${channel}</div>${renderError(snapshot)}</section>`;
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

function renderSidebarRow(snapshot: StateSnapshot): string {
  if (!snapshot.selfUpdatable || snapshot.state === "idle" || snapshot.state === "checking") return "";
  return `<section class="update-sidebar-section"><div id="update_sidebar_row" class="update-sidebar-row"><p>${snapshot.state === "failed" ? "Atelier update needs attention." : "There's a new version of Atelier!"}</p>${renderUpdateControl(snapshot, "sidebar")}${renderError(snapshot)}</div></section>`;
}

function renderError(snapshot: StateSnapshot): string {
  if (!snapshot.error) return "";
  const dismiss = buttonHtml({ type: "submit", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Close, label: "Dismiss update error" } });
  return `<div role="alert"><p>${escapeHtml(snapshot.error)}</p><form method="post" action="/update/dismiss-error" data-turbo="true">${dismiss}</form></div>`;
}

export function createUpdateRouteHandler(updateManager: UpdateManager): (request: Request, url: URL) => Promise<Response | undefined> {
  return async (request, url) => {
    if (request.method === "POST" && (url.pathname.startsWith("/update/") || url.pathname === "/settings/update-channel") && !updateManager.snapshot().selfUpdatable) return new Response("Updates require Atelier System", { status: 409 });
    if (url.pathname === "/update/dismiss-error" && request.method === "POST") {
      updateManager.clearError();
      return turboStreamResponse(updateSettingsStream(updateManager));
    }
    if (url.pathname === "/settings/update-channel" && request.method === "POST") {
      const form = await request.formData();
      const channel = form.get("channel");
      if (!isReleaseChannel(channel)) return new Response("Unsupported release channel", { status: 400 });
      await updateManager.setReleaseChannel(channel);
      return turboStreamResponse(updateSettingsStream(updateManager));
    }
    if (url.pathname === "/update/start" && request.method === "POST") {
      try {
        void updateManager.startPull();
      } catch (error) {
        if (!(error instanceof UpdateConflictError)) throw error;
        return turboStreamResponse(updateSettingsStream(updateManager), { status: 409 });
      }
      return turboStreamResponse(updateSettingsStream(updateManager));
    }
    if (url.pathname === "/update/check-now" && request.method === "POST") {
      await updateManager.checkNow({ announceCurrent: true });
      return turboStreamResponse(updateSettingsStream(updateManager, true));
    }
    if (url.pathname === "/update/restart" && request.method === "POST") {
      try {
        await updateManager.restart();
        return new Response(null, { status: 204, headers: { "x-atelier-reload": "true" } });
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
