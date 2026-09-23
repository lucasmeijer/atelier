import { actionItemHtml } from "@atelier/design-system/action-item";
import { panelHtml } from "@atelier/design-system/panel";
import { copyButtonHtml } from "@atelier/design-system/copy-button";
import { Icons } from "@atelier/design-system/icons";
import { buttonGroupHtml } from "@atelier/design-system/button-group";
import { buttonHtml } from "@atelier/design-system/button";
import { observableTerminalStaticFiles } from "@atelier/observable-terminal/server";
import { domId, escapeHtml } from "@atelier/shared";
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

interface ProvisionRecovery {
  stepId: string;
  description?: string;
  actionsHtml: string;
}

function renderProvisionStep(workspaceId: string, step: WorkspaceProvisionStep, waiting: WorkspaceProvisionSnapshot["waiting"], recovery?: ProvisionRecovery): string {
  const awaitingContinue = waiting?.stepId === step.id;
  const liveOutput = step.status === "running" ? step.output : undefined;
  const activity = liveOutput
    ? `<pre class="provision-terminal-progress provision-output-log" data-controller="auto-scroll">${escapeHtml(liveOutput)}</pre>`
    : step.status === "running" && step.terminalSession
      ? `<div id="${domId("provision_terminal", workspaceId, step.id, step.terminalSession)}" data-turbo-permanent class="provision-terminal observable-terminal-host" data-controller="provision-terminal" data-provision-terminal-session-value="${escapeHtml(step.terminalSession)}"></div>`
      : "";
  const log = [step.output, step.error && !step.output?.includes(step.error) ? step.error : undefined].filter(Boolean).join("\n\n");
  const output = log && step.status !== "running" ? `<details class="provision-output-disclosure"${step.error ? " open" : ""}>${actionItemHtml({ kind: "single", element: { tag: "summary" }, leadingHtml: Icons.Disclosure, label: { kind: "text", text: "View output" } })}<pre class="provision-output-log provision-output" data-controller="auto-scroll">${escapeHtml(log)}</pre></details>` : "";
  const detailText = step.status === "warning" ? "Continued despite this failure" : step.detail;
  const detail = detailText ? `<span class="r-sub provision-step-detail">${escapeHtml(detailText)}</span>` : "";
  const continueUrl = `/workspaces/${encodeURIComponent(workspaceId)}/provisioning/continue`;
  const description = recovery?.description ? `<p class="provision-recovery-description">${escapeHtml(recovery.description)}</p>` : "";
  const actions = awaitingContinue
    ? `<form class="provision-actions" method="post" action="${continueUrl}">${buttonGroupHtml({
      orientation: "horizontal",
      semantics: "group",
      label: "Preparation recovery",
      itemsHtml: (waiting.retryable ? buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Retry" }, attributesHtml: `formaction="${continueUrl}?action=retry"` }) : "")
        + (waiting.continuable ? buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "Continue anyway" } }) : "")
        + (recovery?.actionsHtml ?? ""),
    })}</form>`
    : recovery ? `<div class="provision-actions">${recovery.actionsHtml}</div>` : "";
  return `<li class="status-list__item provision-step"${stepStatusAttributes(step.status)}>${renderStatusMarker(step.status)}<div class="provision-step-content"><span class="provision-step-label">${escapeHtml(step.label)}</span>${detail}${activity}${output}${description}${actions}</div></li>`;
}

export function renderWorkspaceLaunchPrompt(launchPrompt: string | undefined): string {
  const prompt = launchPrompt?.trim();
  if (!prompt) return "";
  return `<div class="provision-launch-prompt">${panelHtml({
    element: { tag: "section", attributesHtml: 'aria-label="Launch prompt"' },
    headerHtml: `<h2 class="panel__title">Launch prompt</h2>${copyButtonHtml({ label: "Copy launch prompt", copyText: prompt })}`,
    bodyHtml: `<p>${escapeHtml(prompt)}</p>`,
    bodyLayout: "padded",
    bodyOverflow: "scroll",
  })}</div>`;
}

export function renderWorkspaceProvisioning(workspaceId: string, snapshot: WorkspaceProvisionSnapshot | undefined, options: { failed?: boolean; error?: string; recovery?: ProvisionRecovery } = {}): string {
  const body = snapshot?.steps.map((step) => renderProvisionStep(workspaceId, step, snapshot.waiting, options.recovery?.stepId === step.id ? options.recovery : undefined)).join("") ?? "";
  const failure = snapshot?.error ?? (options.failed ? options.error : undefined);
  const error = snapshot?.steps.some((step) => step.error === failure) ? undefined : failure;
  const progress = body || (options.failed ? "" : '<li class="status-list__item provision-step" aria-busy="true"><span class="status-list__marker"></span><div class="provision-step-content"><span class="provision-step-label">Preparing workspace</span></div></li>');
  return `<section aria-label="Workspace preparation">${error ? `<pre class="provision-output-log">${escapeHtml(error)}</pre>` : ""}${progress ? `<ol class="status-list status-list--compact provision-list">${progress}</ol>` : ""}</section>`;
}
