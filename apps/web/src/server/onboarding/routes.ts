import { listOnboardingContributions, registerOnboardingContribution } from "./registry.ts";
import { hasWorkspaceGitHubToken } from "@atelier/core";
import { githubRow, isOnboarded, providerRow, providerSummaries, showMoreProvidersButton } from "../settings/routes.ts";

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

async function renderGithubStep(): Promise<string> {
  return `<div class="onboarding-step"><h2>Connect GitHub</h2><p>So atelier can clone private repositories, create workspaces, and inject <code>GH_TOKEN</code> safely into workspace network requests.</p><div class="settings-providers">${githubRow()}</div></div>`;
}

async function renderLlmStep(): Promise<string> {
  const providers = await providerSummaries();
  return `<div class="onboarding-step"><h2>Connect a model provider</h2><p>The agent needs at least one provider. API keys and OAuth tokens are stored locally in pi-compatible auth storage.</p><div class="settings-providers" data-provider-list-scope>${providers.map((provider) => providerRow(provider, "onboarding")).join("")}${showMoreProvidersButton(providers)}</div></div>`;
}

registerOnboardingContribution({ id: "github", label: "GitHub", order: 10, isComplete: async () => hasWorkspaceGitHubToken(), render: renderGithubStep });
registerOnboardingContribution({ id: "llm", label: "Model provider", order: 20, isComplete: async () => false, render: renderLlmStep });

export async function renderOnboardingDialog(force = false): Promise<string> {
  if (!force && await isOnboarded()) return "";
  const contributions = listOnboardingContributions();
  const steps = await Promise.all(contributions.map((contribution, index) => contribution.render().then((html) => `<section class="onboarding-pane ${index === 0 ? "active" : ""}" data-onboarding-target="pane">${html}</section>`)));
  return `<dialog id="onboarding_dialog" class="onboarding-dialog" data-controller="modal onboarding" data-modal-auto-show-value="true">
    <div class="onboarding-card">
      <div class="onboarding-dots">${contributions.map((_, index) => `<span class="${index === 0 ? "active" : ""}" data-onboarding-target="dot"></span>`).join("")}</div>
      <div class="onboarding-body">${steps.join("")}</div>
      <div class="onboarding-foot"><button class="settings-btn" type="button" data-action="onboarding#prev">‹ Back</button><span></span><button class="settings-btn" type="button" data-action="modal#close">Skip</button><button class="settings-btn primary" type="button" data-action="onboarding#next">Continue</button></div>
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
