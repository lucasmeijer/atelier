import { destructiveConfirmationHtml } from "@atelier/design-system/destructive-confirmation";
import { clearWorkspaceGitHubToken, hasWorkspaceGitHubToken, setWorkspaceGitHubToken } from "@atelier/proxy-egress";
import { getStoredGitIdentity, setGitIdentity } from "@atelier/projects";
import { validateGitHubToken } from "../github-auth.ts";
import { renderOnboardingDialog } from "../onboarding/routes.ts";
import { replace, stream, update } from "./http.ts";
import { renderSettingsDialog } from "./page.ts";
import { domId, escapeHtml } from "@atelier/shared";
import { registerSettingsContribution } from "./registry.ts";
import { providerIcon, type SettingsSurface } from "./views.ts";

const githubDisconnectConfirmation = destructiveConfirmationHtml({
  buttonHtml: '<button class="button danger" type="button">Disconnect</button>',
  confirmCaption: "Disconnect GitHub",
  cancelCaption: "Cancel",
});

function githubConnectionForm(surface: SettingsSurface, error: string): string {
  const action = surface === "onboarding" ? "/settings/github/connect?surface=onboarding" : "/settings/github/connect";
  const rowClass = surface === "settings" ? " github-connect-form--row" : "";
  return `<form class="github-connect-form${rowClass} form-stack" method="post" action="${action}" data-turbo="true">
    <p>On your machine, sign in with GitHub CLI if needed, then print your token:</p>
    <pre class="settings-command">gh auth login
gh auth token</pre>
    <p>Paste the token output below. Atelier stores and encrypts it outside of the agent sandbox so the agent never sees it, but can still read and write from your github repo’s.</p>
    ${error ? `<p class="settings-error">${escapeHtml(error)}</p>` : ""}
    <div class="github-connect-controls"><input class="settings-input text-field" type="password" name="token" placeholder="Paste output from gh auth token" aria-label="GitHub token" autocomplete="off" required><button class="button primary" type="submit">Connect</button></div>
  </form>`;
}

export function renderGitHubSetup(surface: SettingsSurface = "settings", error = ""): string {
  const connected = hasWorkspaceGitHubToken();
  const id = domId(surface, "provider", "github");
  const disconnectAction = surface === "onboarding" ? "/settings/github/disconnect?surface=onboarding" : "/settings/github/disconnect";
  if (surface === "onboarding" && !connected) return `<div class="github-connection" id="${id}">${githubConnectionForm(surface, error)}</div>`;
  return `<div class="github-connection" id="${id}"><div class="managed-list"><div class="managed-list__item">
    ${providerIcon("github", "GitHub", "settings-provider-icon managed-list__visual")}
    <div class="managed-list__content"><div class="managed-list__label"><span class="managed-list__label-text">GitHub</span></div>${connected ? "" : githubConnectionForm(surface, error)}</div>
    ${connected ? `<div class="managed-list__actions"><form method="post" action="${disconnectAction}" data-turbo="true">${githubDisconnectConfirmation}</form></div>` : ""}
  </div></div></div>`;
}

async function renderGitHubSettings(): Promise<string> {
  return `<section class="settings-sec settings-sec-github" id="settings-sec-github">${renderGitHubSetup()}</section>`;
}

registerSettingsContribution({ id: "github", label: "GitHub", order: 30, render: renderGitHubSettings });

export async function handleGitHubSettingsRequest(request: Request, url: URL): Promise<Response | undefined> {
  if (url.pathname === "/settings/github/connect" && request.method === "POST") {
    const surface = url.searchParams.get("surface") === "onboarding" ? "onboarding" : "settings";
    const form = await request.formData();
    const token = String(form.get("token") ?? "").trim();
    const validation = await validateGitHubToken(token);
    if (!validation.ok) return stream(replace(domId(surface, "provider", "github"), renderGitHubSetup(surface, validation.message)));
    setWorkspaceGitHubToken(token);
    if (!await getStoredGitIdentity()) await setGitIdentity({ name: validation.name, email: validation.email });
    return surface === "onboarding"
      ? stream(update("onboarding_modal_host", await renderOnboardingDialog({ resumeAfter: "github" })))
      : stream(`${replace("settings_dialog", await renderSettingsDialog())}${update("onboarding_modal_host", await renderOnboardingDialog())}`);
  }
  if (url.pathname === "/settings/github/disconnect" && request.method === "POST") {
    const surface = url.searchParams.get("surface") === "onboarding" ? "onboarding" : "settings";
    clearWorkspaceGitHubToken();
    return surface === "onboarding"
      ? stream(update("onboarding_modal_host", await renderOnboardingDialog()))
      : stream(replace("settings_dialog", await renderSettingsDialog()));
  }
  return undefined;
}
