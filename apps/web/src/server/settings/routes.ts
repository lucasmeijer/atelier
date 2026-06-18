import { clearWorkspaceGitHubToken, hasWorkspaceGitHubToken, setWorkspaceGitHubToken } from "@atelier/core";
import {
  configuredAgentModels,
  connectModelProviderApiKey,
  createPiAuthStorage,
  createPiModelRegistry,
  disconnectModelProvider,
  setActiveAgentModel,
  setPickerAgentModels,
  type ConfiguredAgentModel,
} from "@atelier/agent/server";
import { atelierName } from "@atelier/shared";
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

export async function hasAnyLlmProvider(): Promise<boolean> {
  return (await createPiAuthStorage()).list().length > 0;
}

export async function isOnboarded(): Promise<boolean> {
  return hasWorkspaceGitHubToken() && await hasAnyLlmProvider();
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
    fable: "#a855f7",
  };
  return colors[provider] ?? `hsl(${[...provider].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360} 52% 54%)`;
}

function providerInitial(label: string): string {
  return (label.trim()[0] ?? "?").toUpperCase();
}

function settingsSection(id: string, title: string, body: string, subtitle = ""): string {
  return `<section class="settings-sec" id="settings-sec-${escapeHtml(id)}"><h2>${escapeHtml(title)}</h2>${subtitle ? `<p class="settings-sub">${escapeHtml(subtitle)}</p>` : ""}${body}</section>`;
}

function githubRow(): string {
  const connected = hasWorkspaceGitHubToken();
  return `<div class="settings-provider" id="settings_provider_github">
    <div class="settings-provider-icon" style="--provider-color:${providerColor("github")}">G</div>
    <div class="settings-provider-main"><div class="settings-provider-title">GitHub ${badge(connected)}</div></div>
    <div class="settings-provider-actions">${connected
      ? `<form method="post" action="/settings/github/disconnect" data-turbo="true"><button class="settings-btn danger" type="submit">Disconnect</button></form>`
      : `<form method="post" action="/settings/github/flow" data-turbo="true"><button class="settings-btn primary" type="submit">Connect</button></form>`}</div>
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
  const actions = provider.stored
    ? `<form method="post" action="/settings/providers/${encodeURIComponent(provider.provider)}/disconnect" data-turbo="true"><button class="settings-btn danger" type="submit">Disconnect</button></form>`
    : provider.connected
      ? `<span class="settings-provider-desc">Managed outside Atelier</span>`
      : methods.map((method) => `<form method="post" action="/settings/providers/${encodeURIComponent(provider.provider)}/flow?method=${encodeURIComponent(method)}" data-turbo="true"><button class="settings-btn ${surface === "onboarding" ? "primary" : ""}" type="submit">${method === "oauth" ? "Sign in" : "Add API key"}</button></form>`).join("");
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

async function renderAppearance(): Promise<string> {
  const themes = [["daylight", "Daylight"], ["solarized-light", "Solarized Light"], ["cappuccino", "Cappuccino"], ["tokyo-night", "Tokyo Night"], ["midnight", "Midnight"], ["nord", "Nord"]];
  return settingsSection("appearance", "Appearance", `<div class="settings-field"><div><b>Theme</b><p>Stored in this browser.</p></div><select class="settings-select" data-controller="theme-select">${themes.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></div>`);
}

async function renderWorkspaceSettings(): Promise<string> {
  return settingsSection("workspaces", "Workspaces", `<div class="settings-providers">${githubRow()}</div>`, "Connect services used to create and provision workspaces.");
}

async function renderProviderList(surface: "settings" | "onboarding" = "settings"): Promise<string> {
  const providers = await providerSummaries();
  const id = surface === "settings" ? ` id="settings_agent_provider_list"` : "";
  return `<div${id} class="settings-providers" data-provider-list-scope>${providers.map((provider) => providerRow(provider, surface)).join("")}${showMoreProvidersButton(providers)}</div>`;
}

async function renderAgentSettings(): Promise<string> {
  const picker = await renderModelPicker();
  return settingsSection("agent", "Agent & Models", `<h3 class="settings-subhead">Authentication providers</h3>${await renderProviderList("settings")}<h3 class="settings-subhead">Prompt model picker</h3>${picker}`, "Providers and models are discovered from the pi agent SDK. Credentials are stored in pi-compatible auth storage.");
}

async function renderAbout(): Promise<string> {
  const devTools = devSettingsEnabled() ? `<form class="settings-reset-form" method="post" action="/settings/workspaces/force-delete/flow" data-turbo="true"><button class="settings-reset-link danger" type="submit">force delete all workspaces</button></form>` : "";
  return settingsSection("about", "About", `<div class="settings-field"><div><b>Setup walkthrough</b><p>Reopen onboarding. It will be shown automatically whenever no GitHub or LLM provider is connected.</p></div><a class="settings-btn" href="/onboarding" data-turbo-frame="_top" data-turbo-stream="true">Replay</a></div><div class="settings-version">${escapeHtml(atelierName)} · settings prototype</div><form class="settings-reset-form" method="post" action="/settings/reset" data-turbo="true"><button class="settings-reset-link" type="submit" onclick="return confirm('Delete stored GitHub token and all stored model provider credentials?')">delete all settings</button></form>${devTools}`);
}

async function availableModelOptions(): Promise<ConfiguredAgentModel[]> {
  const registry = await createPiModelRegistry();
  const all = registry.getAll() as Array<{ provider: string; id: string; name?: string }>;
  return all.map((model) => ({ provider: model.provider, id: model.id, label: model.name ?? model.id }));
}

async function renderModelPicker(): Promise<string> {
  const configured = [...configuredAgentModels];
  const have = new Set(configured.map((model) => `${model.provider}::${model.id}`));
  const available = (await availableModelOptions()).filter((model) => !have.has(`${model.provider}::${model.id}`)).slice(0, 120);
  return `<div id="settings_model_picker"><div class="settings-models" data-controller="model-picker">${configured.length ? configured.map((model, index) => modelPickerRow(model, index, configured.length)).join("") : `<div class="settings-empty">No models in the picker.</div>`}</div>
  <details class="settings-add-model" data-controller="model-add-menu">
    <summary class="settings-btn">＋ Add model</summary>
    <div class="settings-add-model-backdrop" data-action="click->model-add-menu#close"></div>
    <div class="settings-add-model-menu">
      <div class="settings-add-model-head"><b>Add model</b><button class="settings-btn icon" type="button" data-action="model-add-menu#close">×</button></div>
      <input class="settings-input settings-model-filter" type="search" placeholder="Filter models…" data-model-add-menu-target="filter" data-action="input->model-add-menu#filter" autocomplete="off">
      <div class="settings-add-model-options" data-model-add-menu-target="options">
        ${available.map((model) => `<form method="post" action="/settings/models/add" data-turbo="true" data-model-add-menu-target="option" data-search-text="${escapeHtml(`${model.label} ${model.provider} ${model.id}`.toLowerCase())}"><input type="hidden" name="model" value="${escapeHtml(`${model.provider}::${model.id}`)}"><button class="settings-add-model-option" type="submit"><span>${escapeHtml(model.label)}</span><small>${escapeHtml(model.provider)} · ${escapeHtml(model.id)}</small></button></form>`).join("")}
      </div>
    </div>
  </details></div>`;
}

function modelPickerRow(model: ConfiguredAgentModel, _index: number, _total: number): string {
  const value = `${model.provider}::${model.id}`;
  return `<div class="settings-model-row" id="${domId("settings_model", model.provider, model.id)}" draggable="true" data-model-picker-model-value="${escapeHtml(value)}" data-action="dragstart->model-picker#dragStart dragover->model-picker#dragOver drop->model-picker#drop dragend->model-picker#dragEnd">
    <span class="settings-model-grip" aria-hidden="true">⠿</span>
    <span class="settings-model-dot" style="--provider-color:${providerColor(model.provider)}"></span>
    <div class="settings-model-main"><code>${escapeHtml(model.id)}</code><small>${escapeHtml(model.provider)}</small></div>
    <div class="settings-provider-actions"><form method="post" action="/settings/models/remove" data-turbo="true"><input type="hidden" name="model" value="${escapeHtml(value)}"><button class="settings-btn danger icon" type="submit">×</button></form></div>
  </div>`;
}

registerSettingsContribution({ id: "appearance", label: "Appearance", order: 10, render: renderAppearance });
registerSettingsContribution({ id: "workspaces", label: "Workspaces", order: 20, render: renderWorkspaceSettings });
registerSettingsContribution({ id: "agent", label: "Agent & Models", order: 30, render: renderAgentSettings });
registerSettingsContribution({ id: "about", label: "About", order: 90, render: renderAbout });

export async function renderSettingsDialog(active = "appearance"): Promise<string> {
  const contributions = listSettingsContributions();
  const sections = await Promise.all(contributions.map((contribution) => contribution.render()));
  return `<dialog id="settings_dialog" class="settings-dialog" data-controller="modal" data-modal-auto-show-value="true">
    <div class="settings-sheet">
      <aside class="settings-side"><div class="settings-title">Settings</div>${contributions.map((contribution) => `<a class="settings-nav ${contribution.id === active ? "active" : ""}" href="#settings-sec-${escapeHtml(contribution.id)}">${escapeHtml(contribution.label)}</a>`).join("")}<div class="settings-side-fill"></div><div class="settings-version">atelier</div></aside>
      <main class="settings-main"><form method="dialog"><button class="settings-close" value="close">✕</button></form>${sections.join("")}</main>
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

function githubTokenModal(error = ""): string {
  return `<dialog id="settings_flow_dialog" class="settings-flow-dialog" data-controller="modal" data-modal-auto-show-value="true">
    <form method="post" action="/settings/github/connect" data-turbo="true">
      <div class="settings-flow-head"><div class="settings-provider-icon" style="--provider-color:${providerColor("github")}">G</div><div><b>GitHub</b><p>GitHub CLI token</p></div></div>
      <div class="settings-flow-body">
        <p>On your machine, sign in with GitHub CLI if needed, then print your token:</p>
        <pre class="settings-command">gh auth login
gh auth token</pre>
        <p>Paste the token output below. Atelier stores it locally and injects it into workspace GitHub requests as <code>GH_TOKEN</code>.</p>
        ${error ? `<p class="settings-error">${escapeHtml(error)}</p>` : ""}
        <input class="settings-input" type="password" name="token" placeholder="Paste output from gh auth token" autocomplete="off" required autofocus>
      </div>
      <div class="settings-flow-actions"><button class="settings-btn" formmethod="dialog">Cancel</button><button class="settings-btn primary" type="submit">Connect</button></div>
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
    onDeviceCode: (info) => { flow.userCode = info.userCode; flow.verificationUri = info.verificationUri; },
    onProgress: (message) => { flow.progress = [...flow.progress.slice(-4), message]; },
    onPrompt: (prompt) => new Promise<string>((resolve) => {
      if (prompt.allowEmpty) return resolve("");
      flow.prompt = { message: prompt.message, placeholder: prompt.placeholder, allowEmpty: prompt.allowEmpty, resolve };
    }),
    onManualCodeInput: () => new Promise<string>((resolve) => {
      flow.prompt = { message: "Paste the authorization code from the browser", placeholder: "Authorization code", resolve };
    }),
    onSelect: async (prompt) => prompt.options.find((option) => option.id === "device_code")?.id ?? prompt.options[0]?.id,
    signal: flow.abort.signal,
  }).then(() => {
    flow.status = "complete";
    flow.progress = [...flow.progress.slice(-4), "Connected."];
  }).catch((error) => {
    if (flow.abort.signal.aborted) return;
    flow.status = "error";
    flow.error = error instanceof Error ? error.message : String(error);
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
  const auth = flow.verificationUri
    ? `<p class="settings-oauth-instructions">Open <a class="settings-link" href="${escapeHtml(flow.verificationUri)}" target="_blank" rel="noreferrer">${escapeHtml(flow.verificationUri)}</a> and enter:</p><div class="settings-code-row" data-controller="clipboard"><div class="settings-code compact" data-clipboard-target="source">${escapeHtml(flow.userCode ?? "")}</div><button class="settings-btn" type="button" data-action="clipboard#copy">Copy to clipboard</button></div>`
    : flow.authUrl
      ? `<p><a class="settings-btn primary" href="${escapeHtml(flow.authUrl)}" target="_blank" rel="noreferrer">Open authorization page</a></p>${flow.instructions ? `<p>${escapeHtml(flow.instructions)}</p>` : ""}`
      : `<p>Starting OAuth flow…</p>`;
  const prompt = flow.prompt && flow.status === "pending"
    ? `<form method="post" action="/settings/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/prompt" data-turbo="true"><p>${escapeHtml(flow.prompt.message)}</p><input class="settings-input" name="value" placeholder="${escapeHtml(flow.prompt.placeholder ?? "")}" ${flow.prompt.allowEmpty ? "" : "required"}><div class="settings-flow-actions"><button class="settings-btn primary" type="submit">Submit</button></div></form>`
    : "";
  const progress = flow.progress.length ? `<ul class="settings-flow-progress">${flow.progress.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "";
  return `<dialog id="settings_flow_dialog" class="settings-flow-dialog" data-controller="modal oauth-flow" data-modal-auto-show-value="true" data-oauth-flow-status-url-value="/settings/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/status" data-oauth-flow-active-value="${flow.status === "pending" ? "true" : "false"}">
    <div class="settings-flow-head"><div class="settings-provider-icon" style="--provider-color:${providerColor(flow.provider)}">${escapeHtml(providerInitial(flow.label))}</div><div><b>${escapeHtml(flow.label)}</b><p>OAuth sign-in</p></div></div>
    <div class="settings-flow-body">${statusBody}${flow.status === "pending" ? auth : ""}${progress}${prompt}</div>
    <div class="settings-flow-actions">
      ${flow.status === "complete" ? `<form method="post" action="/settings/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/finish" data-turbo="true"><button class="settings-btn primary" type="submit">Done</button></form>` : ""}
      ${flow.status === "pending" ? `<form method="post" action="/settings/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/cancel" data-turbo="true"><button class="settings-btn danger" type="submit">Cancel</button></form>` : ""}
      ${flow.status === "error" ? `<form method="post" action="/settings/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/finish" data-turbo="true"><button class="settings-btn" type="submit">Close</button></form>` : ""}
    </div>
  </dialog>`;
}

async function refreshAfterConnection(): Promise<string> {
  return `${replace("settings_dialog", await renderSettingsDialog("agent"))}${update("onboarding_modal_host", await renderOnboardingDialogIfNeeded())}${remove("settings_flow_dialog")}`;
}

async function deleteAllStoredSettings(): Promise<void> {
  clearWorkspaceGitHubToken();
  const auth = await createPiAuthStorage();
  for (const provider of auth.list()) auth.remove(provider);
}

export async function handleSettingsRequest(request: Request, url: URL, options: { forceDeleteAllWorkspaces?: () => Promise<{ deleted: number; errors: string[] }> } = {}): Promise<Response | undefined> {
  if (url.pathname === "/settings" && request.method === "GET") {
    const html = await renderSettingsDialog(url.searchParams.get("section") ?? "appearance");
    return wantsStream(request) ? stream(update("settings_modal_host", html)) : response(html);
  }
  if (url.pathname === "/settings/reset" && request.method === "POST") {
    await deleteAllStoredSettings();
    return stream(`${replace("settings_dialog", await renderSettingsDialog("about"))}${update("onboarding_modal_host", await renderOnboardingDialogIfNeeded())}${remove("settings_flow_dialog")}`);
  }
  if (url.pathname === "/settings/workspaces/force-delete/flow" && request.method === "POST" && devSettingsEnabled()) {
    return stream(append("settings_modal_host", forceDeleteAllWorkspacesModal()));
  }
  if (url.pathname === "/settings/workspaces/force-delete" && request.method === "POST" && devSettingsEnabled()) {
    if (!options.forceDeleteAllWorkspaces) return stream(replace("settings_dev_force_delete_workspaces_dialog", forceDeleteAllWorkspacesModal("Workspace deletion is not available.")));
    const result = await options.forceDeleteAllWorkspaces();
    return stream(replace("settings_dev_force_delete_workspaces_dialog", forceDeleteAllWorkspacesResultModal(result.deleted, result.errors)));
  }
  if (url.pathname === "/settings/github/flow" && request.method === "POST") return stream(update("settings_modal_host", `${await renderSettingsDialog("workspaces")}${githubTokenModal()}`));
  if (url.pathname === "/settings/github/connect" && request.method === "POST") {
    const form = await request.formData();
    const token = String(form.get("token") ?? "").trim();
    const validation = await validateGitHubToken(token);
    if (!validation.ok) return stream(replace("settings_flow_dialog", githubTokenModal(validation.message)));
    setWorkspaceGitHubToken(token);
    return stream(`${replace("settings_dialog", await renderSettingsDialog("workspaces"))}${update("onboarding_modal_host", await renderOnboardingDialogIfNeeded())}${remove("settings_flow_dialog")}`);
  }
  if (url.pathname === "/settings/github/disconnect" && request.method === "POST") {
    clearWorkspaceGitHubToken();
    return stream(`${replace("settings_dialog", await renderSettingsDialog("workspaces"))}${update("onboarding_modal_host", await renderOnboardingDialogIfNeeded())}`);
  }
  let match = url.pathname.match(/^\/settings\/providers\/([^/]+)\/flow$/);
  if (match && request.method === "POST") {
    const provider = decodeURIComponent(match[1]!);
    const method = url.searchParams.get("method") ?? "api_key";
    const registry = await createPiModelRegistry();
    const label = registry.getProviderDisplayName(provider);
    if (method === "oauth") {
      try {
        const flow = await startOAuthFlow(provider, label);
        return stream(update("settings_modal_host", `${await renderSettingsDialog("agent")}${oauthFlowModal(flow)}`));
      } catch (error) {
        return stream(update("settings_modal_host", `${await renderSettingsDialog("agent")}${apiKeyModal(provider, label, `/settings/providers/${encodeURIComponent(provider)}/connect`, error instanceof Error ? error.message : String(error))}`));
      }
    }
    return stream(update("settings_modal_host", `${await renderSettingsDialog("agent")}${apiKeyModal(provider, label, `/settings/providers/${encodeURIComponent(provider)}/connect`)}`));
  }
  match = url.pathname.match(/^\/settings\/providers\/([^/]+)\/connect$/);
  if (match && request.method === "POST") {
    const provider = decodeURIComponent(match[1]!);
    const registry = await createPiModelRegistry();
    const label = registry.getProviderDisplayName(provider);
    const form = await request.formData();
    const secret = String(form.get("secret") ?? "");
    try {
      await connectModelProviderApiKey(provider, secret);
    } catch (error) {
      return stream(replace("settings_flow_dialog", apiKeyModal(provider, label, `/settings/providers/${encodeURIComponent(provider)}/connect`, error instanceof Error ? error.message : String(error))));
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
    return stream(`${replace("settings_agent_provider_list", await renderProviderList("settings"))}${update("onboarding_modal_host", await renderOnboardingDialogIfNeeded())}`);
  }
  if (url.pathname.startsWith("/settings/models/") && request.method === "POST") return await handleModelPickerAction(request, url.pathname);
  return undefined;
}

async function handleModelPickerAction(request: Request, pathname: string): Promise<Response> {
  if (pathname === "/settings/models/reorder") {
    const body = await request.json().catch(() => undefined) as { models?: unknown } | undefined;
    const requested = Array.isArray(body?.models) ? body.models.map(String) : [];
    const byKey = new Map(configuredAgentModels.map((model) => [`${model.provider}::${model.id}`, model]));
    const reordered = requested.map((key) => byKey.get(key)).filter(Boolean) as ConfiguredAgentModel[];
    for (const model of configuredAgentModels) if (!requested.includes(`${model.provider}::${model.id}`)) reordered.push(model);
    await setPickerAgentModels(reordered, configuredAgentModels.find((model) => model.active));
    return stream(replace("settings_model_picker", await renderModelPicker()));
  }

  const form = await request.formData();
  const split = String(form.get("model") ?? "").split("::");
  const provider = split[0] ?? "";
  const id = split[1] ?? "";
  const current = [...configuredAgentModels];
  const index = current.findIndex((model) => model.provider === provider && model.id === id);
  if (pathname === "/settings/models/add" && provider && id && index < 0) {
    const option = (await availableModelOptions()).find((model) => model.provider === provider && model.id === id);
    current.push(option ?? { provider, id, label: id });
  }
  if (pathname === "/settings/models/remove" && index >= 0) current.splice(index, 1);
  if (pathname === "/settings/models/active" && provider && id) await setActiveAgentModel(provider, id);
  else await setPickerAgentModels(current, current.find((model) => model.active));
  return stream(replace("settings_model_picker", await renderModelPicker()));
}

export { providerRow, providerSummaries, githubRow, showMoreProvidersButton };
