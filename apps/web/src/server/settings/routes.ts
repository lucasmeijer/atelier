import { copyButtonHtml } from "@atelier/design-system/copy-button";
import { destructiveConfirmationHtml } from "@atelier/design-system/destructive-confirmation";
import { dialogHtml } from "@atelier/design-system/dialog";
import { Icons } from "@atelier/design-system/icons";
import { clearWorkspaceGitHubToken, hasWorkspaceGitHubToken, setWorkspaceGitHubToken } from "@atelier/proxy-egress";
import {
  getConfiguredAgentModels,
  connectModelProviderApiKey,
  createPiModelRuntime,
  disconnectModelProvider,
  getProviderApiKeyExample,
  hasAvailableConfiguredAgentModel,
  loginPiOAuthProvider,
  setPickerAgentModels,
  type ConfiguredAgentModel,
  type PiAuthPrompt,
} from "@atelier/agent/server";
import { domId, escapeHtml, providerBrandColor, providerBrandIconHtml, turboStream, turboStreamResponse } from "@atelier/shared";
import { clearGitIdentity, getGitIdentity, getStoredGitIdentity, setGitIdentity } from "@atelier/projects";
import { listSettingsContributions, registerSettingsContribution } from "./registry.ts";
import { workspaceModules } from "../workspace-modules.ts";
import { validateGitHubToken } from "../github-auth.ts";
import { renderOnboardingDialogIfNeeded } from "../onboarding/routes.ts";

function response(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", headers.get("content-type") ?? "text/html; charset=utf-8");
  headers.set("cache-control", headers.get("cache-control") ?? "no-store");
  return new Response(body, { ...init, headers });
}

function stream(body: string): Response {
  return turboStreamResponse(body);
}

function replace(target: string, html: string): string {
  return turboStream("replace", target, html);
}

function update(target: string, html: string): string {
  return turboStream("update", target, html);
}

function updateTargets(selector: string, html: string): string {
  return turboStream("update", selector, html, { targets: true });
}

function replaceTargets(selector: string, html: string): string {
  return turboStream("replace", selector, html, { targets: true });
}

function remove(target: string): string {
  return turboStream("remove", target);
}

function append(target: string, html: string): string {
  return turboStream("append", target, html);
}

function wantsStream(request: Request): boolean {
  return request.headers.get("accept")?.includes("text/vnd.turbo-stream.html") ?? false;
}

function devSettingsEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}

export async function isOnboarded(): Promise<boolean> {
  return hasWorkspaceGitHubToken() && await hasAvailableConfiguredAgentModel();
}

function providerIcon(provider: string, label = provider, className = "settings-provider-icon"): string {
  return `<div class="${className}" style="--provider-color:${providerBrandColor(provider)}">${providerBrandIconHtml(provider, label)}</div>`;
}

function managedList(items: string, filter?: { label: string; placeholder: string; emptyMessage: string; autofocus?: boolean }): string {
  if (!filter) return `<div class="managed-list">${items}</div>`;
  return `<div class="managed-list"><div class="managed-list__filter"><input class="text-field" type="search" placeholder="${escapeHtml(filter.placeholder)}" aria-label="${escapeHtml(filter.label)}" autocomplete="off"${filter.autofocus ? " autofocus" : ""}></div><div class="managed-list__items">${items}</div><div class="managed-list__empty"${items ? " hidden" : ""}>${escapeHtml(filter.emptyMessage)}</div></div>`;
}

function dialogHeader(title: string, visual = ""): string {
  return `<header class="dialog__header">${visual}<h2 class="title">${escapeHtml(title)}</h2></header>`;
}

const githubDisconnectConfirmation = destructiveConfirmationHtml({
  buttonHtml: '<button class="button danger" type="button">Disconnect</button>',
  confirmCaption: "Disconnect GitHub",
  cancelCaption: "Cancel",
});

const providerDisconnectConfirmation = destructiveConfirmationHtml({
  buttonHtml: '<button class="button danger" type="button">Disconnect</button>',
  confirmCaption: "Disconnect",
  cancelCaption: "Cancel",
});

const modelRemovalConfirmation = destructiveConfirmationHtml({
  buttonHtml: `<button class="button danger icon-only" type="button" title="Remove configured model" aria-label="Remove configured model">${Icons.Trash}</button>`,
  confirmCaption: "Remove model",
  cancelCaption: "Cancel",
});

function githubRow(surface: "settings" | "onboarding" = "settings"): string {
  const connected = hasWorkspaceGitHubToken();
  const flowAction = surface === "onboarding" ? "/settings/github/flow?surface=onboarding" : "/settings/github/flow";
  const disconnectAction = surface === "onboarding" ? "/settings/github/disconnect?surface=onboarding" : "/settings/github/disconnect";
  return `<div class="managed-list"><div class="managed-list__item" id="${domId(surface, "provider", "github")}">
    ${providerIcon("github", "GitHub", "settings-provider-icon managed-list__visual")}
    <div class="managed-list__content"><div class="managed-list__label"><span class="managed-list__label-text">GitHub</span></div><div class="managed-list__description">Atelier securely injects your token into workspace GitHub requests without exposing it to the coding agent.</div></div>
    ${connected ? "" : '<span class="managed-list__meta">Not connected</span>'}
    <div class="managed-list__actions">${connected
      ? `<form method="post" action="${disconnectAction}" data-turbo="true">${githubDisconnectConfirmation}</form>`
      : `<form method="post" action="${flowAction}" data-turbo="true"><button class="button primary" type="submit">Connect</button></form>`}</div>
  </div></div>`;
}

type ProviderSummary = { provider: string; label: string; connected: boolean; stored: boolean; methods: string[] };

async function providerSummaries(): Promise<ProviderSummary[]> {
  const runtime = await createPiModelRuntime();
  return runtime.getProviders().map((provider): ProviderSummary => {
    const status = runtime.getProviderAuthStatus(provider.id);
    return {
      provider: provider.id,
      label: provider.name ?? provider.id,
      connected: status.configured,
      stored: status.source === "stored",
      methods: [provider.auth.oauth && "oauth", provider.auth.apiKey?.login && "api_key"].filter((method): method is string => Boolean(method)),
    };
  }).sort((a, b) => Number(b.connected) - Number(a.connected) || a.label.localeCompare(b.label));
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

async function renderGitHubSettings(): Promise<string> {
  return `<section class="settings-sec settings-sec-github" id="settings-sec-github">${githubRow()}</section>`;
}

async function renderModelSetupSettings(): Promise<string> {
  return `<section class="settings-sec settings-sec-models" id="settings-sec-models">${await renderModelSetup("settings")}</section>`;
}

async function renderDevelopmentSettings(): Promise<string> {
  const forceDeleteWorkspaces = devSettingsEnabled() ? `<form class="settings-reset-form" method="post" action="/settings/workspaces/force-delete/flow" data-turbo="true"><button class="settings-reset-link danger" type="submit">force delete all workspaces</button></form>` : "";
  const keypressProbeSettings = await listSettingsContributions().find((contribution) => contribution.id === "keypress-probe")?.render() ?? "";
  const resetSettings = `<form class="settings-reset-form" method="post" action="/settings/reset" data-turbo="true"><button class="settings-reset-link" type="submit" onclick="return confirm('Delete stored git identity, GitHub token, and all stored model provider credentials?')">delete all settings</button></form>`;
  return `${keypressProbeSettings}<div class="settings-dev-actions">${resetSettings}${forceDeleteWorkspaces}</div>`;
}

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}::${model.id}`;
}

function modelManagedListContent(model: ConfiguredAgentModel, description: string): string {
  return `${providerIcon(model.provider, model.provider, "settings-model-provider-icon managed-list__visual")}
    <div class="managed-list__content"><div class="managed-list__label"><span class="managed-list__label-text">${escapeHtml(model.label)}</span></div><div class="managed-list__description">${escapeHtml(description)}</div></div>`;
}

type ModelSetupSurface = "settings" | "onboarding" | "dialog";
const modelSetupSurfaces: readonly ModelSetupSurface[] = ["settings", "onboarding", "dialog"];

type ModelCatalogueEntry = ConfiguredAgentModel & { configured: boolean };

type ModelSetupData = {
  configured: ConfiguredAgentModel[];
  models: ModelCatalogueEntry[];
  providers: Map<string, ProviderSummary>;
  working: boolean;
};

async function modelSetupData(): Promise<ModelSetupData> {
  const runtime = await createPiModelRuntime();
  const configured = await getConfiguredAgentModels();
  const configuredByKey = new Map(configured.map((model) => [modelKey(model), model]));
  const providers = new Map((await providerSummaries()).map((provider) => [provider.provider, provider]));
  const models: ModelCatalogueEntry[] = [];
  const seen = new Set<string>();

  for (const provider of providers.values()) {
    for (const model of runtime.getModels(provider.provider)) {
      const existing = configuredByKey.get(modelKey(model));
      models.push({ provider: model.provider, id: model.id, label: existing?.label ?? model.name ?? model.id, configured: Boolean(existing) });
      seen.add(modelKey(model));
    }
  }

  for (const model of configured) {
    if (!seen.has(modelKey(model))) models.push({ ...model, configured: true });
  }

  models.sort((a, b) => {
    const aConnected = providers.get(a.provider)?.connected ?? false;
    const bConnected = providers.get(b.provider)?.connected ?? false;
    return Number(bConnected) - Number(aConnected) || a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label);
  });
  const available = new Set((await runtime.getAvailable()).map(modelKey));
  return { configured, models, providers, working: configured.some((model) => available.has(modelKey(model))) };
}

function providerState(provider: ProviderSummary): string {
  return `<span class="model-provider-state ${domId("model_provider_state", provider.provider)}" data-connected="${provider.connected}" data-disconnectable="${provider.stored}" hidden></span>`;
}

function providerAuthLabel(method: string): string {
  return method === "oauth" ? "Sign in" : "Add API key";
}

function providerAuthFormId(provider: ProviderSummary, method: string, surface: ModelSetupSurface): string {
  return domId("model_catalogue_auth", surface, provider.provider, method);
}

function providerAuthAction(provider: ProviderSummary, method: string, surface: ModelSetupSurface): string {
  return `/settings/providers/${encodeURIComponent(provider.provider)}/flow?method=${encodeURIComponent(method)}${surface === "onboarding" ? "&surface=onboarding" : ""}`;
}

function providerAuthenticationActions(provider: ProviderSummary, surface: ModelSetupSurface): string {
  if (!provider.methods.length) return `<span class="settings-provider-desc">Provider unavailable</span>`;
  return provider.methods.map((method) => `<form method="post" action="${providerAuthAction(provider, method, surface)}" data-turbo="true"><button class="button secondary" type="submit">${providerAuthLabel(method)}</button></form>`).join("");
}

function catalogueProviderForms(provider: ProviderSummary, surface: ModelSetupSurface): string {
  const authentication = provider.methods.map((method) => `<form id="${providerAuthFormId(provider, method, surface)}" method="post" action="${providerAuthAction(provider, method, surface)}" data-turbo="true" hidden></form>`).join("");
  return `<form id="${domId("model_catalogue_add", surface, provider.provider)}" method="post" action="/settings/models/add" data-turbo="true" hidden></form>${authentication}`;
}

function catalogueAuthenticationButtons(provider: ProviderSummary, surface: ModelSetupSurface): string {
  if (!provider.methods.length) return `<span class="settings-provider-desc">Provider unavailable</span>`;
  return provider.methods.map((method) => `<button class="button secondary" type="submit" form="${providerAuthFormId(provider, method, surface)}">${providerAuthLabel(method)}</button>`).join("");
}

function configuredModelRow(model: ConfiguredAgentModel, provider: ProviderSummary, surface: ModelSetupSurface): string {
  return `<div class="managed-list__item configured-model-row" data-search-text="${escapeHtml(`${model.label} ${model.provider} ${model.id}`.toLowerCase())}">
    ${modelManagedListContent(model, `${model.provider} · ${model.id}`)}
    <div class="managed-list__actions model-provider-actions">
      ${providerState(provider)}
      <span class="model-provider-disconnected-actions">${providerAuthenticationActions(provider, surface)}</span>
      <span class="model-provider-connected-actions"><form method="post" action="/settings/providers/${encodeURIComponent(provider.provider)}/disconnect" data-turbo="true">${providerDisconnectConfirmation}</form></span>
      <form method="post" action="/settings/models/remove" data-turbo="true"><input type="hidden" name="model" value="${escapeHtml(modelKey(model))}">${modelRemovalConfirmation}</form>
    </div>
  </div>`;
}

function renderConfiguredModelsSection(data: ModelSetupData, surface: ModelSetupSurface): string {
  if (!data.configured.length) return "";
  const models = managedList(data.configured.map((model) => configuredModelRow(model, data.providers.get(model.provider) ?? { provider: model.provider, label: model.provider, connected: false, stored: false, methods: [] }, surface)).join(""));
  return `<section class="model-setup-section form-section"><h2>Configured models</h2>${models}</section>`;
}

function catalogueModelAction(model: ModelCatalogueEntry, provider: ProviderSummary, surface: ModelSetupSurface): string {
  const actionClass = domId("model_catalogue_action", surface, model.provider, model.id);
  return `<div class="managed-list__actions model-catalogue-action ${actionClass}">
    ${model.configured
      ? `<span class="settings-provider-desc">Already added</span>`
      : `<span class="model-provider-disconnected-actions">${catalogueAuthenticationButtons(provider, surface)}</span><span class="model-provider-connected-actions"><button class="button primary" type="submit" form="${domId("model_catalogue_add", surface, provider.provider)}" name="model" value="${escapeHtml(modelKey(model))}">Add</button></span>`}
  </div>`;
}

function catalogueModelRow(model: ModelCatalogueEntry, provider: ProviderSummary, surface: ModelSetupSurface): string {
  return `<div class="managed-list__item" data-search-text="${escapeHtml(`${model.label} ${model.provider} ${model.id}`.toLowerCase())}">
    ${modelManagedListContent(model, `${model.provider} · ${model.id}`)}
    ${catalogueModelAction(model, provider, surface)}
  </div>`;
}

const modelCatalogueLimit = 50;

function modelCatalogueFrameId(surface: ModelSetupSurface): string {
  return domId("model_catalogue_results", surface);
}

function renderModelCatalogueResults(data: ModelSetupData, surface: ModelSetupSurface, query: string): string {
  const normalizedQuery = query.trim().toLowerCase();
  const matchingModels = normalizedQuery
    ? data.models.filter((model) => `${model.label} ${model.provider} ${model.id} ${data.providers.get(model.provider)?.label ?? ""}`.toLowerCase().includes(normalizedQuery))
    : data.models;
  const visibleModels = matchingModels.slice(0, modelCatalogueLimit);
  const groups = [...data.providers.values()].map((provider) => {
    const models = visibleModels.filter((model) => model.provider === provider.provider);
    if (!models.length) return "";
    return `<div class="model-provider-group" data-provider-label="${escapeHtml(provider.label.toLowerCase())}">${providerState(provider)}${catalogueProviderForms(provider, surface)}${models.map((model) => catalogueModelRow(model, provider, surface)).join("")}</div>`;
  }).join("");
  const remaining = matchingModels.length - visibleModels.length;
  const more = remaining > 0 ? `<div class="managed-list__item model-catalogue-more" role="status" aria-disabled="true">Many results, use the filter box</div>` : "";
  const empty = matchingModels.length ? "" : `<div class="managed-list__empty">No matching models.</div>`;
  return `<turbo-frame id="${modelCatalogueFrameId(surface)}" class="model-catalogue-results"><div class="model-catalogue-loading" role="status"><span class="status-spinner" aria-hidden="true"></span>Filtering models…</div><div class="managed-list__items">${groups}${more}</div>${empty}</turbo-frame>`;
}

function renderModelCatalogue(data: ModelSetupData, surface: ModelSetupSurface): string {
  const frameId = modelCatalogueFrameId(surface);
  return `<div class="managed-list" data-managed-list-server-filter="true">
    <form class="managed-list__filter" method="get" action="/settings/models/catalogue" data-controller="server-filter" data-action="input->server-filter#submit" data-turbo-frame="${frameId}">
      <input type="hidden" name="surface" value="${surface}">
      <input class="text-field" type="search" name="q" placeholder="Filter models and providers…" aria-label="Filter available models" autocomplete="off">
    </form>
    ${renderModelCatalogueResults(data, surface, "")}
  </div>`;
}

function renderModelSetupData(data: ModelSetupData, surface: ModelSetupSurface): string {
  const working = data.working;
  const head = surface === "onboarding" ? `<div class="model-setup-head"><h2>Configure models</h2><p>Connect providers and choose the models shown in model menus.</p></div>` : "";
  const id = surface === "dialog" ? "model_setup_dialog_content" : `model_setup_${surface}`;
  return `<div class="model-setup form-stack" id="${id}">
    ${head}${modelSetupWorkingState(working)}
    <div class="configured-model-section configured-model-section-${surface}">${renderConfiguredModelsSection(data, surface)}</div>
    <section class="model-setup-section form-section"><h2>Available models</h2><div class="model-catalogue" data-controller="model-catalogue">${renderModelCatalogue(data, surface)}</div></section>
  </div>`;
}

export async function renderModelSetup(surface: ModelSetupSurface = "settings"): Promise<string> {
  return renderModelSetupData(await modelSetupData(), surface);
}

export async function renderModelSetupDialog(): Promise<string> {
  const data = await modelSetupData();
  return `<dialog id="model_setup_dialog" class="dialog model-setup-dialog" data-dialog-auto-show>
    ${dialogHeader("Configure models")}
    <div class="dialog__body">${renderModelSetupData(data, "dialog")}</div>
    <div class="dialog__actions"><form method="dialog">${modelSetupDialogButton(data.working)}</form></div>
  </dialog>`;
}

registerSettingsContribution({ id: "theme", label: "Theme", order: 10, render: renderThemeSettings });
registerSettingsContribution({ id: "git-identity", label: "Git identity", order: 20, render: renderGitIdentitySettings });
registerSettingsContribution({ id: "github", label: "GitHub", order: 30, render: renderGitHubSettings });
registerSettingsContribution({ id: "models", label: "Models", order: 40, render: renderModelSetupSettings });
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
    closeLabel: "Close settings",
  });
}

export async function renderSettingsDialog(_active = "theme"): Promise<string> {
  const contributions = listSettingsContributions().filter((contribution) => contribution.id !== "keypress-probe");
  const sections = await Promise.all(contributions.map((contribution) => contribution.render()));
  return settingsDialogHtml("Settings", `<main class="settings-main">${sections.join("")}<div class="settings-dev-link"><a href="/settings/development" data-turbo-frame="_top" data-turbo-stream="true">Development settings</a></div></main>`);
}

export async function renderDevelopmentSettingsDialog(): Promise<string> {
  const backLink = '<div class="settings-development-back"><a class="settings-back-link" href="/settings" data-turbo-frame="_top" data-turbo-stream="true">Settings</a></div>';
  return settingsDialogHtml("Development settings", `<main class="settings-main settings-main-dev">${backLink}${await renderDevelopmentSettings()}</main>`);
}

function forceDeleteAllWorkspacesModal(error = ""): string {
  return `<dialog id="settings_dev_force_delete_workspaces_dialog" class="dialog" data-dialog-auto-show>
    <form method="post" action="/settings/workspaces/force-delete" data-turbo="true">
      ${dialogHeader("Force delete all workspaces?", `<div class="settings-provider-icon" style="--provider-color:${providerBrandColor("github")}">!</div>`)}
      <div class="dialog__body"><p>This force-removes every Atelier workspace container in this namespace and deletes its local workspace data. Uncommitted work will be lost.</p>${error ? `<p class="settings-error">${escapeHtml(error)}</p>` : ""}</div>
      <div class="dialog__actions"><button class="button secondary" formmethod="dialog">Cancel</button><button class="button danger" type="submit">Force delete all workspaces</button></div>
    </form>
  </dialog>`;
}

function forceDeleteAllWorkspacesResultModal(deleted: number, errors: string[]): string {
  return `<dialog id="settings_dev_force_delete_workspaces_dialog" class="dialog" data-dialog-auto-show>
    ${dialogHeader("Workspace cleanup complete", `<div class="settings-provider-icon" style="--provider-color:${errors.length ? "var(--danger)" : "var(--success)"}">${errors.length ? "!" : "✓"}</div>`)}
    <div class="dialog__body"><p>Deleted ${escapeHtml(deleted)} workspace${deleted === 1 ? "" : "s"}.</p>${errors.length ? `<p class="settings-error">${escapeHtml(errors.join("\n"))}</p>` : ""}</div>
    <div class="dialog__actions"><form method="dialog"><button class="button primary">Done</button></form></div>
  </dialog>`;
}

function githubTokenModal(error = "", surface: "settings" | "onboarding" = "settings"): string {
  const action = surface === "onboarding" ? "/settings/github/connect?surface=onboarding" : "/settings/github/connect";
  return `<dialog id="settings_flow_dialog" class="dialog" data-dialog-auto-show>
    <form method="post" action="${action}" data-turbo="true">
      ${dialogHeader("GitHub", providerIcon("github", "GitHub"))}
      <div class="dialog__body">
        <p>On your machine, sign in with GitHub CLI if needed, then print your token:</p>
        <pre class="settings-command">gh auth login
gh auth token</pre>
        <p>Paste the token output below. Atelier stores it locally and injects it into workspace GitHub requests as <code>GH_TOKEN</code>.</p>
        ${error ? `<p class="settings-error">${escapeHtml(error)}</p>` : ""}
        <input class="settings-input text-field settings-token-input" type="password" name="token" placeholder="Paste output from gh auth token" autocomplete="off" required autofocus>
      </div>
      <div class="dialog__actions"><button class="button secondary" formmethod="dialog">Cancel</button><button class="button primary" type="submit">Connect</button></div>
    </form>
  </dialog>`;
}

function apiKeyModal(id: string, label: string, action: string, error = ""): string {
  const inputId = domId("provider_api_key", id);
  const formId = domId("provider_api_key_form", id);
  return `<dialog id="settings_flow_dialog" class="dialog" data-dialog-auto-show>
    ${dialogHeader(`Connect ${label}`, providerIcon(id, label))}
    <form id="${formId}" method="post" action="${escapeHtml(action)}" data-turbo="true"><div class="dialog__body"><div class="settings-oauth-card">
      ${error ? `<p class="settings-error">${escapeHtml(error)}</p>` : ""}
      <label for="${inputId}">API key</label>
      <input id="${inputId}" class="settings-input text-field" type="password" name="secret" placeholder="${escapeHtml(getProviderApiKeyExample(id) ?? "API key")}" autocomplete="off" required autofocus>
    </div></div></form>
    <div class="dialog__actions"><form method="dialog"><button class="button secondary">Cancel</button></form><button class="button primary" type="submit" form="${formId}">Connect</button></div>
  </dialog>`;
}

type PendingPrompt = { message: string; placeholder?: string; resolve: (value: string) => void; reject: (error: Error) => void };
type PendingOAuthFlow = {
  id: string;
  provider: string;
  label: string;
  status: "pending" | "complete" | "error";
  startedAt: number;
  abort: AbortController;
  authUrl?: string;
  instructions?: string;
  userCode?: string;
  verificationUri?: string;
  intervalSeconds?: number;
  prompt?: PendingPrompt;
  redirectSubmitted?: boolean;
  error?: string;
};

const pendingOAuthFlows = new Map<string, PendingOAuthFlow>();

async function startOAuthFlow(provider: string, label: string): Promise<PendingOAuthFlow> {
  if (!(await createPiModelRuntime()).getProvider(provider)?.auth.oauth) throw new Error(`${label} does not support OAuth in this pi installation.`);
  const flow: PendingOAuthFlow = { id: crypto.randomUUID(), provider, label, status: "pending", startedAt: Date.now(), abort: new AbortController() };
  pendingOAuthFlows.set(flow.id, flow);
  void loginPiOAuthProvider(provider, {
    signal: flow.abort.signal,
    notify: (event) => {
      if (event.type === "auth_url") { flow.authUrl = event.url; flow.instructions = event.instructions; }
      else if (event.type === "device_code") { flow.userCode = event.userCode; flow.verificationUri = event.verificationUri; flow.intervalSeconds = event.intervalSeconds; }
      else if (event.type === "progress") { /* progress is reflected by polling status rows */ }
    },
    prompt: (prompt) => handleOAuthPrompt(flow, prompt),
  }).then(() => {
    flow.status = "complete";
    flow.prompt = undefined;
  }).catch((error) => {
    if (flow.abort.signal.aborted) return;
    flow.status = "error";
    flow.prompt = undefined;
    flow.error = error instanceof Error ? error.message : String(error);
  });
  await waitForOAuthFlowReady(flow);
  return flow;
}

function handleOAuthPrompt(flow: PendingOAuthFlow, prompt: PiAuthPrompt): Promise<string> {
  if (prompt.type === "select") {
    const selected = prompt.options.find((option) => /device|headless/i.test(`${option.id} ${option.label ?? ""}`))?.id
      ?? prompt.options.find((option) => /default/i.test(option.label ?? ""))?.id
      ?? prompt.options[0]?.id;
    if (!selected) return Promise.reject(new Error("No OAuth login option available"));
    return Promise.resolve(selected);
  }

  return new Promise<string>((resolve, reject) => {
    const abort = () => {
      if (flow.prompt?.reject === reject) flow.prompt = undefined;
      reject(new Error("OAuth prompt cancelled"));
    };
    if (prompt.signal?.aborted || flow.abort.signal.aborted) return abort();
    prompt.signal?.addEventListener("abort", abort, { once: true });
    flow.abort.signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => {
      prompt.signal?.removeEventListener("abort", abort);
      flow.abort.signal.removeEventListener("abort", abort);
    };
    const finish = (value: string) => {
      cleanup();
      resolve(value);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    flow.prompt = { message: prompt.message, placeholder: prompt.placeholder, resolve: finish, reject: fail };
  });
}

async function waitForOAuthFlowReady(flow: PendingOAuthFlow): Promise<void> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline && flow.status === "pending" && !flow.authUrl && !flow.verificationUri && !flow.prompt) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function oauthStatus(kind: "pending" | "done", title: string, detail: string): string {
  return `<ul class="status-list"><li class="status-list__item" ${kind === "done" ? 'role="checkbox" aria-checked="true"' : 'aria-busy="true"'}><span class="status-list__marker">${kind === "done" ? "✓" : ""}</span><span><strong>${escapeHtml(title)}</strong> — ${escapeHtml(detail)}</span></li></ul>`;
}

function oauthAuthenticationAction(flow: PendingOAuthFlow, url: string, description: string, hidden = false): string {
  return `<div class="managed-list"${hidden ? " data-oauth-device-auth hidden" : ""}><div class="managed-list__item"><div class="managed-list__content"><div class="managed-list__description">${escapeHtml(description)}</div></div><div class="managed-list__actions"><a class="button primary" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Authenticate at ${escapeHtml(flow.label)}</a></div></div></div>`;
}

function oauthDeviceCodeBody(flow: PendingOAuthFlow): string {
  const code = escapeHtml(flow.userCode ?? "");
  const copyButton = copyButtonHtml({
    label: "Copy code",
    caption: "Copy code",
    attributesHtml: 'data-oauth-copy-button="true" data-action="oauth-flow#showDeviceAuth"',
  });
  return `<div class="settings-oauth-card">
    <div class="settings-oauth-code-label">Copy this code into your clipboard</div>
    <div class="settings-oauth-code copy-region"><code data-copy-source>${code}</code>${copyButton}</div>
    ${oauthAuthenticationAction(flow, flow.verificationUri ?? "#", "The next page will ask for your copied code.", true)}
    ${oauthStatus("pending", `Waiting for ${flow.label} approval`, "Checking whether the code has been accepted.")}
  </div>`;
}

function oauthRedirectFormId(flow: PendingOAuthFlow): string {
  return domId("oauth_redirect_form", flow.id);
}

function oauthBrowserRedirectBody(flow: PendingOAuthFlow): string {
  const prompt = flow.prompt;
  const inputId = domId("oauth_redirect", flow.id);
  const promptForm = prompt ? `<form id="${oauthRedirectFormId(flow)}" class="settings-oauth-card" method="post" action="/settings/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/prompt" data-turbo="true"><label for="${inputId}">Redirect URL</label><input id="${inputId}" class="settings-input text-field" name="value" placeholder="http://localhost:1455/callback?code=abc123...&state=..." required></form>` : "";
  return `<div class="settings-oauth-card">
    <div class="settings-oauth-callout"><b>Before you start</b>${escapeHtml(flow.label)} assumes you will sign in on your local machine, but that’s not how Atelier works.<br><br>${escapeHtml(flow.label)} will redirect you to a localhost URL after you sign in. That URL will fail to load. You need to copy the long URL from the address bar, and paste it here.</div>
    ${oauthAuthenticationAction(flow, flow.authUrl ?? "#", "Sign in, approve access, then copy the final localhost URL.")}
    ${promptForm}
    ${!prompt && flow.redirectSubmitted ? oauthStatus("pending", `Waiting for ${flow.label}`, "Confirming the pasted redirect URL.") : ""}
  </div>`;
}

function oauthCompleteBody(flow: PendingOAuthFlow): string {
  return `<div class="settings-oauth-card">${oauthStatus("done", `${flow.label} connected`, "You can now add models from this provider.")}</div>`;
}

function oauthFlowModal(flow: PendingOAuthFlow): string {
  const pollMs = Math.max(1500, Math.min(15000, (flow.intervalSeconds ?? 3) * 1000));
  const body = flow.status === "complete"
    ? oauthCompleteBody(flow)
    : flow.status === "error"
      ? `<p class="settings-error">${escapeHtml(flow.error ?? "OAuth login failed")}</p>`
      : flow.verificationUri
        ? oauthDeviceCodeBody(flow)
        : flow.authUrl
          ? oauthBrowserRedirectBody(flow)
          : `<div class="settings-oauth-card">${oauthStatus("pending", "Starting OAuth flow", "Waiting for the provider to respond.")}</div>`;
  return `<dialog id="settings_flow_dialog" class="dialog" data-controller="oauth-flow" data-dialog-auto-show data-oauth-flow-status-url-value="/settings/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/status" data-oauth-flow-active-value="${flow.status === "pending" ? "true" : "false"}" data-oauth-flow-poll-ms-value="${pollMs}">
    ${dialogHeader(`Sign in with ${flow.label}`, providerIcon(flow.provider, flow.label))}
    <div class="dialog__body">${body}</div>
    <div class="dialog__actions">
      ${flow.status === "complete" ? `<form method="post" action="/settings/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/finish" data-turbo="true"><button class="button primary" type="submit">Done</button></form>` : ""}
      ${flow.status === "pending" ? `<form method="post" action="/settings/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/cancel" data-turbo="true"><button class="button secondary" type="submit">Cancel</button></form>` : ""}
      ${flow.status === "pending" && flow.authUrl && flow.prompt ? `<button class="button primary" type="submit" form="${oauthRedirectFormId(flow)}">Submit URL</button>` : ""}
      ${flow.status === "error" ? `<form method="post" action="/settings/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/finish" data-turbo="true"><button class="button secondary" type="submit">Close</button></form>` : ""}
    </div>
  </dialog>`;
}

function modelSetupWorkingState(working: boolean): string {
  return `<span class="model-setup-working-state" data-working="${working}" hidden></span>`;
}

function modelSetupDialogButton(working: boolean): string {
  return `<button class="button model-setup-ok-button ${working ? "secondary" : "warning"}">${working ? "OK" : "No model configured yet"}</button>`;
}

async function refreshProviderState(providerId: string): Promise<string> {
  const provider = (await providerSummaries()).find((candidate) => candidate.provider === providerId);
  if (!provider) return "";
  return replaceTargets(`.${domId("model_provider_state", providerId)}`, providerState(provider));
}

async function refreshConfiguredModelState(model: { provider: string; id: string }): Promise<string> {
  const data = await modelSetupData();
  const working = data.working;
  const view = data.models.find((candidate) => modelKey(candidate) === modelKey(model));
  const provider = data.providers.get(model.provider);
  const configuredSections = modelSetupSurfaces.map((surface) => updateTargets(`.configured-model-section-${surface}`, renderConfiguredModelsSection(data, surface))).join("");
  const catalogueActions = view && provider
    ? modelSetupSurfaces.map((surface) => replaceTargets(`.${domId("model_catalogue_action", surface, model.provider, model.id)}`, catalogueModelAction(view, provider, surface))).join("")
    : "";
  return `${configuredSections}${catalogueActions}${replaceTargets(".model-setup-working-state", modelSetupWorkingState(working))}${replaceTargets(".model-setup-ok-button", modelSetupDialogButton(working))}`;
}

async function deleteAllStoredSettings(): Promise<void> {
  clearWorkspaceGitHubToken();
  await clearGitIdentity();
  await setPickerAgentModels([]);
  const runtime = await createPiModelRuntime();
  for (const credential of await runtime.listCredentials()) await runtime.logout(credential.providerId);
}

export async function handleSettingsRequest(request: Request, url: URL, options: { forceDeleteAllWorkspaces?: () => Promise<{ deleted: number; errors: string[] }> } = {}): Promise<Response | undefined> {
  if (url.pathname === "/settings" && request.method === "GET") {
    const html = await renderSettingsDialog(url.searchParams.get("section") ?? "theme");
    return wantsStream(request) ? stream(update("settings_modal_host", html)) : response(html);
  }
  if (url.pathname === "/settings/models/catalogue" && request.method === "GET") {
    const requestedSurface = url.searchParams.get("surface") ?? "settings";
    const surface = modelSetupSurfaces.find((candidate) => candidate === requestedSurface);
    if (!surface) return response("Unknown model catalogue surface", { status: 400 });
    return response(renderModelCatalogueResults(await modelSetupData(), surface, url.searchParams.get("q") ?? ""));
  }
  if (url.pathname === "/settings/models/dialog" && request.method === "GET") {
    return wantsStream(request) ? stream(update("settings_modal_host", await renderModelSetupDialog())) : response(await renderModelSetupDialog());
  }
  if (url.pathname === "/settings/development" && request.method === "GET") {
    const html = await renderDevelopmentSettingsDialog();
    return wantsStream(request) ? stream(update("settings_modal_host", html)) : response(html);
  }
  if (url.pathname === "/settings/reset" && request.method === "POST") {
    await deleteAllStoredSettings();
    return stream(`${replace("settings_dialog", await renderDevelopmentSettingsDialog())}${update("onboarding_modal_host", await renderOnboardingDialogIfNeeded())}${remove("settings_flow_dialog")}`);
  }
  if (url.pathname === "/settings/workspaces/force-delete/flow" && request.method === "POST" && devSettingsEnabled()) {
    return stream(append("settings_modal_host", forceDeleteAllWorkspacesModal()));
  }
  if (url.pathname === "/settings/workspaces/force-delete" && request.method === "POST" && devSettingsEnabled()) {
    if (!options.forceDeleteAllWorkspaces) return stream(replace("settings_dev_force_delete_workspaces_dialog", forceDeleteAllWorkspacesModal("Workspace deletion is not available.")));
    const result = await options.forceDeleteAllWorkspaces();
    return stream(replace("settings_dev_force_delete_workspaces_dialog", forceDeleteAllWorkspacesResultModal(result.deleted, result.errors)));
  }
  if (url.pathname === "/settings/git-identity" && request.method === "POST") {
    const form = await request.formData();
    try {
      await setGitIdentity({ name: String(form.get("name") ?? ""), email: String(form.get("email") ?? "") });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return stream(replace("settings_git_identity", await renderGitIdentityForm(message)));
    }
    return stream(`${replace("settings_dialog", await renderSettingsDialog("git-identity"))}${update("onboarding_modal_host", await renderOnboardingDialogIfNeeded())}`);
  }
  if (url.pathname === "/settings/github/flow" && request.method === "POST") {
    const surface = url.searchParams.get("surface") === "onboarding" ? "onboarding" : "settings";
    return surface === "onboarding"
      ? stream(append("onboarding_modal_host", githubTokenModal("", "onboarding")))
      : stream(update("settings_modal_host", `${await renderSettingsDialog("github")}${githubTokenModal()}`));
  }
  if (url.pathname === "/settings/github/connect" && request.method === "POST") {
    const surface = url.searchParams.get("surface") === "onboarding" ? "onboarding" : "settings";
    const form = await request.formData();
    const token = String(form.get("token") ?? "").trim();
    const validation = await validateGitHubToken(token);
    if (!validation.ok) return stream(replace("settings_flow_dialog", githubTokenModal(validation.message, surface)));
    setWorkspaceGitHubToken(token);
    if (!await getStoredGitIdentity()) await setGitIdentity({ name: validation.name, email: validation.email });
    return surface === "onboarding"
      ? stream(`${remove("settings_flow_dialog")}${update("onboarding_modal_host", await renderOnboardingDialogIfNeeded())}`)
      : stream(`${replace("settings_dialog", await renderSettingsDialog("github"))}${update("onboarding_modal_host", await renderOnboardingDialogIfNeeded())}${remove("settings_flow_dialog")}`);
  }
  if (url.pathname === "/settings/github/disconnect" && request.method === "POST") {
    const surface = url.searchParams.get("surface") === "onboarding" ? "onboarding" : "settings";
    clearWorkspaceGitHubToken();
    return surface === "onboarding"
      ? stream(update("onboarding_modal_host", await renderOnboardingDialogIfNeeded()))
      : stream(`${replace("settings_dialog", await renderSettingsDialog("github"))}${update("onboarding_modal_host", await renderOnboardingDialogIfNeeded())}`);
  }
  let match = url.pathname.match(/^\/settings\/providers\/([^/]+)\/flow$/);
  if (match && request.method === "POST") {
    const provider = decodeURIComponent(match[1]!);
    const method = url.searchParams.get("method") ?? "api_key";
    const surface = url.searchParams.get("surface") === "onboarding" ? "onboarding" : "settings";
    const runtime = await createPiModelRuntime();
    const label = runtime.getProvider(provider)?.name ?? provider;
    if (method === "oauth") {
      try {
        const flow = await startOAuthFlow(provider, label);
        return stream(append(surface === "onboarding" ? "onboarding_modal_host" : "settings_modal_host", oauthFlowModal(flow)));
      } catch (error) {
        return stream(append(surface === "onboarding" ? "onboarding_modal_host" : "settings_modal_host", apiKeyModal(provider, label, `/settings/providers/${encodeURIComponent(provider)}/connect${surface === "onboarding" ? "?surface=onboarding" : ""}`, error instanceof Error ? error.message : String(error))));
      }
    }
    return stream(append(surface === "onboarding" ? "onboarding_modal_host" : "settings_modal_host", apiKeyModal(provider, label, `/settings/providers/${encodeURIComponent(provider)}/connect${surface === "onboarding" ? "?surface=onboarding" : ""}`)));
  }
  match = url.pathname.match(/^\/settings\/providers\/([^/]+)\/connect$/);
  if (match && request.method === "POST") {
    const provider = decodeURIComponent(match[1]!);
    const surface = url.searchParams.get("surface") === "onboarding" ? "onboarding" : "settings";
    const runtime = await createPiModelRuntime();
    const label = runtime.getProvider(provider)?.name ?? provider;
    const form = await request.formData();
    const secret = String(form.get("secret") ?? "");
    try {
      await connectModelProviderApiKey(provider, secret);
    } catch (error) {
      return stream(replace("settings_flow_dialog", apiKeyModal(provider, label, `/settings/providers/${encodeURIComponent(provider)}/connect${surface === "onboarding" ? "?surface=onboarding" : ""}`, error instanceof Error ? error.message : String(error))));
    }
    return stream(`${await refreshProviderState(provider)}${remove("settings_flow_dialog")}`);
  }
  match = url.pathname.match(/^\/settings\/providers\/([^/]+)\/oauth\/([^/]+)\/(status|prompt|finish|cancel)$/);
  if (match && request.method === "POST") {
    const provider = decodeURIComponent(match[1]!);
    const flowId = decodeURIComponent(match[2]!);
    const action = match[3]!;
    const flow = pendingOAuthFlows.get(flowId);
    if (!flow || flow.provider !== provider) return stream(`${await refreshProviderState(provider)}${remove("settings_flow_dialog")}`);
    if (action === "prompt") {
      const form = await request.formData();
      flow.redirectSubmitted = true;
      flow.prompt?.resolve(String(form.get("value") ?? ""));
      flow.prompt = undefined;
      return stream(replace("settings_flow_dialog", oauthFlowModal(flow)));
    }
    if (action === "cancel") {
      flow.abort.abort();
      pendingOAuthFlows.delete(flowId);
      return stream(remove("settings_flow_dialog"));
    }
    if (action === "finish") {
      pendingOAuthFlows.delete(flowId);
      return stream(`${await refreshProviderState(provider)}${remove("settings_flow_dialog")}`);
    }
    return stream(replace("settings_flow_dialog", oauthFlowModal(flow)));
  }
  match = url.pathname.match(/^\/settings\/providers\/([^/]+)\/disconnect$/);
  if (match && request.method === "POST") {
    const provider = decodeURIComponent(match[1]!);
    await disconnectModelProvider(provider);
    return stream(await refreshProviderState(provider));
  }
  if (["/settings/models/add", "/settings/models/remove"].includes(url.pathname) && request.method === "POST") return await handleModelPickerAction(request, url.pathname);
  for (const contribution of listSettingsContributions()) {
    const handled = await contribution.handleAction?.({ request, url });
    if (handled) return handled;
  }
  return undefined;
}

async function handleModelPickerAction(request: Request, pathname: string): Promise<Response> {
  const form = await request.formData();
  const split = String(form.get("model") ?? "").split("::");
  const provider = split[0] ?? "";
  const id = split[1] ?? "";
  const current = await getConfiguredAgentModels();
  const index = current.findIndex((model) => model.provider === provider && model.id === id);
  if (pathname === "/settings/models/add" && provider && id && index < 0) {
    const data = await modelSetupData();
    const option = data.models.find((model) => model.provider === provider && model.id === id);
    if (option && data.providers.get(provider)?.connected) current.push({ provider: option.provider, id: option.id, label: option.label });
  }
  if (pathname === "/settings/models/remove" && index >= 0) current.splice(index, 1);
  await setPickerAgentModels(current, current.find((model) => model.active));
  return stream(await refreshConfiguredModelState({ provider, id }));
}

export { githubRow };
