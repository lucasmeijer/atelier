import { listOnboardingContributions, registerOnboardingContribution } from "./registry.ts";
import { buttonHtml } from "@atelier/design-system/button";
import { dialogHtml } from "@atelier/design-system/dialog";
import { Icons } from "@atelier/design-system/icons";
import { escapeHtml, turboStreamResponse } from "@atelier/shared";
import { hasWorkspaceGitHubToken } from "@atelier/proxy-egress";
import { hasAvailableConfiguredAgentModel } from "@atelier/agent/server";
import { renderGitHubSetup } from "../settings/github.ts";
import { renderModelSetup } from "../settings/models.ts";
import { turboUpdateStream as update } from "../http-responses.ts";

function stream(body: string): Response {
  return turboStreamResponse(body);
}

async function renderGithubStep(): Promise<string> {
  return `<div class="onboarding-step form-stack"><h2 class="title">Connect GitHub</h2>${renderGitHubSetup("onboarding")}</div>`;
}

async function renderLlmStep(): Promise<string> {
  return renderModelSetup("onboarding");
}

function renderDoneStep(items: Array<{ id: string; label: string; complete: boolean }>): string {
  const completed = items.filter((item) => item.complete).length;
  const allComplete = completed === items.length;
  const title = allComplete ? "You’re all set up and ready to start using Atelier" : `${completed}/${items.length} onboarding steps completed`;
  return `<div data-onboarding-done-complete="${allComplete ? "true" : "false"}"><h2 class="onboarding-completion-title">${escapeHtml(title)}</h2><ul class="status-list">${items.map((item) => `<li class="status-list__item" role="checkbox" aria-checked="${item.complete ? "true" : "false"}" data-onboarding-check="${escapeHtml(item.id)}"><span class="status-list__marker">${item.complete ? "✓" : ""}</span>${escapeHtml(item.label)}</li>`).join("")}</ul></div>`;
}

registerOnboardingContribution({ id: "github", label: "GitHub", order: 20, isComplete: async () => hasWorkspaceGitHubToken(), render: renderGithubStep });
registerOnboardingContribution({ id: "llm", label: "Models", order: 30, isComplete: hasAvailableConfiguredAgentModel, render: renderLlmStep });

export async function renderOnboardingDialog(options: { includeCompleted?: boolean; resumeAfter?: string } = {}): Promise<string> {
  const allContributions = listOnboardingContributions();
  const allCompletions = await Promise.all(allContributions.map((contribution) => contribution.isComplete()));
  if (!options.includeCompleted && !options.resumeAfter && allCompletions.every(Boolean)) return "";
  const contributions = options.includeCompleted || options.resumeAfter ? allContributions : allContributions.filter((_, index) => !allCompletions[index]);
  if (!contributions.length) return "";
  const rendered = await Promise.all(contributions.map((contribution) => contribution.render()));
  const completionById = new Map(allContributions.map((contribution, index) => [contribution.id, Boolean(allCompletions[index])]));
  rendered.push(renderDoneStep(allContributions.map((contribution) => ({ id: contribution.id, label: contribution.label, complete: completionById.get(contribution.id) ?? false }))));
  const initialIndex = options.resumeAfter === undefined ? 0 : contributions.findIndex((contribution) => contribution.id === options.resumeAfter) + 1;
  const steps = rendered.map((html, index) => {
    const contribution = contributions[index];
    const isDone = index === rendered.length - 1;
    const isComplete = isDone || (contribution ? completionById.get(contribution.id) === true : false);
    return `<section class="onboarding-pane" data-onboarding-target="pane" data-onboarding-complete="${isComplete}" data-onboarding-kind="${isDone ? "done" : contribution?.id ?? ""}"${index === initialIndex ? "" : " hidden"}>${html}</section>`;
  });
  const backButton = buttonHtml({
    type: "button",
    variant: "secondary",
    content: { kind: "caption", caption: "‹ Back" },
    attributesHtml: 'data-onboarding-target="back" data-action="onboarding#prev"',
  });
  const continueButton = buttonHtml({
    type: "button",
    variant: "secondary",
    content: { kind: "caption", caption: "Continue" },
    attributesHtml: 'data-onboarding-target="continue" data-action="onboarding#next"',
  });
  return dialogHtml({
    element: {
      id: "onboarding_dialog",

      attributesHtml: 'data-controller="onboarding" data-dialog-auto-show',
    },
    iconHtml: Icons.Atelier,
    titleCaption: "Set up Atelier",
    bodyHtml: `<div class="onboarding-progress" aria-label="Onboarding progress">${rendered.map((_, index) => `<span class="onboarding-progress-item" data-onboarding-target="dot"${index === initialIndex ? ' aria-current="step"' : ""}></span>`).join("")}</div><div class="onboarding-body">${steps.join("")}</div>`,
    bodyLayout: "full-bleed",
    footerHtml: `${backButton}${continueButton}`,
    omitCancelButton: true,
  });
}

export async function handleOnboardingRequest(request: Request, url: URL): Promise<Response | undefined> {
  if (url.pathname === "/onboarding" && request.method === "GET") {
    const html = await renderOnboardingDialog({ includeCompleted: true });
    const acceptsStream = request.headers.get("accept")?.includes("text/vnd.turbo-stream.html") ?? false;
    if (acceptsStream) return stream(update("onboarding_modal_host", html));
    // Onboarding is a modal flow, not a standalone page. If a browser lands here
    // directly (or Turbo treats a click as a navigation), go back to the app.
    return Response.redirect(new URL("/", url).toString(), 303);
  }
  return undefined;
}
