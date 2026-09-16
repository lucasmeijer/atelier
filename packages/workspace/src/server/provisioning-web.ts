import { actionItemHtml } from "@atelier/design-system/action-item";
import { Icons } from "@atelier/design-system/icons";
import { buttonGroupHtml } from "@atelier/design-system/button-group";
import { buttonHtml } from "@atelier/design-system/button";
import { observableTerminalStaticFiles } from "@atelier/observable-terminal/server";
import { escapeHtml } from "@atelier/shared";
import type { WorkspaceProvisionStep, WorkspaceProvisionSnapshot, WorkspaceProvisionStepStatus } from "../provisioning.ts";

export const workspaceProvisioningStaticFiles = {
  "/provisioning.css": { url: new URL("../client/provisioning.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  ...observableTerminalStaticFiles,
} as const;

function stepStatusAttributes(status: WorkspaceProvisionStepStatus): string {
  if (status === "done") return ' role="checkbox" aria-checked="true"';
  if (status === "running") return ' aria-busy="true"';
  return ` data-status="${status}"`;
}

function renderStatusMarker(status: WorkspaceProvisionStepStatus): string {
  const statusAttributes = status === "failed" || status === "warning" ? ` role="img" aria-label="${status === "warning" ? "Warning" : "Failed"}"` : "";
  const marker = status === "done" ? "✓" : status === "failed" ? "✕" : status === "warning" ? "!" : "";
  return `<span class="status-list__marker"${statusAttributes}>${marker}</span>`;
}

function renderProvisionStep(workspaceId: string, step: WorkspaceProvisionStep, waiting: WorkspaceProvisionSnapshot["waiting"]): string {
  const awaitingContinue = waiting?.stepId === step.id;
  const liveOutput = step.status === "running" ? step.output : undefined;
  const activity = liveOutput
    ? `<pre class="provision-terminal-progress provision-output-log" data-controller="auto-scroll">${escapeHtml(liveOutput)}</pre>`
    : step.status === "running" && step.terminalSession
      ? `<div class="provision-terminal observable-terminal-host" data-controller="provision-terminal" data-provision-terminal-session-value="${escapeHtml(step.terminalSession)}"></div>`
      : "";
  const output = step.output && step.status !== "running" ? `<details class="provision-output-disclosure"${step.status === "failed" ? " open" : ""}>${actionItemHtml({ kind: "single", element: { tag: "summary" }, leadingHtml: Icons.Disclosure, label: { kind: "text", text: "View output" } })}<pre class="provision-output-log provision-output" data-controller="auto-scroll">${escapeHtml(step.output)}</pre></details>` : "";
  const error = step.error && !(step.status === "failed" && step.error === step.output) ? `<div class="${step.status === "warning" ? "provision-warning" : "provision-error"}">${escapeHtml(step.error)}</div>` : "";
  const detailText = step.status === "warning" ? "Continued despite this failure" : step.detail;
  const detail = detailText ? `<span class="r-sub provision-step-detail">${escapeHtml(detailText)}</span>` : "";
  const continueUrl = `/workspaces/${encodeURIComponent(workspaceId)}/provisioning/continue`;
  const actions = awaitingContinue
    ? `<form class="provision-actions" method="post" action="${continueUrl}">${buttonGroupHtml({
      orientation: "horizontal",
      semantics: "group",
      label: "Preparation recovery",
      itemsHtml: (waiting.retryable ? buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Retry" }, attributesHtml: `formaction="${continueUrl}?action=retry"` }) : "")
        + buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "Continue anyway" } }),
    })}</form>`
    : "";
  return `<li class="status-list__item provision-step"${stepStatusAttributes(step.status)}>${renderStatusMarker(step.status)}<div class="provision-step-content"><span class="provision-step-label">${escapeHtml(step.label)}</span>${detail}${activity}${output}${error}${actions}</div></li>`;
}

export function renderWorkspaceProvisioning(workspaceId: string, snapshot: WorkspaceProvisionSnapshot | undefined, options: { failed?: boolean; error?: string } = {}): string {
  const body = snapshot?.steps.map((step) => renderProvisionStep(workspaceId, step, snapshot.waiting)).join("") ?? "";
  const error = snapshot?.error ?? (options.failed ? options.error : undefined);
  const progress = body || (options.failed ? "" : '<li class="status-list__item provision-step" aria-busy="true"><span class="status-list__marker"></span><div class="provision-step-content"><span class="provision-step-label">Preparing workspace</span></div></li>');
  return `<section aria-label="Workspace preparation">${error ? `<p class="provision-error">${escapeHtml(error)}</p>` : ""}${progress ? `<ol class="status-list provision-list">${progress}</ol>` : ""}</section>`;
}
