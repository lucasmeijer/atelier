import { listOnboardingContributions, registerOnboardingContribution } from "./registry.ts";
import { hasWorkspaceGitHubToken } from "@atelier/core";
import { hasGitIdentity } from "@atelier/repository";
import { githubRow, hasAnyLlmProvider, isOnboarded, providerRow, providerSummaries, renderGitIdentityForm, showMoreProvidersButton } from "../settings/routes.ts";

function escapeHtml(value: unknown): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function response(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", headers.get("content-type") ?? "text/html; charset=utf-8");
  headers.set("cache-control", headers.get("cache-control") ?? "no-store");
  return new Response(body, { ...init, headers });
}

function stream(body: string): Response {
  return response(body, { headers: { "content-type": "text/vnd.turbo-stream.html; charset=utf-8" } });
}

function update(target: string, html: string): string {
  return `<turbo-stream action="update" target="${escapeHtml(target)}"><template>${html}</template></turbo-stream>`;
}

async function renderGitIdentityStep(): Promise<string> {
  return `<div class="onboarding-step"><h2>Set your git identity</h2><p>Atelier writes this to new workspace containers so commits made by you or the agent have the right author.</p>${await renderGitIdentityForm("onboarding")}</div>`;
}

async function renderGithubStep(): Promise<string> {
  return `<div class="onboarding-step"><h2>Connect GitHub</h2><div class="settings-providers">${githubRow("onboarding")}</div></div>`;
}

async function renderLlmStep(): Promise<string> {
  const providers = await providerSummaries();
  return `<div class="onboarding-step onboarding-step-model-provider"><h2>Connect a model provider</h2><div class="settings-providers" data-provider-list-scope>${providers.map((provider) => providerRow(provider, "onboarding")).join("")}${showMoreProvidersButton(providers)}</div></div>`;
}

registerOnboardingContribution({ id: "git-identity", label: "Git identity", order: 10, isComplete: hasGitIdentity, render: renderGitIdentityStep });
registerOnboardingContribution({ id: "github", label: "GitHub", order: 20, isComplete: async () => hasWorkspaceGitHubToken(), render: renderGithubStep });
registerOnboardingContribution({ id: "llm", label: "Model provider", order: 30, isComplete: hasAnyLlmProvider, render: renderLlmStep });

export async function renderOnboardingDialog(force = false): Promise<string> {
  if (!force && await isOnboarded()) return "";
  const allContributions = listOnboardingContributions();
  const allCompletions = await Promise.all(allContributions.map((contribution) => contribution.isComplete()));
  const contributions = force ? allContributions : allContributions.filter((_, index) => !allCompletions[index]);
  const completions = force ? allCompletions : contributions.map(() => false);
  if (!contributions.length) return "";
  const steps = await Promise.all(contributions.map((contribution, index) => contribution.render().then((html) => `<section class="onboarding-pane ${index === 0 ? "active" : ""}" data-onboarding-target="pane" data-onboarding-complete="${completions[index] ? "true" : "false"}">${html}</section>`)));
  return `<dialog id="onboarding_dialog" class="onboarding-dialog" data-controller="modal onboarding" data-modal-auto-show-value="true">
    <div class="onboarding-card">
      <div class="onboarding-dots">${contributions.map((_, index) => `<span class="${index === 0 ? "active" : ""}" data-onboarding-target="dot"></span>`).join("")}</div>
      <div class="onboarding-body">${steps.join("")}</div>
      <div class="onboarding-foot"><button class="settings-btn" type="button" data-action="onboarding#prev">‹ Back</button><span></span><button class="settings-btn" type="button" data-onboarding-target="continue" data-action="onboarding#next">Continue</button></div>
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
