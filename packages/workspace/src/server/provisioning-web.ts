import { actionItemHtml } from "@atelier/design-system/action-item";
import { Icons } from "@atelier/design-system/icons";
import { buttonHtml } from "@atelier/design-system/button";
import { observableTerminalStaticFiles } from "@atelier/observable-terminal/server";
import { escapeHtml } from "@atelier/shared";
import type { WorkspaceProvisionStepEvent, WorkspaceProvisionStepStatus } from "../provisioning.ts";

export type { WorkspaceProvisionStepEvent, WorkspaceProvisionStepStatus, WorkspaceProvisionTerminal } from "../provisioning.ts";

export interface WorkspaceProvisionStep {
  id: string;
  label: string;
  status: WorkspaceProvisionStepStatus;
  parentId?: string;
  detail?: string;
  output?: string;
  terminal?: { kind: "host-tmux"; session: string };
  error?: string;
  awaitingContinue?: boolean;
  continueLabel?: string;
  order: number;
}

export interface WorkspaceProvisioningStore {
  apply(event: WorkspaceProvisionStepEvent): void;
  seed(workspaceId: string): void;
  render(workspaceId: string, options?: { failed?: boolean; error?: string }): string;
  delete(workspaceId: string): void;
}

export interface WorkspaceProvisionSeedStep {
  id: string;
  label: string;
  parentId?: string;
}

export const workspaceProvisioningStaticFiles = {
  "/provisioning.css": { url: new URL("../client/provisioning.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  ...observableTerminalStaticFiles,
} as const;

const workspaceCreationSeedSteps: WorkspaceProvisionSeedStep[] = [
  { id: "workspace.workdir", label: "Create workspace directory" },
  { id: "workspace.source", label: "Prepare workspace source" },
  { id: "workspace.plan", label: "Prepare workspace container plan" },
  { id: "workspace.image", label: "Resolve workspace image" },
  { id: "workspace.container", label: "Start workspace container" },
  { id: "workspace.startup", label: "Wait for workspace startup" },
  { id: "workspace.gateway", label: "Start workspace gateway" },
];

const workspaceIntegrationSeedStep: WorkspaceProvisionSeedStep = { id: "workspace.integrations", label: "Run workspace startup integrations" };

const workspaceProvisionStepRanks = new Map([
  "workspace.workdir",
  "workspace.source",
  "workspace.plan",
  "workspace.image",
  "workspace.docker-images",
  "workspace.image-carrier",
  "workspace.container",
  "workspace.startup",
  "workspace.gateway",
  "workspace.setup",
  "workspace.agent",
  "workspace.integrations",
].map((id, index) => [id, index]));

function stepStatusAttributes(status: WorkspaceProvisionStepStatus): string {
  if (status === "done") return ' role="checkbox" aria-checked="true"';
  if (status === "pending") return ' role="checkbox" aria-checked="false"';
  if (status === "running") return ' aria-busy="true"';
  return ' data-status="failed"';
}

function renderStatusMarker(status: WorkspaceProvisionStepStatus): string {
  const failedAttributes = status === "failed" ? ' role="img" aria-label="Failed"' : "";
  const marker = status === "done" ? "✓" : status === "failed" ? "✕" : "";
  return `<span class="status-list__marker"${failedAttributes}>${marker}</span>`;
}

function renderProvisionStep(workspaceId: string, step: WorkspaceProvisionStep, children: WorkspaceProvisionStep[]): string {
  const childHtml = children.map((child) => renderProvisionStep(workspaceId, child, [])).join("");
  const liveOutput = step.status === "running" ? step.output : undefined;
  const activity = liveOutput
    ? `<pre class="provision-terminal-progress provision-output-log" data-controller="auto-scroll">${escapeHtml(liveOutput)}</pre>`
    : step.status === "running" && step.terminal
      ? `<div class="provision-terminal observable-terminal-host" data-controller="provision-terminal" data-provision-terminal-session-value="${escapeHtml(step.terminal.session)}"></div>`
      : "";
  const output = step.output && step.status !== "running" ? `<details class="provision-output-disclosure"${step.status === "failed" ? " open" : ""}>${actionItemHtml({ kind: "single", element: { tag: "summary" }, leadingHtml: Icons.Disclosure, label: { kind: "text", text: "View output" } })}<pre class="provision-output-log provision-output" data-controller="auto-scroll">${escapeHtml(step.output)}</pre></details>` : "";
  const error = step.error ? `<div class="provision-error">${escapeHtml(step.error)}</div>` : "";
  const detail = step.detail ? `<span class="r-sub provision-step-detail">${escapeHtml(step.detail)}</span>` : "";
  const continueAction = step.awaitingContinue
    ? `<form class="provision-continue" method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/provisioning/continue">${buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: step.continueLabel ?? "Continue anyway" } })}</form>`
    : "";
  return `<li class="status-list__item provision-step"${stepStatusAttributes(step.status)}>${renderStatusMarker(step.status)}<div class="provision-step-content"><span class="provision-step-label">${escapeHtml(step.label)}</span>${detail}${activity}${output}${error}${continueAction}${childHtml ? `<ol class="status-list provision-children">${childHtml}</ol>` : ""}</div></li>`;
}

export function createWorkspaceProvisioningStore(options: { onChange: (workspaceId: string) => void; seedSteps: WorkspaceProvisionSeedStep[] }): WorkspaceProvisioningStore {
  const stepsByWorkspace = new Map<string, Map<string, WorkspaceProvisionStep>>();
  let order = 0;

  function steps(workspaceId: string): WorkspaceProvisionStep[] {
    return Array.from(stepsByWorkspace.get(workspaceId)?.values() ?? []).sort((a, b) => a.order - b.order);
  }

  function compareTopLevelSteps(a: WorkspaceProvisionStep, b: WorkspaceProvisionStep): number {
    const aRank = workspaceProvisionStepRanks.get(a.id);
    const bRank = workspaceProvisionStepRanks.get(b.id);
    if (aRank !== undefined && bRank !== undefined) return aRank - bRank;
    return a.order - b.order;
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
      awaitingContinue: event.awaitingContinue ?? existing?.awaitingContinue,
      continueLabel: event.continueLabel ?? existing?.continueLabel,
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
      const top = allSteps.filter((step) => !step.parentId).sort(compareTopLevelSteps);
      const childrenByParent = new Map<string, WorkspaceProvisionStep[]>();
      for (const step of allSteps) if (step.parentId) childrenByParent.set(step.parentId, [...(childrenByParent.get(step.parentId) ?? []), step]);
      const body = top.length
        ? top.map((step) => renderProvisionStep(workspaceId, step, childrenByParent.get(step.id) ?? [])).join("")
        : renderOptions.failed ? "" : '<li class="status-list__item provision-step" aria-busy="true"><span class="status-list__marker"></span><div class="provision-step-content"><span class="provision-step-label">Preparing workspace</span></div></li>';
      const failed = allSteps.find((step) => step.status === "failed");
      const failure = failed?.label ? `Failed while: ${failed.label}` : renderOptions.failed ? (renderOptions.error ?? "unknown error") : "";
      return `<section aria-label="Workspace preparation">${failure ? `<p class="provision-error">${escapeHtml(failure)}</p>` : ""}${body ? `<ol class="status-list provision-list">${body}</ol>` : ""}</section>`;
    },

    delete(workspaceId) {
      stepsByWorkspace.delete(workspaceId);
    },
  };
}
