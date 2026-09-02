import { dialogHtml } from "@atelier/design-system/dialog";
import { destructiveConfirmationHtml } from "@atelier/design-system/destructive-confirmation";
import { Icons } from "@atelier/design-system/icons";
import { createPiModelRuntime, setPickerAgentModels } from "@atelier/agent/server";
import { escapeHtml } from "@atelier/shared";
import { clearWorkspaceGitHubToken } from "@atelier/proxy-egress";
import { clearGitIdentity, getGitIdentity, setGitIdentity } from "@atelier/projects";
import { renderOnboardingDialog } from "../onboarding/routes.ts";
import { workspaceModules } from "../workspace-modules.ts";
import { remove, replace, response, stream, update, wantsStream } from "./http.ts";
import { listSettingsContributions, registerSettingsContribution } from "./registry.ts";

function devSettingsEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}

async function renderThemeSettings(): Promise<string> {
  const themes = [["daylight", "Daylight"], ["cappuccino", "Cappuccino"], ["tokyo-night", "Tokyo Night"], ["midnight", "Midnight"], ["nord", "Nord"]];
  return `<section class="settings-sec settings-sec-inline settings-sec-theme" id="settings-sec-theme"><h2>Theme</h2><select class="settings-select popup-select" data-controller="theme-select" aria-label="Theme">${themes.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></section>`;
}

async function renderGitIdentityForm(error = ""): Promise<string> {
  const identity = await getGitIdentity();
  return `<form id="settings_git_identity" class="settings-git-identity" method="post" action="/settings/git-identity" data-controller="git-identity" data-action="input->git-identity#queue change->git-identity#save submit->git-identity#submit">
    ${error ? `<p class="settings-error">${escapeHtml(error)}</p>` : ""}
    <label class="settings-field"><span class="settings-field-label">Git user name</span><input class="settings-input text-field" name="name" value="${escapeHtml(identity?.name ?? "")}" placeholder="Ada Lovelace" autocomplete="name" required></label>
    <label class="settings-field"><span class="settings-field-label">Git email</span><input class="settings-input text-field" type="email" name="email" value="${escapeHtml(identity?.email ?? "")}" placeholder="ada@example.com" autocomplete="email" required></label>
  </form>`;
}

async function renderGitIdentitySettings(): Promise<string> {
  return `<section class="settings-sec" id="settings-sec-git-identity">${await renderGitIdentityForm()}</section>`;
}

export type WorkspaceCleanupResult = { deleted: number; errors: string[] };

function renderForceDeleteWorkspaces(result?: WorkspaceCleanupResult): string {
  const confirmation = destructiveConfirmationHtml({
    buttonHtml: '<button class="button danger" type="button">Force delete all workspaces</button>',
    confirmCaption: "Force delete all workspaces",
    cancelCaption: "Cancel",
  });
  const deleted = result === undefined ? "" : `<p role="status">Deleted ${escapeHtml(result.deleted)} workspace${result.deleted === 1 ? "" : "s"}.</p>`;
  const errors = result?.errors.length ? `<p class="settings-error">${escapeHtml(result.errors.join("\n"))}</p>` : "";
  return `<div id="settings_force_delete_workspaces" class="settings-force-delete">${deleted}${errors}<form method="post" action="/settings/workspaces/force-delete" data-turbo="true">${confirmation}</form></div>`;
}

async function renderDevelopmentSettings(): Promise<string> {
  const forceDeleteWorkspaces = devSettingsEnabled() ? renderForceDeleteWorkspaces() : "";
  const keypressProbeSettings = await listSettingsContributions().find((contribution) => contribution.id === "keypress-probe")?.render() ?? "";
  const resetSettings = `<form class="settings-reset-form" method="post" action="/settings/reset" data-turbo="true"><button class="settings-reset-link" type="submit" onclick="return confirm('Delete stored git identity, GitHub token, and all stored model provider credentials?')">delete all settings</button></form>`;
  return `${keypressProbeSettings}<div class="settings-dev-actions">${resetSettings}${forceDeleteWorkspaces}</div>`;
}

registerSettingsContribution({ id: "theme", label: "Theme", order: 10, render: renderThemeSettings });
registerSettingsContribution({ id: "git-identity", label: "Git identity", order: 20, render: renderGitIdentitySettings });
for (const module of workspaceModules) {
  for (const contribution of module.settingsContributions ?? []) registerSettingsContribution(contribution);
}

function settingsDialogHtml(titleCaption: string, bodyHtml: string): string {
  return dialogHtml({
    element: {
      id: "settings_dialog",
      className: "dialog--sheet settings-dialog",
      attributesHtml: 'aria-label="Settings" data-dialog-auto-show',
    },
    iconHtml: Icons.Settings,
    titleCaption,
    bodyHtml,
    bodyLayout: "full-bleed",
    closeLabel: "Close settings",
  });
}

export async function renderSettingsDialog(): Promise<string> {
  const contributions = listSettingsContributions().filter((contribution) => contribution.id !== "keypress-probe");
  const sections = await Promise.all(contributions.map((contribution) => contribution.render()));
  return settingsDialogHtml("Settings", `<main class="settings-main">${sections.join("")}<div class="settings-dev-link"><a href="/settings/development" data-turbo-frame="_top" data-turbo-stream="true">Development settings</a></div></main>`);
}

export async function renderDevelopmentSettingsDialog(): Promise<string> {
  const backLink = '<div class="settings-development-back"><a class="settings-back-link" href="/settings" data-turbo-frame="_top" data-turbo-stream="true">Settings</a></div>';
  return settingsDialogHtml("Development settings", `<main class="settings-main settings-main-dev">${backLink}${await renderDevelopmentSettings()}</main>`);
}

async function deleteAllStoredSettings(): Promise<void> {
  clearWorkspaceGitHubToken();
  await clearGitIdentity();
  await setPickerAgentModels([]);
  const runtime = await createPiModelRuntime();
  for (const credential of await runtime.listCredentials()) await runtime.logout(credential.providerId);
}

export async function handleSettingsPageRequest(request: Request, url: URL, options: { forceDeleteAllWorkspaces?: () => Promise<WorkspaceCleanupResult> } = {}): Promise<Response | undefined> {
  if (url.pathname === "/settings" && request.method === "GET") {
    const html = await renderSettingsDialog();
    return wantsStream(request) ? stream(update("settings_modal_host", html)) : response(html);
  }
  if (url.pathname === "/settings/development" && request.method === "GET") {
    const html = await renderDevelopmentSettingsDialog();
    return wantsStream(request) ? stream(update("settings_modal_host", html)) : response(html);
  }
  if (url.pathname === "/settings/reset" && request.method === "POST") {
    await deleteAllStoredSettings();
    return stream(`${replace("settings_dialog", await renderDevelopmentSettingsDialog())}${update("onboarding_modal_host", await renderOnboardingDialog())}${remove("settings_flow_dialog")}`);
  }
  if (url.pathname === "/settings/workspaces/force-delete" && request.method === "POST" && devSettingsEnabled()) {
    const result = options.forceDeleteAllWorkspaces
      ? await options.forceDeleteAllWorkspaces()
      : { deleted: 0, errors: ["Workspace deletion is not available."] };
    return stream(replace("settings_force_delete_workspaces", renderForceDeleteWorkspaces(result)));
  }
  if (url.pathname === "/settings/git-identity" && request.method === "POST") {
    const form = await request.formData();
    try {
      await setGitIdentity({ name: String(form.get("name") ?? ""), email: String(form.get("email") ?? "") });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return stream(replace("settings_git_identity", await renderGitIdentityForm(message)));
    }
    return stream(`${replace("settings_dialog", await renderSettingsDialog())}${update("onboarding_modal_host", await renderOnboardingDialog())}`);
  }
  return undefined;
}
