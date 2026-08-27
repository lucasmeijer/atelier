import { listOnboardingContributions, registerOnboardingContribution } from "./registry.ts";
import { escapeHtml, turboStream, turboStreamResponse } from "@atelier/shared";
import { hasWorkspaceGitHubToken } from "@atelier/proxy-egress";
import { hasAvailableConfiguredAgentModel } from "@atelier/agent/server";
import { githubRow, isOnboarded, renderModelSetup } from "../settings/routes.ts";

function response(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", headers.get("content-type") ?? "text/html; charset=utf-8");
  headers.set("cache-control", headers.get("cache-control") ?? "no-store");
  return new Response(body, { ...init, headers });
}

function stream(body: string): Response {
  return turboStreamResponse(body);
}

function update(target: string, html: string): string {
  return turboStream("update", target, html);
}

async function renderGithubStep(): Promise<string> {
  return `<div class="onboarding-step"><h2 class="title">Connect GitHub</h2>${githubRow("onboarding")}</div>`;
}

async function renderLlmStep(): Promise<string> {
  return `<div data-onboarding-wide>${await renderModelSetup("onboarding")}</div>`;
}

function renderDoneStep(items: Array<{ id: string; label: string; complete: boolean }>): string {
  const completed = items.filter((item) => item.complete).length;
  const allComplete = completed === items.length;
  const title = allComplete ? "You’re all set up and ready to start using Atelier" : `${completed}/${items.length} onboarding steps completed`;
  return `<div data-onboarding-done-complete="${allComplete ? "true" : "false"}"><h2 class="title">${escapeHtml(title)}</h2><ul class="status-list">${items.map((item) => `<li class="status-list__item" role="checkbox" aria-checked="${item.complete ? "true" : "false"}" data-onboarding-check="${escapeHtml(item.id)}"><span class="status-list__marker">${item.complete ? "✓" : "○"}</span>${escapeHtml(item.label)}</li>`).join("")}</ul></div>`;
}

registerOnboardingContribution({ id: "github", label: "GitHub", order: 20, isComplete: async () => hasWorkspaceGitHubToken(), render: renderGithubStep });
registerOnboardingContribution({ id: "llm", label: "Models", order: 30, isComplete: hasAvailableConfiguredAgentModel, render: renderLlmStep });

export async function renderOnboardingDialog(force = false): Promise<string> {
  if (!force && await isOnboarded()) return "";
  const allContributions = listOnboardingContributions();
  const allCompletions = await Promise.all(allContributions.map((contribution) => contribution.isComplete()));
  const contributions = force ? allContributions : allContributions.filter((_, index) => !allCompletions[index]);
  if (!contributions.length) return "";
  const rendered = await Promise.all(contributions.map((contribution) => contribution.render()));
  const completionById = new Map(allContributions.map((contribution, index) => [contribution.id, Boolean(allCompletions[index])]));
  rendered.push(renderDoneStep(allContributions.map((contribution) => ({ id: contribution.id, label: contribution.label, complete: completionById.get(contribution.id) ?? false }))));
  const steps = rendered.map((html, index) => {
    const contribution = contributions[index];
    const isDone = index === rendered.length - 1;
    const isComplete = isDone || (contribution ? completionById.get(contribution.id) === true : false);
    return `<section class="onboarding-pane" data-onboarding-target="pane" data-onboarding-complete="${isComplete}" data-onboarding-kind="${isDone ? "done" : contribution?.id ?? ""}"${index === 0 ? "" : " hidden"}>${html}</section>`;
  });
  return `<dialog id="onboarding_dialog" class="dialog onboarding-dialog" data-controller="modal onboarding" data-modal-auto-show-value="true" aria-label="Set up Atelier">
    <div class="onboarding-card">
      <div class="onboarding-progress" aria-label="Onboarding progress">${rendered.map((_, index) => `<span class="onboarding-progress-item" data-onboarding-target="dot"${index === 0 ? ' aria-current="step"' : ""}></span>`).join("")}</div>
      <div class="onboarding-body">${steps.join("")}</div>
      <footer class="dialog__actions onboarding-actions"><button class="button secondary" type="button" data-onboarding-target="back" data-action="onboarding#prev">‹ Back</button><button class="button secondary" type="button" data-onboarding-target="continue" data-action="onboarding#next">Continue</button></footer>
    </div>
  </dialog>`;
}

export async function renderOnboardingDialogIfNeeded(): Promise<string> {
  return await renderOnboardingDialog(false);
}

export async function handleOnboardingRequest(request: Request, url: URL): Promise<Response | undefined> {
  if (url.pathname === "/onboarding" && request.method === "GET") {
    const html = await renderOnboardingDialog(true);
    const acceptsStream = request.headers.get("accept")?.includes("text/vnd.turbo-stream.html") ?? false;
    if (acceptsStream) return stream(update("onboarding_modal_host", html));
    // Onboarding is a modal flow, not a standalone page. If a browser lands here
    // directly (or Turbo treats a click as a navigation), go back to the app.
    return Response.redirect(new URL("/", url).toString(), 303);
  }
  return undefined;
}
