export type WorkspaceProvisionStepStatus = "pending" | "running" | "done" | "failed";

export interface WorkspaceProvisionTerminal {
  kind: "host-tmux";
  session: string;
}

export interface WorkspaceProvisionStepEvent {
  workspaceId: string;
  id: string;
  label?: string;
  status?: WorkspaceProvisionStepStatus;
  parentId?: string;
  detail?: string;
  output?: string;
  terminal?: WorkspaceProvisionTerminal;
  error?: string;
}

declare module "@atelier/core" {
  interface AtelierEventMap {
    workspace_provision_step: WorkspaceProvisionStepEvent;
  }
}

export interface WorkspaceProvisionStep {
  id: string;
  label: string;
  status: WorkspaceProvisionStepStatus;
  parentId?: string;
  detail?: string;
  output?: string;
  terminal?: { kind: "host-tmux"; session: string };
  error?: string;
  order: number;
}

export interface WorkspaceProvisioningStore {
  apply(event: WorkspaceProvisionStepEvent): void;
  seed(workspaceId: string): void;
  render(workspaceId: string, options?: { failed?: boolean; error?: string }): string;
}

export interface WorkspaceProvisionSeedStep {
  id: string;
  label: string;
  parentId?: string;
}

export const workspaceProvisioningStaticFiles = {
  "/provisioning.css": { url: new URL("../client/provisioning.css", import.meta.url), contentType: "text/css; charset=utf-8" },
} as const;

const workspaceCreationSeedSteps: WorkspaceProvisionSeedStep[] = [
  { id: "workspace.workdir", label: "Create workspace directory" },
  { id: "workspace.source", label: "Prepare workspace source" },
  { id: "workspace.plan", label: "Prepare workspace container plan" },
  { id: "workspace.image", label: "Build workspace image" },
  { id: "workspace.container", label: "Start workspace container" },
  { id: "workspace.startup", label: "Wait for workspace startup" },
  { id: "workspace.verify", label: "Verify workspace" },
];

const workspaceIntegrationSeedStep: WorkspaceProvisionSeedStep = { id: "workspace.integrations", label: "Run workspace startup integrations" };

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function statusIcon(status: WorkspaceProvisionStepStatus): string {
  if (status === "done") return "✓";
  if (status === "failed") return "✕";
  if (status === "running") return "⟳";
  return "•";
}

function renderProvisionStep(step: WorkspaceProvisionStep, children: WorkspaceProvisionStep[]): string {
  const childHtml = children.map((child) => renderProvisionStep(child, [])).join("");
  const output = step.output ? `<pre class="provision-output-log provision-output" data-controller="auto-scroll">${escapeHtml(step.output)}</pre>` : "";
  const terminal = step.terminal ? `<div class="provision-terminal observable-terminal-host" data-controller="provision-terminal" data-provision-terminal-session-value="${escapeHtml(step.terminal.session)}"></div>` : "";
  const error = step.error ? `<div class="provision-error">${escapeHtml(step.error)}</div>` : "";
  const detail = step.detail ? `<div class="r-sub">${escapeHtml(step.detail)}</div>` : "";
  return `<li class="provision-step ${step.status}"><div class="provision-step-row"><span class="provision-step-icon">${statusIcon(step.status)}</span><div><b>${escapeHtml(step.label)}</b>${detail}</div></div>${terminal}${output}${error}${childHtml ? `<ol class="provision-children">${childHtml}</ol>` : ""}</li>`;
}

export function createWorkspaceProvisioningStore(options: { onChange: (workspaceId: string) => void; seedSteps: WorkspaceProvisionSeedStep[] }): WorkspaceProvisioningStore {
  const stepsByWorkspace = new Map<string, Map<string, WorkspaceProvisionStep>>();
  let order = 0;

  function steps(workspaceId: string): WorkspaceProvisionStep[] {
    return Array.from(stepsByWorkspace.get(workspaceId)?.values() ?? []).sort((a, b) => a.order - b.order);
  }

  function apply(event: WorkspaceProvisionStepEvent): void {
    let workspaceSteps = stepsByWorkspace.get(event.workspaceId);
    if (!workspaceSteps) {
      workspaceSteps = new Map();
      stepsByWorkspace.set(event.workspaceId, workspaceSteps);
    }
    const existing = workspaceSteps.get(event.id);
    workspaceSteps.set(event.id, {
      id: event.id,
      label: event.label ?? existing?.label ?? event.id,
      status: event.status ?? existing?.status ?? "pending",
      parentId: event.parentId ?? existing?.parentId,
      detail: event.detail ?? existing?.detail,
      output: event.output ?? existing?.output ?? "",
      terminal: event.terminal ?? existing?.terminal,
      error: event.error ?? existing?.error,
      order: existing?.order ?? ++order,
    });
    options.onChange(event.workspaceId);
  }

  return {
    apply,

    seed(workspaceId) {
      for (const step of [...workspaceCreationSeedSteps, ...options.seedSteps, workspaceIntegrationSeedStep]) apply({ workspaceId, ...step, status: "pending" });
    },

    render(workspaceId, renderOptions = {}) {
      const allSteps = steps(workspaceId);
      const top = allSteps.filter((step) => !step.parentId);
      const childrenByParent = new Map<string, WorkspaceProvisionStep[]>();
      for (const step of allSteps) if (step.parentId) childrenByParent.set(step.parentId, [...(childrenByParent.get(step.parentId) ?? []), step]);
      const body = top.length
        ? top.map((step) => renderProvisionStep(step, childrenByParent.get(step.id) ?? [])).join("")
        : `<li class="provision-step running"><div class="provision-step-row"><span class="provision-step-icon">⟳</span><div><b>Preparing workspace</b></div></div></li>`;
      const failed = allSteps.find((step) => step.status === "failed");
      const heading = renderOptions.failed ? "Workspace creation failed" : "Preparing workspace";
      const detail = failed?.label ? `Failed while: ${failed.label}` : renderOptions.failed ? (renderOptions.error ?? "unknown error") : "Workspace setup is running.";
      return `<div class="workspace-provision"><div class="provision-heading"><div><b>${escapeHtml(heading)}</b><div class="r-sub">${escapeHtml(detail)}</div></div></div><ol class="provision-list">${body}</ol></div>`;
    },
  };
}
