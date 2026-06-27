import { listOnboardingContributions, registerOnboardingContribution } from "./registry.ts";
import { escapeHtml, turboStream, turboStreamResponse } from "@atelier/shared";
import { hasWorkspaceGitHubToken } from "@atelier/proxy-egress";
import { hasGitIdentity } from "@atelier/projects";
import { githubRow, hasAvailableFavoriteModel, isOnboarded, renderGitIdentityForm, renderModelSetup } from "../settings/routes.ts";

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

async function renderGitIdentityStep(): Promise<string> {
  return `<div class="onboarding-step"><h2>Set your git identity</h2><p>Atelier writes this to new workspace containers so commits made by you or the agent have the right author.</p>${await renderGitIdentityForm("onboarding")}</div>`;
}

async function renderGithubStep(): Promise<string> {
  return `<div class="onboarding-step"><h2>Connect GitHub</h2><div class="settings-providers">${githubRow("onboarding")}</div></div>`;
}

async function renderLlmStep(): Promise<string> {
  return `<div class="onboarding-step onboarding-step-model-provider">${await renderModelSetup("onboarding")}</div>`;
}

function renderDoneStep(items: Array<{ id: string; label: string; complete: boolean }>): string {
  const completed = items.filter((item) => item.complete).length;
  const allComplete = completed === items.length;
  const title = allComplete ? "You’re all set up and ready to start using Atelier" : `${completed}/${items.length} onboarding steps completed`;
  return `<div class="onboarding-step onboarding-step-done" data-onboarding-done-complete="${allComplete ? "true" : "false"}"><h2>${escapeHtml(title)}</h2><ul class="onboarding-checklist">${items.map((item) => `<li data-onboarding-check="${escapeHtml(item.id)}" data-onboarding-check-complete="${item.complete ? "true" : "false"}"><span>${item.complete ? "✓" : "○"}</span>${escapeHtml(item.label)}</li>`).join("")}</ul></div>`;
}

registerOnboardingContribution({ id: "git-identity", label: "Git identity", order: 10, isComplete: hasGitIdentity, render: renderGitIdentityStep });
registerOnboardingContribution({ id: "github", label: "GitHub", order: 20, isComplete: async () => hasWorkspaceGitHubToken(), render: renderGithubStep });
registerOnboardingContribution({ id: "llm", label: "Models", order: 30, isComplete: hasAvailableFavoriteModel, render: renderLlmStep });

export async function renderOnboardingDialog(force = false): Promise<string> {
  if (!force && await isOnboarded()) return "";
  const allContributions = listOnboardingContributions();
  const allCompletions = await Promise.all(allContributions.map((contribution) => contribution.isComplete()));
  const contributions = allContributions.filter((_, index) => !allCompletions[index]);
  if (!contributions.length) return "";
  const rendered = await Promise.all(contributions.map((contribution) => contribution.render()));
  rendered.push(renderDoneStep(allContributions.map((contribution, index) => ({ id: contribution.id, label: contribution.label, complete: Boolean(allCompletions[index]) }))));
  const steps = rendered.map((html, index) => `<section class="onboarding-pane ${index === 0 ? "active" : ""}" data-onboarding-target="pane" data-onboarding-complete="${index === rendered.length - 1 ? "true" : "false"}" data-onboarding-kind="${index === rendered.length - 1 ? "done" : contributions[index]?.id ?? ""}">${html}</section>`);
  return `<dialog id="onboarding_dialog" class="onboarding-dialog" data-controller="modal onboarding" data-modal-auto-show-value="true">
    <div class="onboarding-card">
      <div class="onboarding-dots">${rendered.map((_, index) => `<span class="${index === 0 ? "active" : ""}" data-onboarding-target="dot"></span>`).join("")}</div>
      <div class="onboarding-body">${steps.join("")}</div>
      <div class="onboarding-foot"><button class="settings-btn" type="button" data-onboarding-target="back" data-action="onboarding#prev">‹ Back</button><span></span><button class="settings-btn" type="button" data-onboarding-target="continue" data-action="onboarding#next">Continue</button></div>
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
