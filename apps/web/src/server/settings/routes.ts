import { clearWorkspaceGitHubToken, hasWorkspaceGitHubToken, setWorkspaceGitHubToken } from "@atelier/proxy-egress";
import {
  getConfiguredAgentModels,
  connectModelProviderApiKey,
  createPiModelRuntime,
  disconnectModelProvider,
  getProviderApiKeyExample,
  hasAvailableConfiguredAgentModel,
  loginPiOAuthProvider,
  addHardcodedProviderModels,
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
  return hasWorkspaceGitHubToken() && await hasAvailableFavoriteModel();
}

function badge(connected: boolean, label = connected ? "Connected" : "Not connected"): string {
  return `<span class="settings-badge ${connected ? "on" : "off"}"><span></span>${escapeHtml(label)}</span>`;
}

function providerIcon(provider: string, label = provider, className = "settings-provider-icon", tag: "div" | "span" = "div"): string {
  const githubClass = provider === "github" ? " settings-provider-icon-github" : "";
  return `<${tag} class="${className}${githubClass}" style="--provider-color:${providerBrandColor(provider)}">${providerBrandIconHtml(provider, label)}</${tag}>`;
}

function settingsSection(id: string, title: string, body: string, subtitle = ""): string {
  return `<section class="settings-sec" id="settings-sec-${escapeHtml(id)}"><h2>${escapeHtml(title)}</h2>${subtitle ? `<p class="settings-sub">${escapeHtml(subtitle)}</p>` : ""}${body}</section>`;
}

function githubRow(surface: "settings" | "onboarding" = "settings"): string {
  const connected = hasWorkspaceGitHubToken();
  const flowAction = surface === "onboarding" ? "/settings/github/flow?surface=onboarding" : "/settings/github/flow";
  const disconnectAction = surface === "onboarding" ? "/settings/github/disconnect?surface=onboarding" : "/settings/github/disconnect";
  return `<div class="settings-provider settings-provider-github" id="${domId(surface, "provider", "github")}">
    ${providerIcon("github", "GitHub")}
    <div class="settings-provider-main"><div class="settings-provider-title">GitHub${connected ? ` ${badge(true)}` : ""}</div><div class="settings-provider-desc">Atelier injects your GitHub auth token outside of the workspace container your agent runs in, so it is not visible to your coding agent, but it can still push and pull from your private repos.</div></div>
    <div class="settings-provider-actions">${connected
      ? `<form method="post" action="${disconnectAction}" data-turbo="true"><button class="button danger" type="submit">Disconnect</button></form>`
      : `<form method="post" action="${flowAction}" data-turbo="true"><button class="button primary" type="submit">Connect</button></form>`}</div>
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
  const runtime = await createPiModelRuntime();
  return runtime.getProviders().map((provider): ProviderSummary => {
    const status = runtime.getProviderAuthStatus(provider.id);
    return {
      provider: provider.id,
      label: provider.name ?? provider.id,
      connected: status.configured,
      stored: status.source === "stored",
      authLabel: providerAuthLabel(status.source),
      methods: [provider.auth.oauth && "oauth", provider.auth.apiKey?.login && "api_key"].filter((method): method is string => Boolean(method)),
      modelCount: runtime.getModels(provider.id).length,
    };
  }).sort((a, b) => Number(b.connected) - Number(a.connected) || a.label.localeCompare(b.label));
}

function isHighlightedProvider(provider: string): boolean {
  return provider === "anthropic" || provider === "openai-codex";
}

function providerRow(provider: ProviderSummary, surface: "settings" | "onboarding" = "settings"): string {
  const id = domId(surface, "provider", provider.provider);
  const methods = provider.methods;
  const hidden = !provider.connected && !isHighlightedProvider(provider.provider);
  const modelCount = `${provider.modelCount} model${provider.modelCount === 1 ? "" : "s"}`;
  const surfaceParam = surface === "onboarding" ? "&surface=onboarding" : "";
  const disconnectSurfaceParam = surface === "onboarding" ? "?surface=onboarding" : "";
  const actions = provider.stored
    ? `<form method="post" action="/settings/providers/${encodeURIComponent(provider.provider)}/disconnect${disconnectSurfaceParam}" data-turbo="true"><button class="button danger" type="submit">Disconnect</button></form>`
    : provider.connected
      ? `<span class="settings-provider-desc">Managed outside Atelier</span>`
      : methods.map((method) => `<form method="post" action="/settings/providers/${encodeURIComponent(provider.provider)}/flow?method=${encodeURIComponent(method)}${surfaceParam}" data-turbo="true"><button class="button ${surface === "onboarding" ? "primary" : "secondary"}" type="submit">${method === "oauth" ? "Sign in" : "Add API key"}</button></form>`).join("");
  return `<div class="settings-provider${hidden ? " provider-extra hidden" : ""}" id="${id}" data-provider-extra="${hidden ? "true" : "false"}">
    ${providerIcon(provider.provider, provider.label)}
    <div class="settings-provider-main"><div class="settings-provider-title">${escapeHtml(provider.label)} <span class="settings-provider-count">${escapeHtml(modelCount)}</span>${provider.connected ? ` ${badge(true, provider.authLabel)}` : ""}</div></div>
    <div class="settings-provider-actions">${actions}</div>
  </div>`;
}

function showMoreProvidersButton(providers: Array<{ connected: boolean; provider: string }>): string {
  const extraCount = providers.filter((provider) => !provider.connected && !isHighlightedProvider(provider.provider)).length;
  return extraCount > 0 ? `<button class="button secondary show-more-providers" type="button" data-controller="provider-list" data-action="provider-list#toggle" data-provider-list-label-value="Show ${extraCount} more providers" data-provider-list-open-label-value="Show fewer providers">Show ${extraCount} more providers</button>` : "";
}

async function renderThemeSettings(): Promise<string> {
  const themes = [["daylight", "Daylight"], ["cappuccino", "Cappuccino"], ["tokyo-night", "Tokyo Night"], ["midnight", "Midnight"], ["nord", "Nord"]];
  return `<section class="settings-sec settings-sec-inline" id="settings-sec-theme"><h2>Theme</h2><select class="settings-select" data-controller="theme-select popup-select" aria-label="Theme">${themes.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></section>`;
}

async function renderGitIdentityForm(error = ""): Promise<string> {
  const identity = await getGitIdentity();
  return `<form id="settings_git_identity" class="settings-git-identity" method="post" action="/settings/git-identity" data-controller="git-identity" data-action="input->git-identity#queue change->git-identity#save submit->git-identity#submit">
    ${error ? `<p class="settings-error">${escapeHtml(error)}</p>` : ""}
    <div class="settings-field"><div><b>Git user name</b><p>Used as <code>user.name</code> in new workspace containers.</p></div><input class="settings-input text-field" name="name" value="${escapeHtml(identity?.name ?? "")}" placeholder="Ada Lovelace" autocomplete="name" required></div>
    <div class="settings-field"><div><b>Git email</b><p>Used as <code>user.email</code> when commits are created.</p></div><input class="settings-input text-field" type="email" name="email" value="${escapeHtml(identity?.email ?? "")}" placeholder="ada@example.com" autocomplete="email" required></div>
  </form>`;
}

async function renderGitIdentitySettings(): Promise<string> {
  return settingsSection("git-identity", "Git identity", await renderGitIdentityForm());
}

async function renderGitHubSettings(): Promise<string> {
  return settingsSection("github", "GitHub", `<div class="settings-providers">${githubRow()}</div>`);
}

async function renderProviderList(surface: "settings" | "onboarding" = "settings"): Promise<string> {
  const providers = await providerSummaries();
  return `<div class="settings-providers" data-provider-list-scope>${providers.map((provider) => providerRow(provider, surface)).join("")}${showMoreProvidersButton(providers)}</div>`;
}

async function renderModelSetupSettings(): Promise<string> {
  return settingsSection("models", "Models", await renderModelSetup("settings"), "Connect model providers and choose the favorites shown in model menus.");
}

async function renderDevelopmentSettings(): Promise<string> {
  const forceDeleteWorkspaces = devSettingsEnabled() ? `<form class="settings-reset-form" method="post" action="/settings/workspaces/force-delete/flow" data-turbo="true"><button class="settings-reset-link danger" type="submit">force delete all workspaces</button></form>` : "";
  const keypressProbeSettings = await listSettingsContributions().find((contribution) => contribution.id === "keypress-probe")?.render() ?? "";
  const resetSettings = `<form class="settings-reset-form" method="post" action="/settings/reset" data-turbo="true"><button class="settings-reset-link" type="submit" onclick="return confirm('Delete stored git identity, GitHub token, and all stored model provider credentials?')">delete all settings</button></form>`;
  return `${settingsSection("development", "Development settings", "")}${keypressProbeSettings}<div class="settings-dev-actions">${resetSettings}${forceDeleteWorkspaces}</div>`;
}

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}::${model.id}`;
}

async function availableModelOptions(): Promise<ConfiguredAgentModel[]> {
  const runtime = await createPiModelRuntime();
  const available = await runtime.getAvailable();
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
  for (const provider of providers.filter((candidate) => candidate.connected)) await addHardcodedProviderModels(provider.provider);
  const favorites = await favoriteModelViews();
  const connectedProviderCount = providers.filter((provider) => provider.connected).length;
  const hasAvailableFavorite = favorites.some((model) => model.available);
  const empty = !favorites.length
    ? connectedProviderCount > 0
      ? `<form method="post" action="/settings/models/add-flow" data-turbo="true" class="model-setup-empty add"><button type="submit"><b>Add your first favorite model</b><span>Choose from models provided by your connected providers.</span></button></form>`
      : `<div class="model-setup-empty"><b>First connect a model provider</b><span>After a provider is connected, you can add favorite models here.</span></div>`
    : "";
  const head = surface === "settings" ? "" : `<div class="model-setup-head"><h2>Configure favorite models</h2><p>Connect providers, then choose the favorites that should appear in model menus.</p></div>`;
  const id = surface === "dialog" ? "model_setup_dialog_content" : `model_setup_${surface}`;
  return `<div class="model-setup model-setup-surface-${surface}" id="${id}" data-model-setup-working="${hasAvailableFavorite ? "true" : "false"}">
    ${head}
    <section class="model-setup-section"><h3>Model providers</h3>${await renderProviderList(surface === "onboarding" ? "onboarding" : "settings")}</section>
    <section class="model-setup-section model-setup-favorites"><div class="model-setup-section-title"><h3>Favorite models</h3>${connectedProviderCount > 0 ? `<form method="post" action="/settings/models/add-flow" data-turbo="true"><button class="button secondary" type="submit">＋ Add favorite model</button></form>` : ""}</div>
      <div class="settings-models">${favorites.length ? favorites.map(modelFavoriteRow).join("") : empty}</div>
    </section>
  </div>`;
}

function modelFavoriteRow(model: FavoriteModelView): string {
  const value = `${model.provider}::${model.id}`;
  return `<div class="settings-model-row${model.available ? "" : " unavailable"}" id="${domId("settings_model", model.provider, model.id)}">
    ${providerIcon(model.provider, model.provider, "settings-model-dot settings-model-provider-icon")}
    <div class="settings-model-main"><code>${escapeHtml(model.label)}</code><small>${escapeHtml(model.provider)}${model.available ? "" : ` · ${escapeHtml(model.reason ?? "Unavailable")}`}</small></div>
    <div class="settings-provider-actions"><form method="post" action="/settings/models/remove" data-turbo="true"><input type="hidden" name="model" value="${escapeHtml(value)}"><button class="button danger icon-only" type="submit" title="Remove favorite model" aria-label="Remove favorite model"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg></button></form></div>
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
      <input class="settings-input text-field settings-model-filter" type="search" placeholder="Filter models…" data-model-add-menu-target="filter" data-action="input->model-add-menu#filter" autocomplete="off" autofocus>
      <div class="settings-add-model-options grouped" data-model-add-menu-target="options">
        ${groups.length ? groups.map(([provider, models]) => `<section class="settings-add-model-group"><h3>${providerIcon(provider, provider, "settings-add-model-provider-icon", "span")}${escapeHtml(provider)}</h3>${models.map((model) => `<form method="post" action="/settings/models/add" data-turbo="true" data-model-add-menu-target="option" data-search-text="${escapeHtml(`${model.label} ${model.provider} ${model.id}`.toLowerCase())}"><input type="hidden" name="model" value="${escapeHtml(modelKey(model))}"><button class="settings-add-model-option" type="submit"><span>${escapeHtml(model.label)}</span><small>${escapeHtml(model.id)}</small></button></form>`).join("")}</section>`).join("") : `<div class="settings-empty">No more models available from connected providers.</div>`}
      </div>
    </div>
    <div class="settings-flow-actions"><button class="button secondary" type="button" data-action="modal#close">Close</button></div>
  </dialog>`;
}

export async function renderModelSetupDialog(): Promise<string> {
  const hasWorking = await hasAvailableFavoriteModel();
  return `<dialog id="model_setup_dialog" class="settings-dialog model-setup-dialog" data-controller="modal" data-modal-auto-show-value="true">
    <div class="settings-sheet"><main class="settings-main">${await renderModelSetup("dialog")}<div class="settings-flow-actions model-setup-ok"><form method="dialog"><button class="button ${hasWorking ? "secondary" : "warning"}">${hasWorking ? "OK" : "No model configured yet"}</button></form></div></main></div>
  </dialog>`;
}

registerSettingsContribution({ id: "theme", label: "Theme", order: 10, render: renderThemeSettings });
registerSettingsContribution({ id: "git-identity", label: "Git identity", order: 20, render: renderGitIdentitySettings });
registerSettingsContribution({ id: "github", label: "GitHub", order: 30, render: renderGitHubSettings });
registerSettingsContribution({ id: "models", label: "Models", order: 40, render: renderModelSetupSettings });
for (const module of workspaceModules) {
  for (const contribution of module.settingsContributions ?? []) registerSettingsContribution(contribution);
}

export async function renderSettingsDialog(_active = "theme"): Promise<string> {
  const contributions = listSettingsContributions().filter((contribution) => contribution.id !== "keypress-probe");
  const sections = await Promise.all(contributions.map((contribution) => contribution.render()));
  return `<dialog id="settings_dialog" class="settings-dialog" data-controller="modal" data-modal-auto-show-value="true">
    <div class="settings-sheet">
      <main class="settings-main"><form method="dialog"><button class="settings-close button secondary icon-only" value="close" title="Close settings" aria-label="Close settings"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></form><div class="settings-title">Settings</div>${sections.join("")}<div class="settings-dev-link"><a href="/settings/development" data-turbo-frame="_top" data-turbo-stream="true">Development settings</a></div></main>
    </div>
  </dialog>`;
}

export async function renderDevelopmentSettingsDialog(): Promise<string> {
  return `<dialog id="settings_dialog" class="settings-dialog" data-controller="modal" data-modal-auto-show-value="true">
    <div class="settings-sheet">
      <main class="settings-main settings-main-dev"><form method="dialog"><button class="settings-close button secondary icon-only" value="close" title="Close settings" aria-label="Close settings"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></form><div class="settings-title"><a class="settings-back-link" href="/settings" data-turbo-frame="_top" data-turbo-stream="true">Settings</a></div>${await renderDevelopmentSettings()}</main>
    </div>
  </dialog>`;
}

function forceDeleteAllWorkspacesModal(error = ""): string {
  return `<dialog id="settings_dev_force_delete_workspaces_dialog" class="settings-flow-dialog" data-controller="modal" data-modal-auto-show-value="true">
    <form method="post" action="/settings/workspaces/force-delete" data-turbo="true">
      <div class="settings-flow-head"><div class="settings-provider-icon" style="--provider-color:${providerBrandColor("github")}">!</div><div><b>Force delete all workspaces?</b><p>Development tool</p></div></div>
      <div class="settings-flow-body"><p>This force-removes every Atelier workspace container in this namespace and deletes its local workspace data. Uncommitted work will be lost.</p>${error ? `<p class="settings-error">${escapeHtml(error)}</p>` : ""}</div>
      <div class="settings-flow-actions"><button class="button secondary" formmethod="dialog">Cancel</button><button class="button danger" type="submit">Force delete all workspaces</button></div>
    </form>
  </dialog>`;
}

function forceDeleteAllWorkspacesResultModal(deleted: number, errors: string[]): string {
  return `<dialog id="settings_dev_force_delete_workspaces_dialog" class="settings-flow-dialog" data-controller="modal" data-modal-auto-show-value="true">
    <div class="settings-flow-head"><div class="settings-provider-icon" style="--provider-color:${errors.length ? "var(--danger)" : "var(--success)"}">${errors.length ? "!" : "✓"}</div><div><b>Workspace cleanup complete</b><p>Development tool</p></div></div>
    <div class="settings-flow-body"><p>Deleted ${escapeHtml(deleted)} workspace${deleted === 1 ? "" : "s"}.</p>${errors.length ? `<p class="settings-error">${escapeHtml(errors.join("\n"))}</p>` : ""}</div>
    <div class="settings-flow-actions"><form method="dialog"><button class="button primary">Done</button></form></div>
  </dialog>`;
}

function githubTokenModal(error = "", surface: "settings" | "onboarding" = "settings"): string {
  const action = surface === "onboarding" ? "/settings/github/connect?surface=onboarding" : "/settings/github/connect";
  return `<dialog id="settings_flow_dialog" class="settings-flow-dialog" data-controller="modal" data-modal-auto-show-value="true">
    <form method="post" action="${action}" data-turbo="true">
      <div class="settings-flow-head">${providerIcon("github", "GitHub")}<div><b>GitHub</b><p>GitHub CLI token</p></div></div>
      <div class="settings-flow-body">
        <p>On your machine, sign in with GitHub CLI if needed, then print your token:</p>
        <pre class="settings-command">gh auth login
gh auth token</pre>
        <p>Paste the token output below. Atelier stores it locally and injects it into workspace GitHub requests as <code>GH_TOKEN</code>.</p>
        ${error ? `<p class="settings-error">${escapeHtml(error)}</p>` : ""}
        <input class="settings-input text-field settings-token-input" type="password" name="token" placeholder="Paste output from gh auth token" autocomplete="off" required autofocus>
      </div>
      <div class="settings-flow-actions"><button class="button secondary" type="button" data-action="modal#close">Cancel</button><button class="button primary" type="submit">Connect</button></div>
    </form>
  </dialog>`;
}

function apiKeyModal(id: string, label: string, action: string, error = ""): string {
  return `<dialog id="settings_flow_dialog" class="settings-flow-dialog" data-controller="modal" data-modal-auto-show-value="true">
    <form method="post" action="${escapeHtml(action)}" data-turbo="true">
      <div class="settings-flow-head">${providerIcon(id, label)}<div><b>${escapeHtml(label)}</b><p>API key</p></div></div>
      <div class="settings-flow-body"><div class="settings-oauth-card">
        ${error ? `<p class="settings-error">${escapeHtml(error)}</p>` : ""}
        <div class="settings-oauth-input-row"><input class="settings-input text-field" type="password" name="secret" placeholder="${escapeHtml(getProviderApiKeyExample(id) ?? "API key")}" autocomplete="off" required autofocus><button class="button primary" type="submit">Connect</button></div>
      </div></div>
      <div class="settings-flow-actions"><button class="button secondary" formmethod="dialog">Cancel</button></div>
    </form>
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
  loadingModels?: boolean;
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
  }).then(async () => {
    flow.loadingModels = true;
    await addHardcodedProviderModels(provider);
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

function oauthProgressItem(kind: "pending" | "done", title: string, detail: string, meta: string): string {
  return `<div class="settings-oauth-progress-item ${kind}"><i class="settings-oauth-status-icon ${kind}">${kind === "done" ? "✓" : ""}</i><div><strong>${escapeHtml(title)}</strong>${escapeHtml(detail)}</div><small>${escapeHtml(meta)}</small><div class="settings-oauth-bar"></div></div>`;
}

function oauthDeviceCodeBody(flow: PendingOAuthFlow, pollMs: number): string {
  const code = escapeHtml(flow.userCode ?? "");
  const authUrl = escapeHtml(flow.verificationUri ?? "#");
  const loadingModels = flow.loadingModels === true;
  const hidden = loadingModels ? "" : " hidden";
  const progress = loadingModels
    ? `${oauthProgressItem("done", `${flow.label} approval received`, "Your device code was accepted.", "done")}${oauthProgressItem("pending", "Getting model list", "This can take a few seconds. Please keep this dialog open.", `every ${Math.round(pollMs / 1000)}s`)}`
    : oauthProgressItem("pending", `Waiting for ${flow.label} approval`, "Checking whether the code has been accepted.", `every ${Math.round(pollMs / 1000)}s`);
  return `<div class="settings-oauth-card" data-controller="clipboard oauth-progress-reveal">
    <div class="settings-oauth-code-label">Copy this code into your clipboard</div>
    <div class="settings-oauth-code"><code data-clipboard-target="source">${code}</code><button class="button secondary" type="button" data-oauth-copy-button="true" data-action="clipboard#copy oauth-progress-reveal#showAuth">Copy code</button></div>
    <div class="settings-oauth-action" data-oauth-progress-reveal-target="auth"${loadingModels ? "" : " hidden"}><div class="settings-oauth-action-row"><div><small>${loadingModels ? "Now loading available models." : "The next page will ask for your copied code."}</small></div><a class="button ${loadingModels ? "secondary" : "primary"}" href="${authUrl}" target="_blank" rel="noreferrer" data-action="oauth-progress-reveal#showProgress">${loadingModels ? `Reopen ${escapeHtml(flow.label)}` : `Authenticate at ${escapeHtml(flow.label)}`}</a></div></div>
    <div class="settings-oauth-progress" data-oauth-progress-reveal-target="progress"${hidden}>${progress}</div>
  </div>`;
}

function oauthBrowserRedirectBody(flow: PendingOAuthFlow, pollMs: number): string {
  const authUrl = escapeHtml(flow.authUrl ?? "#");
  const prompt = flow.prompt;
  const promptForm = prompt ? `<form class="settings-oauth-input-row" method="post" action="/settings/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/prompt" data-turbo="true" data-oauth-progress-reveal-target="prompt" hidden><input class="settings-input text-field" name="value" placeholder="http://localhost:1455/callback?code=abc123...&state=..." required><button class="button primary" type="submit">Submit URL</button></form>` : "";
  return `<div class="settings-oauth-card" data-controller="oauth-progress-reveal">
    <div class="settings-oauth-callout"><b>Before you start</b>${escapeHtml(flow.label)} assumes you will sign in on your local machine, but that’s not how Atelier works.<br><br>${escapeHtml(flow.label)} will redirect you to a localhost URL after you sign in. That URL will fail to load. You need to copy the long URL from the address bar, and paste it here.</div>
    <div class="settings-oauth-action"><div class="settings-oauth-action-row"><div><small>Sign in, approve access, then copy the final localhost URL.</small></div><a class="button primary" href="${authUrl}" target="_blank" rel="noreferrer" data-action="oauth-progress-reveal#showPrompt">Authenticate at ${escapeHtml(flow.label)}</a></div></div>
    ${promptForm}
    ${!prompt && (flow.redirectSubmitted || flow.loadingModels) ? `<div class="settings-oauth-progress">${flow.loadingModels ? `${oauthProgressItem("done", `${flow.label} approval received`, "The redirect URL was accepted.", "done")}${oauthProgressItem("pending", "Getting model list", "This can take a few seconds. Please keep this dialog open.", `every ${Math.round(pollMs / 1000)}s`)}` : oauthProgressItem("pending", `Waiting for ${flow.label}`, "Confirming the pasted redirect URL.", `every ${Math.round(pollMs / 1000)}s`)}</div>` : ""}
  </div>`;
}

function oauthCompleteBody(flow: PendingOAuthFlow): string {
  return `<div class="settings-oauth-card"><div class="settings-oauth-progress">${oauthProgressItem("done", `${flow.label} approval received`, "Your sign-in was accepted.", "done")}${oauthProgressItem("done", "Model list loaded", `${flow.label} models are ready to use.`, "done")}</div></div>`;
}

function oauthFlowModal(flow: PendingOAuthFlow): string {
  const pollMs = Math.max(1500, Math.min(15000, (flow.intervalSeconds ?? 3) * 1000));
  const body = flow.status === "complete"
    ? oauthCompleteBody(flow)
    : flow.status === "error"
      ? `<p class="settings-error">${escapeHtml(flow.error ?? "OAuth login failed")}</p>`
      : flow.verificationUri
        ? oauthDeviceCodeBody(flow, pollMs)
        : flow.authUrl
          ? oauthBrowserRedirectBody(flow, pollMs)
          : `<div class="settings-oauth-card"><div class="settings-oauth-progress">${oauthProgressItem("pending", "Starting OAuth flow", "Waiting for the provider to respond.", `every ${Math.round(pollMs / 1000)}s`)}</div></div>`;
  return `<dialog id="settings_flow_dialog" class="settings-flow-dialog" data-controller="modal oauth-flow" data-modal-auto-show-value="true" data-oauth-flow-status-url-value="/settings/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/status" data-oauth-flow-active-value="${flow.status === "pending" ? "true" : "false"}" data-oauth-flow-poll-ms-value="${pollMs}">
    <div class="settings-flow-head">${providerIcon(flow.provider, flow.label)}<div><b>Sign in with ${escapeHtml(flow.label)}</b><p>${flow.verificationUri ? "Device code" : "Browser redirect"}</p></div></div>
    <div class="settings-flow-body">${body}</div>
    <div class="settings-flow-actions settings-oauth-actions">
      ${flow.status === "complete" ? `<form method="post" action="/settings/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/finish" data-turbo="true"><button class="button primary" type="submit">Done</button></form>` : ""}
      ${flow.status === "pending" ? `<form method="post" action="/settings/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/cancel" data-turbo="true"><button class="button danger" type="submit">Cancel</button></form>` : ""}
      ${flow.status === "error" ? `<form method="post" action="/settings/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/finish" data-turbo="true"><button class="button secondary" type="submit">Close</button></form>` : ""}
    </div>
  </dialog>`;
}

async function refreshModelSetupSurfaces(): Promise<string> {
  return `${replaceTargets(".model-setup-surface-settings", await renderModelSetup("settings"))}${replaceTargets(".model-setup-surface-onboarding", await renderModelSetup("onboarding"))}${replace("model_setup_dialog", await renderModelSetupDialog())}`;
}

async function refreshAfterConnection(): Promise<string> {
  return `${await refreshModelSetupSurfaces()}${remove("settings_flow_dialog")}`;
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
    const runtime = await createPiModelRuntime();
    const label = runtime.getProvider(provider)?.name ?? provider;
    const form = await request.formData();
    const secret = String(form.get("secret") ?? "");
    try {
      await connectModelProviderApiKey(provider, secret);
      await addHardcodedProviderModels(provider);
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
  await setPickerAgentModels(current, current.find((model) => model.active));
  return stream(`${await refreshModelSetupSurfaces()}${pathname === "/settings/models/add" ? remove("settings_add_model_dialog") : ""}`);
}

export { githubRow };
