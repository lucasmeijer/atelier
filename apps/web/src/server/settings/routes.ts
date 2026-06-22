import { clearWorkspaceGitHubToken, hasWorkspaceGitHubToken, setWorkspaceGitHubToken } from "@atelier/core";
import {
  getConfiguredAgentModels,
  connectModelProviderApiKey,
  createPiAuthStorage,
  createPiModelRegistry,
  disconnectModelProvider,
  hasAvailableConfiguredAgentModel,
  renderAgentModelOptions,
  setActiveAgentModel,
  setPickerAgentModels,
  type ConfiguredAgentModel,
} from "@atelier/agent/server";
import { atelierName } from "@atelier/shared";
import { clearGitIdentity, getGitIdentity, hasGitIdentity, setGitIdentity } from "@atelier/repository";
import { listSettingsContributions, registerSettingsContribution } from "./registry.ts";
import { validateGitHubToken } from "../github-auth.ts";
import { renderOnboardingDialogIfNeeded } from "../onboarding/routes.ts";

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

function replace(target: string, html: string): string {
  return `<turbo-stream action="replace" target="${escapeHtml(target)}"><template>${html}</template></turbo-stream>`;
}

function update(target: string, html: string): string {
  return `<turbo-stream action="update" target="${escapeHtml(target)}"><template>${html}</template></turbo-stream>`;
}

function updateTargets(selector: string, html: string): string {
  return `<turbo-stream action="update" targets="${escapeHtml(selector)}"><template>${html}</template></turbo-stream>`;
}

function replaceTargets(selector: string, html: string): string {
  return `<turbo-stream action="replace" targets="${escapeHtml(selector)}"><template>${html}</template></turbo-stream>`;
}

function remove(target: string): string {
  return `<turbo-stream action="remove" target="${escapeHtml(target)}"></turbo-stream>`;
}

function append(target: string, html: string): string {
  return `<turbo-stream action="append" target="${escapeHtml(target)}"><template>${html}</template></turbo-stream>`;
}

function domId(...parts: string[]): string {
  return parts.join("_").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function wantsStream(request: Request): boolean {
  return request.headers.get("accept")?.includes("text/vnd.turbo-stream.html") ?? false;
}

function devSettingsEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}

export async function isOnboarded(): Promise<boolean> {
  return await hasGitIdentity() && hasWorkspaceGitHubToken() && await hasAvailableFavoriteModel();
}

function badge(connected: boolean, label = connected ? "Connected" : "Not connected"): string {
  return `<span class="settings-badge ${connected ? "on" : "off"}"><span></span>${escapeHtml(label)}</span>`;
}

function providerColor(provider: string): string {
  const colors: Record<string, string> = {
    anthropic: "#d4a27f",
    openai: "#10a37f",
    "openai-codex": "#10a37f",
    google: "#4285F4",
    gemini: "#4285F4",
    openrouter: "#8a63d2",
    copilot: "#24292f",
    github: "#24292f",
  };
  return colors[provider] ?? `hsl(${[...provider].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360} 52% 54%)`;
}

function providerInitial(label: string): string {
  return (label.trim()[0] ?? "?").toUpperCase();
}

function settingsSection(id: string, title: string, body: string, subtitle = ""): string {
  return `<section class="settings-sec" id="settings-sec-${escapeHtml(id)}"><h2>${escapeHtml(title)}</h2>${subtitle ? `<p class="settings-sub">${escapeHtml(subtitle)}</p>` : ""}${body}</section>`;
}

function githubIcon(): string {
  return `<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.6 7.6 0 0 1 8 3.86c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>`;
}

function githubRow(surface: "settings" | "onboarding" = "settings"): string {
  const connected = hasWorkspaceGitHubToken();
  const flowAction = surface === "onboarding" ? "/settings/github/flow?surface=onboarding" : "/settings/github/flow";
  const disconnectAction = surface === "onboarding" ? "/settings/github/disconnect?surface=onboarding" : "/settings/github/disconnect";
  return `<div class="settings-provider settings-provider-github" id="${domId(surface, "provider", "github")}">
    <div class="settings-provider-icon settings-provider-icon-github" style="--provider-color:${providerColor("github")}">${githubIcon()}</div>
    <div class="settings-provider-main"><div class="settings-provider-title">GitHub${connected ? ` ${badge(true)}` : ""}</div><div class="settings-provider-desc">Atelier injects your GitHub auth token outside of the workspace container your agent runs in, so it is not visible to your coding agent, but it can still push and pull from your private repos.</div></div>
    <div class="settings-provider-actions">${connected
      ? `<form method="post" action="${disconnectAction}" data-turbo="true"><button class="settings-btn danger" type="submit">Disconnect</button></form>`
      : `<form method="post" action="${flowAction}" data-turbo="true"><button class="settings-btn primary" type="submit">Connect</button></form>`}</div>
  </div>`;
}

type ProviderSummary = { provider: string; label: string; connected: boolean; stored: boolean; authLabel: string; methods: string[]; modelCount: number };

function providerAuthLabel(source?: string): string {
  if (source === "stored") return "Connected";
  if (source === "environment") return "Configured from environment";
  if (source === "models_json_command") return "Configured by command";
  if (source === "models_json_key") return "Configured in models.json";
  if (source === "fallback") return "Configured externally";
  return "Configured";
}

async function providerSummaries(): Promise<ProviderSummary[]> {
  const auth = await createPiAuthStorage();
  const registry = await createPiModelRegistry();
  const providers = new Map<string, ProviderSummary>();
  for (const model of registry.getAll() as Array<{ provider: string }>) {
    const provider = model.provider;
    const status = registry.getProviderAuthStatus(provider);
    const entry = providers.get(provider) ?? { provider, label: registry.getProviderDisplayName(provider), connected: false, stored: false, authLabel: "Connected", methods: ["api_key"], modelCount: 0 };
    entry.modelCount += 1;
    entry.connected = status.configured;
    entry.stored = status.source === "stored";
    entry.authLabel = providerAuthLabel(status.source);
    providers.set(provider, entry);
  }
  for (const oauth of auth.getOAuthProviders() as Array<{ id: string; name?: string }>) {
    const status = registry.getProviderAuthStatus(oauth.id);
    const entry = providers.get(oauth.id) ?? { provider: oauth.id, label: oauth.name ?? registry.getProviderDisplayName(oauth.id), connected: false, stored: false, authLabel: "Connected", methods: [], modelCount: 0 };
    entry.methods = Array.from(new Set(["oauth", ...entry.methods]));
    entry.connected = status.configured;
    entry.stored = status.source === "stored";
    entry.authLabel = providerAuthLabel(status.source);
    providers.set(oauth.id, entry);
  }
  return [...providers.values()].sort((a, b) => Number(b.connected) - Number(a.connected) || a.label.localeCompare(b.label));
}

function isSuperPopularProvider(provider: string): boolean {
  return provider === "anthropic" || provider === "openai-codex";
}

function providerRow(provider: ProviderSummary, surface: "settings" | "onboarding" = "settings"): string {
  const id = domId(surface, "provider", provider.provider);
  const methods = provider.methods.length ? provider.methods : ["api_key"];
  const hidden = !provider.connected && !isSuperPopularProvider(provider.provider);
  const modelCount = `${provider.modelCount} model${provider.modelCount === 1 ? "" : "s"}`;
  const surfaceParam = surface === "onboarding" ? "&surface=onboarding" : "";
  const disconnectSurfaceParam = surface === "onboarding" ? "?surface=onboarding" : "";
  const actions = provider.stored
    ? `<form method="post" action="/settings/providers/${encodeURIComponent(provider.provider)}/disconnect${disconnectSurfaceParam}" data-turbo="true"><button class="settings-btn danger" type="submit">Disconnect</button></form>`
    : provider.connected
      ? `<span class="settings-provider-desc">Managed outside Atelier</span>`
      : methods.map((method) => `<form method="post" action="/settings/providers/${encodeURIComponent(provider.provider)}/flow?method=${encodeURIComponent(method)}${surfaceParam}" data-turbo="true"><button class="settings-btn ${surface === "onboarding" ? "primary" : ""}" type="submit">${method === "oauth" ? "Sign in" : "Add API key"}</button></form>`).join("");
  return `<div class="settings-provider${hidden ? " provider-extra hidden" : ""}" id="${id}" data-provider-extra="${hidden ? "true" : "false"}">
    <div class="settings-provider-icon" style="--provider-color:${providerColor(provider.provider)}">${escapeHtml(providerInitial(provider.label))}</div>
    <div class="settings-provider-main"><div class="settings-provider-title">${escapeHtml(provider.label)} <span class="settings-provider-count">${escapeHtml(modelCount)}</span>${provider.connected ? ` ${badge(true, provider.authLabel)}` : ""}</div></div>
    <div class="settings-provider-actions">${actions}</div>
  </div>`;
}

function showMoreProvidersButton(providers: Array<{ connected: boolean; provider: string }>): string {
  const extraCount = providers.filter((provider) => !provider.connected && !isSuperPopularProvider(provider.provider)).length;
  return extraCount > 0 ? `<button class="settings-btn show-more-providers" type="button" data-controller="provider-list" data-action="provider-list#toggle" data-provider-list-label-value="Show ${extraCount} more providers" data-provider-list-open-label-value="Show fewer providers">Show ${extraCount} more providers</button>` : "";
}

async function renderThemeSettings(): Promise<string> {
  const themes = [["daylight", "Daylight"], ["solarized-light", "Solarized Light"], ["cappuccino", "Cappuccino"], ["tokyo-night", "Tokyo Night"], ["midnight", "Midnight"], ["nord", "Nord"]];
  return `<section class="settings-sec settings-sec-inline" id="settings-sec-theme"><h2>Theme</h2><select class="settings-select" data-controller="theme-select">${themes.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></section>`;
}

export async function renderGitIdentityForm(surface: "settings" | "onboarding" = "settings", error = ""): Promise<string> {
  const identity = await getGitIdentity();
  const action = surface === "onboarding" ? "/settings/git-identity?surface=onboarding" : "/settings/git-identity";
  return `<form id="${surface === "settings" ? "settings_git_identity" : "onboarding_git_identity"}" class="settings-git-identity" method="post" action="${action}" data-controller="git-identity" data-action="input->git-identity#queue change->git-identity#save submit->git-identity#submit">
    ${error ? `<p class="settings-error">${escapeHtml(error)}</p>` : ""}
    <div class="settings-field"><div><b>Git user name</b><p>Used as <code>user.name</code> in new workspace containers.</p></div><input class="settings-input" name="name" value="${escapeHtml(identity?.name ?? "")}" placeholder="Ada Lovelace" autocomplete="name" required></div>
    <div class="settings-field"><div><b>Git email</b><p>Used as <code>user.email</code> when commits are created.</p></div><input class="settings-input" type="email" name="email" value="${escapeHtml(identity?.email ?? "")}" placeholder="ada@example.com" autocomplete="email" required></div>
    ${surface === "onboarding" ? `<div class="settings-provider-actions"><span class="settings-provider-desc" data-git-identity-target="status">${identity ? "Saved" : "Autosaves when both fields are filled"}</span></div>` : ""}
  </form>`;
}

async function renderGitIdentitySettings(): Promise<string> {
  return settingsSection("git-identity", "Git identity", await renderGitIdentityForm("settings"));
}

async function renderGitHubSettings(): Promise<string> {
  return settingsSection("github", "GitHub", `<div class="settings-providers">${githubRow()}</div>`);
}

async function renderProviderList(surface: "settings" | "onboarding" = "settings"): Promise<string> {
  const providers = await providerSummaries();
  return `<div class="settings-providers" data-provider-list-scope>${providers.map((provider) => providerRow(provider, surface)).join("")}${showMoreProvidersButton(providers)}</div>`;
}

async function renderModelSetupSettings(): Promise<string> {
  return settingsSection("models", "Models", await renderModelSetup("settings"), "Connect model providers and choose the favorite models shown in prompt boxes.");
}

async function renderDevelopmentSettings(): Promise<string> {
  const devTools = devSettingsEnabled() ? `<form class="settings-reset-form" method="post" action="/settings/workspaces/force-delete/flow" data-turbo="true"><button class="settings-reset-link danger" type="submit">force delete all workspaces</button></form>` : "";
  return settingsSection("development", "Development settings", `<div class="settings-field"><div><b>Setup walkthrough</b><p>Reopen onboarding. It will be shown automatically until your git identity, GitHub, and a working favorite model are configured.</p></div><a class="settings-btn" href="/onboarding" data-turbo-frame="_top" data-turbo-stream="true">Replay</a></div><div class="settings-version">${escapeHtml(atelierName)} · settings prototype</div><form class="settings-reset-form" method="post" action="/settings/reset" data-turbo="true"><button class="settings-reset-link" type="submit" onclick="return confirm('Delete stored git identity, GitHub token, and all stored model provider credentials?')">delete all settings</button></form>${devTools}`);
}

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}::${model.id}`;
}

async function availableModelOptions(): Promise<ConfiguredAgentModel[]> {
  const registry = await createPiModelRegistry();
  const available = registry.getAvailable() as Array<{ provider: string; id: string; name?: string }>;
  return available.map((model) => ({ provider: model.provider, id: model.id, label: model.name ?? model.id }));
}

type FavoriteModelView = ConfiguredAgentModel & { available: boolean; reason?: string };

async function favoriteModelViews(): Promise<FavoriteModelView[]> {
  const configured = await getConfiguredAgentModels();
  const available = new Set((await availableModelOptions()).map(modelKey));
  return configured.map((model) => ({ ...model, available: available.has(modelKey(model)), reason: available.has(modelKey(model)) ? undefined : "Provider disconnected" }));
}

export async function hasAvailableFavoriteModel(): Promise<boolean> {
  return await hasAvailableConfiguredAgentModel();
}

export async function renderModelSetup(surface: "settings" | "onboarding" | "dialog" = "settings"): Promise<string> {
  const providers = await providerSummaries();
  const favorites = await favoriteModelViews();
  const connectedProviderCount = providers.filter((provider) => provider.connected).length;
  const hasAvailableFavorite = favorites.some((model) => model.available);
  const empty = !favorites.length
    ? connectedProviderCount > 0
      ? `<form method="post" action="/settings/models/add-flow" data-turbo="true" class="model-setup-empty add"><button type="submit"><b>Add your first favorite model</b><span>Choose from models provided by your connected providers.</span></button></form>`
      : `<div class="model-setup-empty"><b>First connect a model provider</b><span>After a provider is connected, you can add favorite models here.</span></div>`
    : "";
  const head = surface === "settings" ? "" : `<div class="model-setup-head"><h2>Configure favorite models</h2><p>Connect providers, then choose the models that should appear in prompt boxes.</p></div>`;
  const id = surface === "dialog" ? "model_setup_dialog_content" : `model_setup_${surface}`;
  return `<div class="model-setup model-setup-surface-${surface}" id="${id}" data-model-setup-working="${hasAvailableFavorite ? "true" : "false"}">
    ${head}
    <section class="model-setup-section"><h3>Model providers</h3>${await renderProviderList(surface === "onboarding" ? "onboarding" : "settings")}</section>
    <section class="model-setup-section model-setup-favorites"><div class="model-setup-section-title"><h3>Favorite models</h3>${connectedProviderCount > 0 ? `<form method="post" action="/settings/models/add-flow" data-turbo="true"><button class="settings-btn" type="submit">＋ Add favorite model</button></form>` : ""}</div>
      <div class="settings-models">${favorites.length ? favorites.map(modelFavoriteRow).join("") : empty}</div>
    </section>
  </div>`;
}

function modelFavoriteRow(model: FavoriteModelView): string {
  const value = `${model.provider}::${model.id}`;
  return `<div class="settings-model-row${model.available ? "" : " unavailable"}" id="${domId("settings_model", model.provider, model.id)}">
    <span class="settings-model-dot" style="--provider-color:${providerColor(model.provider)}"></span>
    <div class="settings-model-main"><code>${escapeHtml(model.label)}</code><small>${escapeHtml(model.provider)}${model.available ? "" : ` · ${escapeHtml(model.reason ?? "Unavailable")}`}</small></div>
    <div class="settings-provider-actions"><form method="post" action="/settings/models/remove" data-turbo="true"><input type="hidden" name="model" value="${escapeHtml(value)}"><button class="settings-btn danger icon" type="submit" title="Remove favorite model" aria-label="Remove favorite model">🗑</button></form></div>
  </div>`;
}

async function renderAddModelDialog(): Promise<string> {
  const configured = await getConfiguredAgentModels();
  const have = new Set(configured.map(modelKey));
  const available = (await availableModelOptions()).filter((model) => !have.has(modelKey(model)));
  const byProvider = new Map<string, ConfiguredAgentModel[]>();
  for (const model of available) byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model]);
  const groups = [...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b));
  return `<dialog id="settings_add_model_dialog" class="settings-flow-dialog add-model-dialog" data-controller="modal" data-modal-auto-show-value="true">
    <div class="settings-flow-head"><div class="settings-provider-icon" style="--provider-color:var(--accent)">＋</div><div><b>Add favorite model</b><p>Models from connected providers</p></div></div>
    <div class="settings-flow-body" data-controller="model-add-menu">
      <input class="settings-input settings-model-filter" type="search" placeholder="Filter models…" data-model-add-menu-target="filter" data-action="input->model-add-menu#filter" autocomplete="off" autofocus>
      <div class="settings-add-model-options grouped" data-model-add-menu-target="options">
        ${groups.length ? groups.map(([provider, models]) => `<section class="settings-add-model-group"><h3>${escapeHtml(provider)}</h3>${models.map((model) => `<form method="post" action="/settings/models/add" data-turbo="true" data-model-add-menu-target="option" data-search-text="${escapeHtml(`${model.label} ${model.provider} ${model.id}`.toLowerCase())}"><input type="hidden" name="model" value="${escapeHtml(modelKey(model))}"><button class="settings-add-model-option" type="submit"><span>${escapeHtml(model.label)}</span><small>${escapeHtml(model.id)}</small></button></form>`).join("")}</section>`).join("") : `<div class="settings-empty">No more models available from connected providers.</div>`}
      </div>
    </div>
    <div class="settings-flow-actions"><button class="settings-btn" type="button" data-action="modal#close">Close</button></div>
  </dialog>`;
}

export async function renderModelSetupDialog(): Promise<string> {
  const hasWorking = await hasAvailableFavoriteModel();
  return `<dialog id="model_setup_dialog" class="settings-dialog model-setup-dialog" data-controller="modal" data-modal-auto-show-value="true">
    <div class="settings-sheet"><main class="settings-main">${await renderModelSetup("dialog")}<div class="settings-flow-actions model-setup-ok"><form method="dialog"><button class="settings-btn ${hasWorking ? "" : "warning"}">${hasWorking ? "OK" : "No model configured yet"}</button></form></div></main></div>
  </dialog>`;
}

registerSettingsContribution({ id: "theme", label: "Theme", order: 10, render: renderThemeSettings });
registerSettingsContribution({ id: "git-identity", label: "Git identity", order: 20, render: renderGitIdentitySettings });
registerSettingsContribution({ id: "github", label: "GitHub", order: 30, render: renderGitHubSettings });
registerSettingsContribution({ id: "models", label: "Models", order: 40, render: renderModelSetupSettings });

export async function renderSettingsDialog(_active = "theme"): Promise<string> {
  const contributions = listSettingsContributions();
  const sections = await Promise.all(contributions.map((contribution) => contribution.render()));
  return `<dialog id="settings_dialog" class="settings-dialog" data-controller="modal" data-modal-auto-show-value="true">
    <div class="settings-sheet">
      <main class="settings-main"><form method="dialog"><button class="settings-close" value="close">✕</button></form><div class="settings-title">Settings</div>${sections.join("")}<p class="settings-autosave-note">All changes are auto saved</p><div class="settings-dev-link"><a href="/settings/development" data-turbo-frame="_top" data-turbo-stream="true">Development settings</a></div></main>
    </div>
  </dialog>`;
}

export async function renderDevelopmentSettingsDialog(): Promise<string> {
  return `<dialog id="settings_dialog" class="settings-dialog" data-controller="modal" data-modal-auto-show-value="true">
    <div class="settings-sheet">
      <main class="settings-main"><form method="dialog"><button class="settings-close" value="close">✕</button></form><div class="settings-title"><a class="settings-back-link" href="/settings" data-turbo-frame="_top" data-turbo-stream="true">Settings</a></div>${await renderDevelopmentSettings()}</main>
    </div>
  </dialog>`;
}

function forceDeleteAllWorkspacesModal(error = ""): string {
  return `<dialog id="settings_dev_force_delete_workspaces_dialog" class="settings-flow-dialog" data-controller="modal" data-modal-auto-show-value="true">
    <form method="post" action="/settings/workspaces/force-delete" data-turbo="true">
      <div class="settings-flow-head"><div class="settings-provider-icon" style="--provider-color:${providerColor("github")}">!</div><div><b>Force delete all workspaces?</b><p>Development tool</p></div></div>
      <div class="settings-flow-body"><p>This force-removes every Atelier workspace container in this namespace and deletes its local workspace data. Uncommitted work will be lost.</p>${error ? `<p class="settings-error">${escapeHtml(error)}</p>` : ""}</div>
      <div class="settings-flow-actions"><button class="settings-btn" formmethod="dialog">Cancel</button><button class="settings-btn danger" type="submit">Force delete all workspaces</button></div>
    </form>
  </dialog>`;
}

function forceDeleteAllWorkspacesResultModal(deleted: number, errors: string[]): string {
  return `<dialog id="settings_dev_force_delete_workspaces_dialog" class="settings-flow-dialog" data-controller="modal" data-modal-auto-show-value="true">
    <div class="settings-flow-head"><div class="settings-provider-icon" style="--provider-color:${errors.length ? "var(--red)" : "var(--green)"}">${errors.length ? "!" : "✓"}</div><div><b>Workspace cleanup complete</b><p>Development tool</p></div></div>
    <div class="settings-flow-body"><p>Deleted ${escapeHtml(deleted)} workspace${deleted === 1 ? "" : "s"}.</p>${errors.length ? `<p class="settings-error">${escapeHtml(errors.join("\n"))}</p>` : ""}</div>
    <div class="settings-flow-actions"><form method="dialog"><button class="settings-btn primary">Done</button></form></div>
  </dialog>`;
}

function githubTokenModal(error = "", surface: "settings" | "onboarding" = "settings"): string {
  const action = surface === "onboarding" ? "/settings/github/connect?surface=onboarding" : "/settings/github/connect";
  return `<dialog id="settings_flow_dialog" class="settings-flow-dialog" data-controller="modal" data-modal-auto-show-value="true">
    <form method="post" action="${action}" data-turbo="true">
      <div class="settings-flow-head"><div class="settings-provider-icon settings-provider-icon-github" style="--provider-color:${providerColor("github")}">${githubIcon()}</div><div><b>GitHub</b><p>GitHub CLI token</p></div></div>
      <div class="settings-flow-body">
        <p>On your machine, sign in with GitHub CLI if needed, then print your token:</p>
        <pre class="settings-command">gh auth login
gh auth token</pre>
        <p>Paste the token output below. Atelier stores it locally and injects it into workspace GitHub requests as <code>GH_TOKEN</code>.</p>
        ${error ? `<p class="settings-error">${escapeHtml(error)}</p>` : ""}
        <input class="settings-input settings-token-input" type="password" name="token" placeholder="Paste output from gh auth token" autocomplete="off" required autofocus>
      </div>
      <div class="settings-flow-actions"><button class="settings-btn" type="button" data-action="modal#close">Cancel</button><button class="settings-btn primary" type="submit">Connect</button></div>
    </form>
  </dialog>`;
}

function apiKeyModal(id: string, label: string, action: string, error = ""): string {
  return `<dialog id="settings_flow_dialog" class="settings-flow-dialog" data-controller="modal" data-modal-auto-show-value="true">
    <form method="post" action="${escapeHtml(action)}" data-turbo="true">
      <div class="settings-flow-head"><div class="settings-provider-icon" style="--provider-color:${providerColor(id)}">${escapeHtml(providerInitial(label))}</div><div><b>${escapeHtml(label)}</b><p>API key</p></div></div>
      <div class="settings-flow-body"><p>Paste your provider API key. Atelier stores it locally in pi-compatible auth storage.</p>${error ? `<p class="settings-error">${escapeHtml(error)}</p>` : ""}<input class="settings-input" type="password" name="secret" placeholder="API key" autocomplete="off" required autofocus></div>
      <div class="settings-flow-actions"><button class="settings-btn" formmethod="dialog">Cancel</button><button class="settings-btn primary" type="submit">Connect</button></div>
    </form>
  </dialog>`;
}

type PendingPrompt = { message: string; placeholder?: string; allowEmpty?: boolean; resolve: (value: string) => void };
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
  progress: string[];
  prompt?: PendingPrompt;
  error?: string;
};

const pendingOAuthFlows = new Map<string, PendingOAuthFlow>();

async function startOAuthFlow(provider: string, label: string): Promise<PendingOAuthFlow> {
  const auth = await createPiAuthStorage();
  const oauthProvider = auth.getOAuthProviders().find((candidate) => candidate.id === provider);
  if (!oauthProvider) throw new Error(`${label} does not support OAuth in this pi installation.`);
  const flow: PendingOAuthFlow = { id: crypto.randomUUID(), provider, label, status: "pending", startedAt: Date.now(), abort: new AbortController(), progress: [] };
  pendingOAuthFlows.set(flow.id, flow);
  void auth.login(provider, {
    onAuth: (info) => { flow.authUrl = info.url; flow.instructions = info.instructions; },
    onDeviceCode: (info) => { flow.userCode = info.userCode; flow.verificationUri = info.verificationUri; flow.intervalSeconds = info.intervalSeconds; },
    onProgress: (message) => { flow.progress = [...flow.progress.slice(-4), message]; },
    onPrompt: (prompt) => new Promise<string>((resolve) => {
      if (prompt.allowEmpty) return resolve("");
      flow.prompt = { message: prompt.message, placeholder: prompt.placeholder, allowEmpty: prompt.allowEmpty, resolve };
    }),
    onManualCodeInput: () => new Promise<string>((resolve) => {
      flow.prompt = { message: "Paste the authorization code from the browser", placeholder: "Authorization code", resolve };
    }),
    onSelect: async (prompt) => prompt.options.find((option) => /default/i.test(option.label ?? ""))?.id
      ?? prompt.options.find((option) => !/device|headless/i.test(`${option.id} ${option.label ?? ""}`))?.id
      ?? prompt.options[0]?.id,
    signal: flow.abort.signal,
  }).then(() => {
    flow.status = "complete";
    flow.progress = [...flow.progress.slice(-4), "Connected."];
  }).catch((error) => {
    if (flow.abort.signal.aborted) return;
    flow.status = "error";
    flow.error = error instanceof Error ? error.message : String(error);
    flow.progress = [...flow.progress.slice(-4), flow.error];
  });
  await waitForOAuthFlowReady(flow);
  return flow;
}

async function waitForOAuthFlowReady(flow: PendingOAuthFlow): Promise<void> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline && flow.status === "pending" && !flow.authUrl && !flow.verificationUri && !flow.prompt) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function oauthFlowModal(flow: PendingOAuthFlow): string {
  const statusBody = flow.status === "complete"
    ? `<p>${escapeHtml(flow.label)} is connected.</p>`
    : flow.status === "error"
      ? `<p class="settings-error">${escapeHtml(flow.error ?? "OAuth login failed")}</p>`
      : "";
  const manualForm = flow.prompt && flow.status === "pending"
    ? `<form method="post" action="/settings/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/prompt" data-turbo="true"><p>${escapeHtml(flow.prompt.message)}</p><input class="settings-input" name="value" placeholder="${escapeHtml(flow.prompt.placeholder ?? "Authorization code or redirect URL")}" ${flow.prompt.allowEmpty ? "" : "required"}><div class="settings-oauth-manual-actions"><button class="settings-btn" type="submit">Submit</button></div></form>`
    : "";
  const troubleContent = `${flow.instructions ? `<p class="settings-provider-desc">${escapeHtml(flow.instructions)}</p>` : ""}${manualForm}${flow.progress.length ? `<ul class="settings-flow-progress">${flow.progress.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}` || `<p>Leave this dialog open after approving in your browser.</p>`;
  const trouble = flow.status === "pending" ? `<details class="settings-oauth-manual"><summary>Having trouble?</summary>${troubleContent}</details>` : "";
  const auth = flow.verificationUri
    ? `<div class="settings-oauth-card"><a class="settings-btn primary" href="${escapeHtml(flow.verificationUri)}" target="_blank" rel="noreferrer">Open auth page</a><div class="settings-code-row" data-controller="clipboard"><div class="settings-code compact" data-clipboard-target="source">${escapeHtml(flow.userCode ?? "")}</div><button class="settings-btn icon" type="button" data-action="clipboard#copy" title="Copy to clipboard" aria-label="Copy to clipboard">⧉</button></div>${trouble}</div>`
    : flow.authUrl
      ? `<div class="settings-oauth-card"><a class="settings-btn primary" href="${escapeHtml(flow.authUrl)}" target="_blank" rel="noreferrer">Open auth page</a>${trouble}</div>`
      : `<div class="settings-oauth-card"><p>Starting OAuth flow…</p></div>`;
  const pollMs = Math.max(1500, Math.min(15000, (flow.intervalSeconds ?? 3) * 1000));
  return `<dialog id="settings_flow_dialog" class="settings-flow-dialog" data-controller="modal oauth-flow" data-modal-auto-show-value="true" data-oauth-flow-status-url-value="/settings/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/status" data-oauth-flow-active-value="${flow.status === "pending" ? "true" : "false"}" data-oauth-flow-poll-ms-value="${pollMs}">
    <div class="settings-flow-head"><div class="settings-provider-icon" style="--provider-color:${providerColor(flow.provider)}">${escapeHtml(providerInitial(flow.label))}</div><div><b>Sign in with ${escapeHtml(flow.label)}</b></div></div>
    <div class="settings-flow-body">${statusBody}${flow.status === "pending" ? auth : ""}</div>
    <div class="settings-flow-actions settings-oauth-actions">
      ${flow.status === "complete" ? `<form method="post" action="/settings/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/finish" data-turbo="true"><button class="settings-btn primary" type="submit">Done</button></form>` : ""}
      ${flow.status === "pending" ? `<form method="post" action="/settings/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/cancel" data-turbo="true"><button class="settings-btn danger" type="submit">Cancel</button></form>` : ""}
      ${flow.status === "error" ? `<form method="post" action="/settings/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/finish" data-turbo="true"><button class="settings-btn" type="submit">Close</button></form>` : ""}
    </div>
  </dialog>`;
}

async function refreshAgentModelPickerSelects(): Promise<string> {
  const options = await renderAgentModelOptions();
  return `${updateTargets('select[data-agent-model-picker-select="true"]:not([data-agent-session-model-select="true"])', options)}${updateTargets('select[data-agent-model-picker-select="true"][data-agent-session-model-select="true"]', options)}`;
}

async function refreshModelSetupSurfaces(): Promise<string> {
  return `${replaceTargets(".model-setup-surface-settings", await renderModelSetup("settings"))}${replaceTargets(".model-setup-surface-onboarding", await renderModelSetup("onboarding"))}${replace("model_setup_dialog", await renderModelSetupDialog())}${await refreshAgentModelPickerSelects()}`;
}

async function refreshAfterConnection(): Promise<string> {
  return `${await refreshModelSetupSurfaces()}${remove("settings_flow_dialog")}`;
}

async function deleteAllStoredSettings(): Promise<void> {
  clearWorkspaceGitHubToken();
  await clearGitIdentity();
  await setPickerAgentModels([]);
  const auth = await createPiAuthStorage();
  for (const provider of auth.list()) auth.remove(provider);
}

export async function handleSettingsRequest(request: Request, url: URL, options: { forceDeleteAllWorkspaces?: () => Promise<{ deleted: number; errors: string[] }> } = {}): Promise<Response | undefined> {
  if (url.pathname === "/settings" && request.method === "GET") {
    const html = await renderSettingsDialog(url.searchParams.get("section") ?? "theme");
    return wantsStream(request) ? stream(update("settings_modal_host", html)) : response(html);
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
    const surface = url.searchParams.get("surface") === "onboarding" ? "onboarding" : "settings";
    try {
      await setGitIdentity({ name: String(form.get("name") ?? ""), email: String(form.get("email") ?? "") });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (surface === "onboarding") return stream(replace("onboarding_git_identity", await renderGitIdentityForm("onboarding", message)));
      return stream(replace("settings_git_identity", await renderGitIdentityForm("settings", message)));
    }
    return surface === "onboarding"
      ? stream(replace("onboarding_git_identity", await renderGitIdentityForm("onboarding")))
      : stream(`${replace("settings_dialog", await renderSettingsDialog("git-identity"))}${update("onboarding_modal_host", await renderOnboardingDialogIfNeeded())}`);
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
    const registry = await createPiModelRegistry();
    const label = registry.getProviderDisplayName(provider);
    if (method === "oauth") {
      try {
        const flow = await startOAuthFlow(provider, label);
        return surface === "onboarding" ? stream(append("onboarding_modal_host", oauthFlowModal(flow))) : stream(update("settings_modal_host", `${await renderModelSetupDialog()}${oauthFlowModal(flow)}`));
      } catch (error) {
        return surface === "onboarding" ? stream(append("onboarding_modal_host", apiKeyModal(provider, label, `/settings/providers/${encodeURIComponent(provider)}/connect?surface=onboarding`, error instanceof Error ? error.message : String(error)))) : stream(update("settings_modal_host", `${await renderModelSetupDialog()}${apiKeyModal(provider, label, `/settings/providers/${encodeURIComponent(provider)}/connect`, error instanceof Error ? error.message : String(error))}`));
      }
    }
    return surface === "onboarding" ? stream(append("onboarding_modal_host", apiKeyModal(provider, label, `/settings/providers/${encodeURIComponent(provider)}/connect?surface=onboarding`))) : stream(update("settings_modal_host", `${await renderModelSetupDialog()}${apiKeyModal(provider, label, `/settings/providers/${encodeURIComponent(provider)}/connect`)}`));
  }
  match = url.pathname.match(/^\/settings\/providers\/([^/]+)\/connect$/);
  if (match && request.method === "POST") {
    const provider = decodeURIComponent(match[1]!);
    const surface = url.searchParams.get("surface") === "onboarding" ? "onboarding" : "settings";
    const registry = await createPiModelRegistry();
    const label = registry.getProviderDisplayName(provider);
    const form = await request.formData();
    const secret = String(form.get("secret") ?? "");
    try {
      await connectModelProviderApiKey(provider, secret);
    } catch (error) {
      return stream(replace("settings_flow_dialog", apiKeyModal(provider, label, `/settings/providers/${encodeURIComponent(provider)}/connect${surface === "onboarding" ? "?surface=onboarding" : ""}`, error instanceof Error ? error.message : String(error))));
    }
    return stream(await refreshAfterConnection());
  }
  match = url.pathname.match(/^\/settings\/providers\/([^/]+)\/oauth\/([^/]+)\/(status|prompt|finish|cancel)$/);
  if (match && request.method === "POST") {
    const provider = decodeURIComponent(match[1]!);
    const flowId = decodeURIComponent(match[2]!);
    const action = match[3]!;
    const flow = pendingOAuthFlows.get(flowId);
    if (!flow || flow.provider !== provider) return stream(await refreshAfterConnection());
    if (action === "prompt") {
      const form = await request.formData();
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
      return stream(await refreshAfterConnection());
    }
    return stream(replace("settings_flow_dialog", oauthFlowModal(flow)));
  }
  match = url.pathname.match(/^\/settings\/providers\/([^/]+)\/disconnect$/);
  if (match && request.method === "POST") {
    await disconnectModelProvider(decodeURIComponent(match[1]!));
    return stream(await refreshModelSetupSurfaces());
  }
  if (url.pathname === "/settings/models/add-flow" && request.method === "POST") return stream(append("settings_modal_host", await renderAddModelDialog()));
  if (url.pathname.startsWith("/settings/models/") && request.method === "POST") return await handleModelPickerAction(request, url.pathname);
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
    const option = (await availableModelOptions()).find((model) => model.provider === provider && model.id === id);
    current.push(option ?? { provider, id, label: id });
  }
  if (pathname === "/settings/models/remove" && index >= 0) current.splice(index, 1);
  if (pathname === "/settings/models/active" && provider && id) await setActiveAgentModel(provider, id);
  else await setPickerAgentModels(current, current.find((model) => model.active));
  return stream(`${await refreshModelSetupSurfaces()}${pathname === "/settings/models/add" ? remove("settings_add_model_dialog") : ""}`);
}

export { githubRow };
