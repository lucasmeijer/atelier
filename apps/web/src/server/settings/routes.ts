import { clearWorkspaceGitHubToken, hasWorkspaceGitHubToken, setWorkspaceGitHubToken } from "@atelier/core";
import {
  configuredAgentModels,
  createPiAuthStorage,
  createPiModelRegistry,
  disconnectModelProvider,
  fakeConnectModelProvider,
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

function domId(...parts: string[]): string {
  return parts.join("_").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function wantsStream(request: Request): boolean {
  return request.headers.get("accept")?.includes("text/vnd.turbo-stream.html") ?? false;
}

async function hasAnyLlmProvider(): Promise<boolean> {
  return (await createPiAuthStorage()).list().length > 0;
}

export async function isOnboarded(): Promise<boolean> {
  return hasWorkspaceGitHubToken() || await hasAnyLlmProvider();
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
    <div class="settings-provider-main"><div class="settings-provider-title">GitHub ${badge(connected)}</div><div class="settings-provider-desc">Used by workspace creation and workspace secret injection as <code>GH_TOKEN</code>.</div></div>
    <div class="settings-provider-actions">${connected
      ? `<form method="post" action="/settings/github/disconnect" data-turbo="true"><button class="settings-btn danger" type="submit">Disconnect</button></form>`
      : `<form method="post" action="/settings/github/flow" data-turbo="true"><button class="settings-btn primary" type="submit">Connect GitHub</button></form>`}</div>
  </div>`;
}

async function providerSummaries(): Promise<Array<{ provider: string; label: string; connected: boolean; methods: string[]; modelCount: number }>> {
  const auth = await createPiAuthStorage();
  const registry = await createPiModelRegistry();
  const providers = new Map<string, { provider: string; label: string; connected: boolean; methods: string[]; modelCount: number }>();
  for (const model of registry.getAll() as Array<{ provider: string }>) {
    const provider = model.provider;
    const entry = providers.get(provider) ?? { provider, label: registry.getProviderDisplayName(provider), connected: false, methods: ["api_key"], modelCount: 0 };
    entry.modelCount += 1;
    entry.connected = registry.getProviderAuthStatus(provider).configured;
    providers.set(provider, entry);
  }
  for (const oauth of auth.getOAuthProviders() as Array<{ id: string; name?: string }>) {
    const entry = providers.get(oauth.id) ?? { provider: oauth.id, label: oauth.name ?? registry.getProviderDisplayName(oauth.id), connected: false, methods: [], modelCount: 0 };
    entry.methods = Array.from(new Set(["oauth", ...entry.methods]));
    entry.connected = registry.getProviderAuthStatus(oauth.id).configured;
    providers.set(oauth.id, entry);
  }
  return [...providers.values()].sort((a, b) => Number(b.connected) - Number(a.connected) || a.label.localeCompare(b.label));
}

function isSuperPopularProvider(provider: string): boolean {
  return provider === "anthropic" || provider === "openai-codex";
}

function providerRow(provider: { provider: string; label: string; connected: boolean; methods: string[]; modelCount: number }, surface: "settings" | "onboarding" = "settings"): string {
  const id = domId(surface, "provider", provider.provider);
  const methods = provider.methods.length ? provider.methods : ["api_key"];
  const hidden = !provider.connected && !isSuperPopularProvider(provider.provider);
  const modelCount = `${provider.modelCount} model${provider.modelCount === 1 ? "" : "s"}`;
  return `<div class="settings-provider${hidden ? " provider-extra hidden" : ""}" id="${id}" data-provider-extra="${hidden ? "true" : "false"}">
    <div class="settings-provider-icon" style="--provider-color:${providerColor(provider.provider)}">${escapeHtml(providerInitial(provider.label))}</div>
    <div class="settings-provider-main"><div class="settings-provider-title">${escapeHtml(provider.label)} <span class="settings-provider-count">${escapeHtml(modelCount)}</span>${provider.connected ? ` ${badge(true, "Connected")}` : ""}</div></div>
    <div class="settings-provider-actions">${provider.connected
      ? `<form method="post" action="/settings/providers/${encodeURIComponent(provider.provider)}/disconnect" data-turbo="true"><button class="settings-btn danger" type="submit">Disconnect</button></form>`
      : methods.map((method) => `<form method="post" action="/settings/providers/${encodeURIComponent(provider.provider)}/flow?method=${encodeURIComponent(method)}" data-turbo="true"><button class="settings-btn ${surface === "onboarding" ? "primary" : ""}" type="submit">${method === "oauth" ? "Sign in" : "Add API key"}</button></form>`).join("")}</div>
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

async function renderAgentSettings(): Promise<string> {
  const providers = await providerSummaries();
  const providerRows = providers.map((provider) => providerRow(provider)).join("");
  const picker = await renderModelPicker();
  return settingsSection("agent", "Agent & Models", `<h3 class="settings-subhead">Authentication providers</h3><div class="settings-providers" data-provider-list-scope>${providerRows}${showMoreProvidersButton(providers)}</div><h3 class="settings-subhead">Prompt model picker</h3>${picker}`, "Providers and models are discovered from the pi agent SDK. Connections are fake for now, but stored in pi-compatible auth storage.");
}

async function renderAbout(): Promise<string> {
  return settingsSection("about", "About", `<div class="settings-field"><div><b>Setup walkthrough</b><p>Reopen onboarding. It will be shown automatically whenever no GitHub or LLM provider is connected.</p></div><a class="settings-btn" href="/onboarding" data-turbo-frame="_top" data-turbo-stream="true">Replay</a></div><div class="settings-version">${escapeHtml(atelierName)} · settings prototype</div>`);
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

function flowModal(id: string, label: string, method: string, completeAction: string): string {
  const isApi = method === "api_key";
  return `<dialog id="settings_flow_dialog" class="settings-flow-dialog" data-controller="modal" data-modal-auto-show-value="true">
    <form method="post" action="${escapeHtml(completeAction)}" data-turbo="true" data-action="turbo:submit-end->modal#submitted">
      <div class="settings-flow-head"><div class="settings-provider-icon" style="--provider-color:${providerColor(id)}">${escapeHtml(providerInitial(label))}</div><div><b>${escapeHtml(label)}</b><p>Fake ${isApi ? "API key" : "OAuth/device"} connection</p></div></div>
      <div class="settings-flow-body">${isApi ? `<p>Paste any key. For now we store a fake credential in the real settings store.</p><input class="settings-input" type="password" name="secret" value="fake-secret" autofocus>` : `<p>In the real implementation this will open the provider authorization flow. For now, continue to store a fake connection.</p><div class="settings-code">WDJB-MJHT</div>`}</div>
      <div class="settings-flow-actions"><button class="settings-btn" formmethod="dialog">Cancel</button><button class="settings-btn primary" type="submit">Complete</button></div>
    </form>
  </dialog>`;
}

async function refreshAfterConnection(): Promise<string> {
  return `${replace("settings_dialog", await renderSettingsDialog("agent"))}${update("onboarding_modal_host", await renderOnboardingDialogIfNeeded())}${remove("settings_flow_dialog")}`;
}

export async function handleSettingsRequest(request: Request, url: URL): Promise<Response | undefined> {
  if (url.pathname === "/settings" && request.method === "GET") {
    const html = await renderSettingsDialog(url.searchParams.get("section") ?? "appearance");
    return wantsStream(request) ? stream(update("settings_modal_host", html)) : response(html);
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
    return stream(update("settings_modal_host", `${await renderSettingsDialog("agent")}${flowModal(provider, label, method, `/settings/providers/${encodeURIComponent(provider)}/connect?method=${encodeURIComponent(method)}`)}`));
  }
  match = url.pathname.match(/^\/settings\/providers\/([^/]+)\/connect$/);
  if (match && request.method === "POST") {
    await fakeConnectModelProvider(decodeURIComponent(match[1]!), url.searchParams.get("method") === "oauth" ? "oauth" : "api_key");
    return stream(await refreshAfterConnection());
  }
  match = url.pathname.match(/^\/settings\/providers\/([^/]+)\/disconnect$/);
  if (match && request.method === "POST") {
    await disconnectModelProvider(decodeURIComponent(match[1]!));
    return stream(await refreshAfterConnection());
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
