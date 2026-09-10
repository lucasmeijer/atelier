import { registerWorkspacePresenter } from "@atelier/agent/server";
import { buttonHtml } from "@atelier/design-system/button";
import { Icons } from "@atelier/design-system/icons";
import { escapeHtml, type WorkspaceModule, type WorkspaceWorkViewPresentation } from "@atelier/shared";
import { createWorkspaceMetadataState, workspacePortBackend } from "@atelier/workspace";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createDesktopPresenter } from "./agent-tool.ts";
import { desktopRuntime } from "./runtime.ts";
import { desktopViewerResponse } from "./viewer.ts";

const reference = { type: "desktop" };
const referenceSchema = Type.Object({ type: Type.Literal("desktop") }, { additionalProperties: false });
const stateSchema = Type.Object({ open: Type.Boolean() });
const views = createWorkspaceMetadataState("desktop-view.json", (value) => Value.Parse(stateSchema, value), () => ({ open: false }));
const presentation: WorkspaceWorkViewPresentation = {
  sourceKey: "desktop", label: "Desktop", reference, kind: "resource", iconHtml: Icons.Workspace,
  availability: { phase: "live" },
};

export const atelierServerModule: WorkspaceModule = {
  id: "desktop",
  staticFiles: { "/desktop.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" } },
  workViews: [{
    type: "desktop",
    parseReference: (value) => Value.Parse(referenceSchema, value),
    identity: () => "desktop",
    render: ({ workspaceId }) => {
      const fullscreen = buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Fullscreen" }, attributesHtml: 'data-desktop-pane-target="fullscreen" data-action="desktop-pane#toggleFullscreen" aria-pressed="false"' });
      const statuses = [["connecting", "Connecting", "running"], ["connected", "Connected", "success"], ["disconnected", "Disconnected · reconnecting", "warning"], ["starting", "Starting desktop", "running"], ["stopped", "Desktop stopped", ""], ["failed", "Desktop failed", "danger"]]
        .map(([phase, label, tone]) => `<span data-desktop-pane-target="status" data-phase="${phase}"${phase === "connecting" ? "" : " hidden"}><i class="status-dot ${tone}" aria-hidden="true"></i>${label}</span>`).join("");
      return `<section class="work-view-pane" data-work-view-source="desktop"><div class="desktop-pane" data-controller="desktop-pane" data-action="message@window->desktop-pane#receive fullscreenchange@document->desktop-pane#fullscreenChanged"><div class="desktop-toolbar"><div class="desktop-connection" role="status" aria-live="polite">${statuses}<span class="desktop-status-detail" data-desktop-pane-target="detail"></span></div>${fullscreen}</div><iframe class="desktop-frame" title="Workspace desktop" data-desktop-pane-target="frame" data-action="load->desktop-pane#loaded desktop:navigating->desktop-pane#reset" data-controller="workspace-app-frame" data-workspace-app-frame-workspace-id-value="${escapeHtml(workspaceId)}" data-workspace-app-frame-app-key-value="desktop"></iframe></div></section>`;
    },
    close: ({ workspaceId }) => views.write(workspaceId, { open: false }),
  }],
  commands: [{
    id: "desktop.start",
    async execute({ workspaceId }) {
      await desktopRuntime.start(workspaceId);
      views.write(workspaceId, { open: true });
      return { createdWorkView: reference };
    },
  }],
  initialize(context) {
    context.registerWorkspaceAppResolver(async (app, url) => {
      if (app.appKey !== "desktop") return undefined;
      // Only the remote-display transport is exposed. Never proxy CDP or VNC.
      if (url.pathname === "/websockify") return workspacePortBackend(app.workspaceId, 6080, "/");
      return { kind: "fetch", fetch: (request) => request.method === "GET"
        ? desktopViewerResponse(new URL(request.url), () => desktopRuntime.status(app.workspaceId))
        : new Response("Method not allowed", { status: 405, headers: { allow: "GET" } }) };
    });
    context.onWorkspaceRemoved((workspaceId) => views.delete(workspaceId));
    registerWorkspacePresenter("desktop", (workspaceId) => createDesktopPresenter({
      startDesktop: () => desktopRuntime.start(workspaceId),
      async presentDesktop() {
        views.write(workspaceId, { open: true });
        await context.presentWorkView(workspaceId, reference);
      },
    }));
  },
  attachToWorkspace({ workspaceId }) {
    return {
      workViews: views.read(workspaceId).open ? [presentation] : [],
      commands: [{ id: "desktop.start", label: "Open Desktop", description: "Start or reuse the workspace's Xvfb display and Chromium, and open Desktop.", scope: "workspace", surfaces: { ui: { placement: "work-launcher", iconHtml: Icons.Workspace, label: "Desktop" } } }],
    };
  },
};
