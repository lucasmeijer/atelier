import { actionLinkHtml } from "@atelier/design-system/action-link";
import { dialogHtml } from "@atelier/design-system/dialog";
import { destructiveConfirmationHtml } from "@atelier/design-system/destructive-confirmation";
import { Icons } from "@atelier/design-system/icons";
import { createPiModelRuntime, setPickerAgentModels } from "@atelier/agent/server";
import { invalidArguments } from "@atelier/core";
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

function renderBuildIdentity(): string {
  const commit = process.env.ATELIER_COMMIT_ID;
  if (!commit) return `<span class="settings-build-identity">Local development build</span>`;
  const commitUrl = `https://github.com/lucasmeijer/atelier/commit/${encodeURIComponent(commit)}`;
  return `<a class="settings-build-identity" href="${commitUrl}" target="_blank" rel="noreferrer">${escapeHtml(commit.slice(0, 7))}</a>`;
}

export type WorkspaceCleanupResult = { deleted: number; errors: string[] };

function renderForceDeleteWorkspaces(result?: WorkspaceCleanupResult): string {
  const confirmation = destructiveConfirmationHtml({
    trigger: { type: "button", variant: "danger", content: { kind: "caption", caption: "Delete all workspaces" } },
    confirmCaption: "Delete all workspaces",
    cancelCaption: "Cancel",
  });
  const deleted = result === undefined ? "" : `<p class="settings-development-status" role="status">Deleted ${escapeHtml(result.deleted)} workspace${result.deleted === 1 ? "" : "s"}.</p>`;
  const errors = result?.errors.length ? `<p class="settings-error">${escapeHtml(result.errors.join("\n"))}</p>` : "";
  return `<div id="settings_force_delete_workspaces" class="settings-development-action">
    <div class="settings-development-copy">
      <div>Workspaces</div>
      <p>Permanently delete every workspace and its files.</p>
      ${deleted}${errors}
    </div>
    <div class="settings-development-control"><form method="post" action="/settings/workspaces/force-delete" data-turbo="true">${confirmation}</form></div>
  </div>`;
}

function renderResetSettings(): string {
  const confirmation = destructiveConfirmationHtml({
    trigger: { type: "button", variant: "danger", content: { kind: "caption", caption: "Delete all settings" } },
    confirmCaption: "Delete all settings",
    cancelCaption: "Cancel",
  });
  return `<div class="settings-development-action">
    <div class="settings-development-copy">
      <div>Stored settings</div>
      <p>Delete the Git identity, GitHub token, and model provider credentials stored by Atelier.</p>
    </div>
    <div class="settings-development-control"><form method="post" action="/settings/reset" data-turbo="true">${confirmation}</form></div>
  </div>`;
}

async function renderDevelopmentSettings(): Promise<string> {
  const keypressProbeSettings = await listSettingsContributions().find((contribution) => contribution.id === "keypress-probe")?.render() ?? "";
  const destructiveActions = `${renderResetSettings()}${devSettingsEnabled() ? renderForceDeleteWorkspaces() : ""}`;
  return `${keypressProbeSettings}<section class="settings-sec settings-sec-development">${destructiveActions}</section>`;
}

registerSettingsContribution({ id: "theme", label: "Theme", order: 10, render: renderThemeSettings });
registerSettingsContribution({ id: "git-identity", label: "Git identity", order: 20, render: renderGitIdentitySettings });
for (const module of workspaceModules) {
  for (const contribution of module.settingsContributions ?? []) registerSettingsContribution(contribution);
}

function settingsDialogHtml(titleCaption: string, bodyHtml: string, sectionId?: string): string {
  const sectionAttributes = sectionId ? ` data-controller="scroll-into-view" data-scroll-into-view-target-id-value="${escapeHtml(`settings-sec-${sectionId}`)}"` : "";
  return dialogHtml({
    element: {
      id: "settings_dialog",
      className: "dialog--sheet settings-dialog",
      attributesHtml: `aria-label="Settings" data-dialog-auto-show${sectionAttributes}`,
    },
    iconHtml: Icons.Settings,
    titleCaption,
    bodyHtml,
    bodyLayout: "full-bleed",
    closeLabel: "Close settings",
  });
}

export async function renderSettingsDialog(sectionId?: string): Promise<string> {
  const contributions = listSettingsContributions().filter((contribution) => contribution.id !== "keypress-probe");
  if (sectionId && !contributions.some((contribution) => contribution.id === sectionId)) throw invalidArguments(`settings section not found: ${sectionId}`);
  const sections = await Promise.all(contributions.map((contribution) => contribution.render()));
  return settingsDialogHtml("Settings", `<main class="settings-main">${sections.join("")}<div class="settings-dev-link"><a class="settings-development-link" href="/settings/development" data-turbo-frame="_top" data-turbo-stream="true">Development settings</a>${renderBuildIdentity()}</div></main>`, sectionId);
}

export async function renderDevelopmentSettingsDialog(): Promise<string> {
  const backLink = actionLinkHtml({
    href: "/settings",
    variant: "secondary",
    content: { kind: "caption", caption: "Back to settings" },
    attributesHtml: 'data-turbo-frame="_top" data-turbo-stream="true"',
  });
  return settingsDialogHtml("Development settings", `<main class="settings-main settings-main-dev">${await renderDevelopmentSettings()}<nav class="settings-development-back" aria-label="Settings navigation">${backLink}</nav></main>`);
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
