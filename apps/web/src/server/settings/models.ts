import { actionItemHtml } from "@atelier/design-system/action-item";
import { actionLinkHtml } from "@atelier/design-system/action-link";
import { buttonHtml } from "@atelier/design-system/button";
import { copyButtonHtml } from "@atelier/design-system/copy-button";
import { destructiveConfirmationHtml } from "@atelier/design-system/destructive-confirmation";
import { dialogHtml } from "@atelier/design-system/dialog";
import { Icons } from "@atelier/design-system/icons";
import {
  connectModelProviderApiKey,
  ProviderCatalogueRefreshError,
  createPiModelRuntime,
  disconnectModelProvider,
  getConfiguredAgentModels,
  getCustomModelsJson,
  getPopularModelRank,
  getPopularProviderRank,
  getProviderApiKeyExample,
  hasAvailableConfiguredAgentModel,
  modelRefValue as modelKey,
  parseModelRef,
  loginPiOAuthProvider,
  setCustomModelsJson,
  setPickerAgentModels,
  type ConfiguredAgentModel,
  type PiAuthPrompt,
} from "@atelier/agent/server";
import { domId, escapeHtml } from "@atelier/shared";
import { append, remove, replace, replaceTargets, response, stream, update, wantsStream } from "./http.ts";
import { registerSettingsContribution } from "./registry.ts";
import { providerIcon, type SettingsSurface } from "./views.ts";

const providerDisconnectConfirmation = destructiveConfirmationHtml({
  trigger: { type: "button", variant: "danger", content: { kind: "caption", caption: "Disconnect" } },
  confirmCaption: "Disconnect",
  cancelCaption: "Cancel",
});

type ProviderSummary = { provider: string; label: string; connected: boolean; methods: string[] };

async function providerSummaries(): Promise<ProviderSummary[]> {
  const runtime = await createPiModelRuntime();
  return runtime.getProviders().map((provider): ProviderSummary => {
    const status = runtime.getProviderAuthStatus(provider.id);
    return {
      provider: provider.id,
      label: provider.name ?? provider.id,
      connected: status.configured,
      methods: [provider.auth.oauth && "oauth", provider.auth.apiKey?.login && "api_key"].filter((method): method is string => Boolean(method)),
    };
  }).sort((a, b) => (getPopularProviderRank(a.provider) ?? Number.MAX_SAFE_INTEGER) - (getPopularProviderRank(b.provider) ?? Number.MAX_SAFE_INTEGER) || a.label.localeCompare(b.label));
}

type ModelSetupSurface = SettingsSurface | "dialog";
const modelSetupSurfaces: readonly ModelSetupSurface[] = ["settings", "onboarding", "dialog"];

type ModelCatalogueEntry = ConfiguredAgentModel & { configured: boolean };

type ModelSetupData = { providers: ProviderSummary[]; working: boolean };

async function modelSetupData(): Promise<ModelSetupData> {
  return { providers: await providerSummaries(), working: await hasAvailableConfiguredAgentModel() };
}

async function providerCatalogue(provider: string): Promise<ModelCatalogueEntry[]> {
  const runtime = await createPiModelRuntime();
  const favorites = (await getConfiguredAgentModels()).filter((model) => model.provider === provider);
  const favoriteById = new Map(favorites.map((model) => [model.id, model]));
  const models = new Map(runtime.getModels(provider).map((model): [string, ModelCatalogueEntry] => [model.id, {
    provider, id: model.id, label: favoriteById.get(model.id)?.label ?? model.name ?? model.id, configured: favoriteById.has(model.id),
  }]));
  // Keep unavailable favorites visible so they can still be removed.
  for (const model of favorites) {
    if (!models.has(model.id)) models.set(model.id, { ...model, configured: true });
  }
  return [...models.values()].sort((a, b) => Number(b.configured) - Number(a.configured)
    || (getPopularModelRank(provider, a.id) ?? Number.MAX_SAFE_INTEGER) - (getPopularModelRank(provider, b.id) ?? Number.MAX_SAFE_INTEGER)
    || a.label.localeCompare(b.label));
}

function providerAuthAction(provider: ProviderSummary, method: string, surface: ModelSetupSurface): string {
  return `/settings/providers/${encodeURIComponent(provider.provider)}/flow?method=${encodeURIComponent(method)}${surface === "onboarding" ? "&surface=onboarding" : ""}`;
}

function providerAuthenticationActions(provider: ProviderSummary, surface: ModelSetupSurface): string {
  return provider.methods.map((method) => `<form method="post" action="${providerAuthAction(provider, method, surface)}" data-turbo="true">${buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: method === "oauth" ? "Sign in" : "Add API Key" } })}</form>`).join("");
}

function providerListFrameId(surface: ModelSetupSurface): string {
  return domId("model_providers", surface);
}

function groupModelProviders(providers: ProviderSummary[]) {
  const popular = providers.filter((provider) => getPopularProviderRank(provider.provider) !== undefined).slice(0, 4);
  return { popular, other: providers.filter((provider) => !popular.includes(provider)) };
}

function renderProviderList(providers: ProviderSummary[], surface: ModelSetupSurface, query = ""): string {
  const normalized = query.trim().toLowerCase();
  const matching = providers.filter((provider) => `${provider.label} ${provider.provider}`.toLowerCase().includes(normalized));
  return `<turbo-frame id="${providerListFrameId(surface)}"><div class="model-providers" tabindex="0" role="region" aria-label="Other model providers">${matching.map((provider) => renderProvider(provider, surface)).join("") || '<div class="managed-list__empty" role="status">No matching providers.</div>'}</div></turbo-frame>`;
}

function providerFrameId(surface: ModelSetupSurface, provider: string): string {
  return domId("model_provider_models", surface, provider);
}

function favoriteAction(model: ModelCatalogueEntry, surface: ModelSetupSurface): string {
  return `<form class="${domId("model_favorite", surface, model.provider, model.id)}" method="post" action="/settings/models/${model.configured ? "remove" : "add"}" data-turbo="true">
    <input type="hidden" name="model" value="${escapeHtml(modelKey(model))}">
    ${buttonHtml({ type: "submit", variant: "secondary", content: { kind: "icon-only", iconHtml: model.configured ? Icons.StarFilled : Icons.Star, label: `${model.configured ? "Unfavorite" : "Favorite"} ${model.label}` }, attributesHtml: `aria-pressed="${model.configured}"` })}
  </form>`;
}

function renderProviderModels(catalogue: ModelCatalogueEntry[], surface: ModelSetupSurface, provider: ProviderSummary, query: string): string {
  const normalized = query.trim().toLowerCase();
  const models = catalogue.filter((model) => `${model.label} ${model.id}`.toLowerCase().includes(normalized));
  const rows = models.map((model) => `<div class="model-favorite-row"><span class="model-favorite-name" title="${escapeHtml(model.id)}">${escapeHtml(model.label)}</span>${favoriteAction(model, surface)}</div>`).join("");
  return `<turbo-frame class="model-provider-results" id="${providerFrameId(surface, provider.provider)}"><div class="model-provider-models" tabindex="0" role="region" aria-label="${escapeHtml(provider.label)} models">${rows || '<div class="managed-list__empty">No matching models.</div>'}</div></turbo-frame>`;
}

function renderProvider(provider: ProviderSummary, surface: ModelSetupSurface, open = false): string {
  const id = domId("model_provider", surface, provider.provider);
  const frameId = providerFrameId(surface, provider.provider);
  const catalogueUrl = `/settings/models/catalogue?surface=${surface}&provider=${encodeURIComponent(provider.provider)}`;
  const connection = provider.connected
    ? `<span class="model-provider-status"><span class="status-dot success" aria-hidden="true"></span> Connected</span><form method="post" action="/settings/providers/${encodeURIComponent(provider.provider)}/disconnect" data-turbo="true">${providerDisconnectConfirmation}</form>`
    : `<div class="model-provider-auth-methods">${providerAuthenticationActions(provider, surface)}</div>`;
  return `<section id="${id}" data-provider-accordion-target="provider">
    <div class="model-provider-header"><div class="model-provider-name">${actionItemHtml({ kind: "single", element: { tag: "button", attributesHtml: `type="button" aria-expanded="${open}" aria-controls="${id}_body" data-action="provider-accordion#toggle"` }, label: { kind: "text", text: provider.label }, leadingHtml: Icons.Disclosure })}</div>${connection}</div>
    <div class="model-provider-body" id="${id}_body"${open ? "" : " hidden"}>
      ${provider.connected ? `<div class="managed-list" data-managed-list-server-filter="true"><form class="managed-list__filter" method="get" action="/settings/models/catalogue" data-controller="server-filter" data-action="input->server-filter#submit" data-turbo-frame="${frameId}">
        <input type="hidden" name="surface" value="${surface}"><input type="hidden" name="provider" value="${escapeHtml(provider.provider)}">
        <input class="text-field" type="search" name="q" placeholder="Filter models…" aria-label="Filter ${escapeHtml(provider.label)} models" autocomplete="off">
        <button type="submit" hidden>Filter models</button>
      </form><turbo-frame class="model-provider-results" id="${frameId}" src="${escapeHtml(catalogueUrl)}" loading="lazy"><div class="managed-list__empty" role="status">Loading models…</div></turbo-frame></div>` : '<p class="model-provider-connection-note">Connect this provider first.</p>'}
    </div>
  </section>`;
}

const customModelsPlaceholder = `{
  "providers": {
    "openai-codex": {
      "models": [
        {
          "id": "gpt-6-astra",
          "name": "GPT-6 Astra",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 272000,
          "maxTokens": 128000
        }
      ]
    }
  }
}`;

type CustomModelsView = { source: string; open?: boolean; error?: string; status?: string };

function renderCustomModelsSettings(view: CustomModelsView): string {
  const saveButton = buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "Validate and save" } });
  const refreshButton = buttonHtml({
    type: "submit",
    variant: "secondary",
    content: { kind: "caption", caption: "Refresh model catalogue" },
    attributesHtml: 'data-turbo-submits-with="Refreshing…"',
  });
  return `<details class="custom-models-settings" id="custom_models_settings"${view.open ? " open" : ""}>
    <summary>Advanced model settings</summary>
    <form method="post" action="/settings/models/catalogue/refresh" data-turbo="true">${refreshButton}</form>
    <form class="custom-models-form form-stack" method="post" action="/settings/models/custom" data-turbo="true">
      <div><label for="custom_models_json">Custom Pi model configuration</label><p>Paste a Pi <code>models.json</code> object containing <code>providers</code>. Custom models are merged with the official catalogue.</p></div>
      <textarea class="textarea custom-models-json" id="custom_models_json" name="models" placeholder="${escapeHtml(customModelsPlaceholder)}" spellcheck="false" autocomplete="off">${escapeHtml(view.source)}</textarea>
      ${view.error ? `<p class="settings-error" role="alert">${escapeHtml(view.error)}</p>` : ""}
      ${view.status ? `<p class="custom-models-status" role="status">${escapeHtml(view.status)}</p>` : ""}
      <div class="custom-models-actions">${saveButton}</div>
    </form>
  </details>`;
}

function renderModelSetupData(data: ModelSetupData, surface: ModelSetupSurface, customModels?: CustomModelsView): string {
  const working = data.working;
  const { popular, other } = groupModelProviders(data.providers);
  const id = surface === "dialog" ? "model_setup_dialog_content" : `model_setup_${surface}`;
  return `<div class="model-setup form-stack" id="${id}">
    ${modelSetupWorkingState(working)}
    <div class="model-provider-groups" data-controller="provider-accordion">
      <div class="model-popular-providers">${popular.map((provider, index) => renderProvider(provider, surface, index === 0 && provider.connected)).join("")}</div>
      <details>
        ${actionItemHtml({ kind: "single", element: { tag: "summary" }, label: { kind: "text", text: "Other providers" }, leadingHtml: Icons.Disclosure })}
        <div class="model-other-providers-body">
          <form method="get" action="/settings/models/providers" data-controller="server-filter" data-action="input->server-filter#submit" data-turbo-frame="${providerListFrameId(surface)}">
            <input type="hidden" name="surface" value="${surface}">
            <input class="text-field" type="search" name="q" placeholder="Filter providers…" aria-label="Filter other providers" autocomplete="off">
            <button type="submit" hidden>Filter providers</button>
          </form>
          ${renderProviderList(other, surface)}
        </div>
      </details>
    </div>
    ${surface === "settings" && customModels ? renderCustomModelsSettings(customModels) : ""}
  </div>`;
}

export async function renderModelSetup(surface: ModelSetupSurface = "settings", customModelsView?: Omit<CustomModelsView, "source">): Promise<string> {
  const customModels = surface === "settings" ? { source: await getCustomModelsJson(), ...customModelsView } : undefined;
  return renderModelSetupData(await modelSetupData(), surface, customModels);
}

export async function renderModelSetupDialog(): Promise<string> {
  const data = await modelSetupData();
  return dialogHtml({
    element: { id: "model_setup_dialog", attributesHtml: "data-dialog-auto-show" },
    iconHtml: Icons.Settings,
    titleCaption: "Configure models",
    bodyHtml: renderModelSetupData(data, "dialog"),
    footerHtml: `<form method="dialog">${modelSetupDialogButton(data.working)}</form>`,
  });
}

async function renderModelSetupSettings(): Promise<string> {
  return `<section class="settings-sec settings-sec-models" id="settings-sec-models">${await renderModelSetup("settings")}</section>`;
}

registerSettingsContribution({ id: "models", label: "Models", order: 40, render: renderModelSetupSettings });

function apiKeyModal(id: string, label: string, surface: SettingsSurface, error = ""): string {
  const inputId = domId("provider_api_key", id);
  const formId = domId("provider_api_key_form", id);
  const action = `/settings/providers/${encodeURIComponent(id)}/connect${surface === "onboarding" ? "?surface=onboarding" : ""}`;
  const cancelButton = buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "Cancel" } });
  const connectButton = buttonHtml({
    type: "submit",
    variant: "primary",
    content: { kind: "caption", caption: "Connect" },
    attributesHtml: `form="${formId}"`,
  });
  return dialogHtml({
    element: {
      id: "settings_flow_dialog",
      attributesHtml: "data-dialog-auto-show",
    },
    iconHtml: providerIcon(id, label),
    titleCaption: `Connect ${label}`,
    bodyHtml: `<form id="${formId}" class="form-stack" method="post" action="${action}" data-turbo="true">
      ${error ? `<p class="settings-error">${escapeHtml(error)}</p>` : ""}
      <label for="${inputId}">API key</label>
      <input id="${inputId}" class="settings-input text-field" type="password" name="secret" placeholder="${escapeHtml(getProviderApiKeyExample(id) ?? "API key")}" autocomplete="off" required autofocus>
    </form>`,
    footerHtml: `<form method="dialog">${cancelButton}</form>${connectButton}`,
  });
}

type PendingPrompt = { input: Exclude<PiAuthPrompt, { type: "select" }>; resolve: (value: string) => void; reject: (error: Error) => void };
type PendingOAuthFlow = {
  id: string;
  provider: string;
  label: string;
  status: "pending" | "complete" | "error";
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
  const flow: PendingOAuthFlow = { id: crypto.randomUUID(), provider, label, status: "pending", abort: new AbortController() };
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
    flow.prompt = { input: prompt, resolve: finish, reject: fail };
  });
}

async function waitForOAuthFlowReady(flow: PendingOAuthFlow): Promise<void> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline && flow.status === "pending" && !flow.authUrl && !flow.verificationUri && !flow.prompt) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function oauthStatus(kind: "pending" | "done", title: string, detail: string): string {
  return `<ul class="status-list"><li class="status-list__item" ${kind === "done" ? 'role="checkbox" aria-checked="true"' : 'aria-busy="true"'}><span class="status-list__marker">${kind === "done" ? "✓" : ""}</span><span>${escapeHtml(title)} — ${escapeHtml(detail)}</span></li></ul>`;
}

function oauthAuthenticationAction(flow: PendingOAuthFlow, url: string, hidden = false): string {
  const authenticationName = flow.provider === "openai-codex" ? "OpenAI" : flow.label;
  return actionLinkHtml({
    href: url,
    variant: "primary",
    content: { kind: "caption", caption: `Open ${authenticationName} Authentication page so I can paste the code there` },
    attributesHtml: `target="_blank" rel="noreferrer"${hidden ? ' data-oauth-device-auth hidden data-action="oauth-flow#showWaitingStatus"' : ""}`,
  });
}

function oauthDeviceCodeBody(flow: PendingOAuthFlow, complete = false): string {
  const copyButton = copyButtonHtml({
    label: `Copy ${flow.userCode ?? ""} into clipboard`,
    caption: `Copy ${flow.userCode ?? ""} into clipboard`,
    copyText: flow.userCode ?? "",
    attributesHtml: 'data-oauth-copy-button="true" data-action="oauth-flow#showDeviceAuth"',
  });
  const confirmationName = flow.provider === "openai-codex" ? "OpenAI-Codex" : flow.label;
  const status = complete
    ? `<p class="settings-oauth-waiting-status" role="status"><span class="settings-oauth-complete-marker" aria-hidden="true">✓</span><span>${escapeHtml(flow.label)} connected</span></p>`
    : `<p class="settings-oauth-waiting-status" data-oauth-waiting-status hidden><span class="status-spinner" aria-hidden="true"></span><span>This step will complete when ${escapeHtml(confirmationName)} confirms they have received the code</span></p>`;
  return `<div class="settings-oauth-card">
    ${copyButton}
    ${oauthAuthenticationAction(flow, flow.verificationUri ?? "#", !complete)}
    ${status}
  </div>`;
}

function oauthRedirectFormId(flow: PendingOAuthFlow): string {
  return domId("oauth_redirect_form", flow.id);
}

function oauthPromptForm(flow: PendingOAuthFlow): string {
  if (!flow.prompt) return "";
  const prompt = flow.prompt.input;
  const inputId = domId("oauth_prompt", flow.id);
  return `<form id="${oauthRedirectFormId(flow)}" class="settings-oauth-card" method="post" action="/settings/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/prompt" data-turbo="true"><label for="${inputId}">${escapeHtml(prompt.message)}</label><input id="${inputId}" class="settings-input text-field" type="${prompt.type === "secret" ? "password" : "text"}" name="value" placeholder="${escapeHtml(prompt.placeholder ?? "")}"${prompt.type === "manual_code" || prompt.type === "secret" ? " required" : ""}></form>`;
}

function oauthBrowserRedirectBody(flow: PendingOAuthFlow): string {
  const prompt = flow.prompt;
  const promptForm = oauthPromptForm(flow);
  return `<div class="settings-oauth-card">
    <div class="settings-oauth-callout"><b>Before you start</b>${escapeHtml(flow.label)} assumes you will sign in on your local machine, but that’s not how Atelier works.<br><br>${escapeHtml(flow.label)} will redirect you to a localhost URL after you sign in. That URL will fail to load. You need to copy the long URL from the address bar, and paste it here.</div>
    ${oauthAuthenticationAction(flow, flow.authUrl ?? "#")}
    ${promptForm}
    ${!prompt && flow.redirectSubmitted ? oauthStatus("pending", `Waiting for ${flow.label}`, "Confirming the pasted redirect URL.") : ""}
  </div>`;
}

function oauthCompleteBody(flow: PendingOAuthFlow): string {
  if (flow.verificationUri) return oauthDeviceCodeBody(flow, true);
  const detail = "Choose your favorite models from this provider.";
  return `<div class="settings-oauth-card">${oauthStatus("done", `${flow.label} connected`, detail)}</div>`;
}

function oauthFlowModal(flow: PendingOAuthFlow): string {
  const pollMs = Math.max(1500, Math.min(15000, (flow.intervalSeconds ?? 3) * 1000));
  const doneButton = buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Done" } });
  const cancelButton = buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "Cancel" } });
  const submitUrlButton = buttonHtml({
    type: "submit",
    variant: "primary",
    content: { kind: "caption", caption: flow.authUrl ? "Submit URL" : "Continue" },
    attributesHtml: `form="${oauthRedirectFormId(flow)}"`,
  });
  const body = flow.status === "complete"
    ? oauthCompleteBody(flow)
    : flow.status === "error"
      ? `<p class="settings-error">${escapeHtml(flow.error ?? "OAuth login failed")}</p>`
      : flow.verificationUri
        ? oauthDeviceCodeBody(flow)
        : flow.authUrl
          ? oauthBrowserRedirectBody(flow)
          : flow.prompt
            ? oauthPromptForm(flow)
            : `<div class="settings-oauth-card">${oauthStatus("pending", "Starting OAuth flow", "Waiting for the provider to respond.")}</div>`;
  const action = flow.status === "complete"
    ? `<form method="post" action="/settings/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/finish" data-turbo="true">${doneButton}</form>`
    : flow.status === "pending"
      ? `<form method="post" action="/settings/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/cancel" data-turbo="true">${cancelButton}</form>${flow.prompt ? submitUrlButton : ""}`
      : `<form method="post" action="/settings/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/finish" data-turbo="true">${buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "Close" } })}</form>`;
  return dialogHtml({
    element: {
      id: "settings_flow_dialog",
      attributesHtml: `data-controller="oauth-flow" data-dialog-auto-show data-oauth-flow-status-url-value="/settings/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/status" data-oauth-flow-active-value="${flow.status === "pending" && !(flow.prompt && !flow.authUrl && !flow.verificationUri) ? "true" : "false"}" data-oauth-flow-poll-ms-value="${pollMs}"`,
    },
    iconHtml: providerIcon(flow.provider, flow.label),
    titleCaption: `Sign in with ${flow.label}`,
    bodyHtml: body,
    footerHtml: action,
    omitCancelButton: true,
  });
}

function modelSetupWorkingState(working: boolean): string {
  return `<span class="model-setup-working-state" data-working="${working}" hidden></span>`;
}

function modelSetupDialogButton(working: boolean): string {
  return buttonHtml({
    type: "submit",
    variant: "secondary",
    content: { kind: "caption", caption: working ? "Done" : "No favorite model available" },
    attributesHtml: "data-model-setup-dialog-button",
  });
}

async function refreshWorkingState(): Promise<string> {
  const working = await hasAvailableConfiguredAgentModel();
  return `${replaceTargets(".model-setup-working-state", modelSetupWorkingState(working))}${replaceTargets("[data-model-setup-dialog-button]", modelSetupDialogButton(working))}`;
}

async function refreshProviderState(providerId: string, renderPickerUpdates: () => Promise<string>): Promise<string> {
  const provider = (await providerSummaries()).find((candidate) => candidate.provider === providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  return modelSetupSurfaces.map((surface) => replace(domId("model_provider", surface, providerId), renderProvider(provider, surface, provider.connected))).join("") + await refreshWorkingState() + await renderPickerUpdates();
}

function providerErrorModal(provider: string, label: string, title: string, message: string): string {
  return dialogHtml({
    element: { id: "settings_flow_dialog", attributesHtml: "data-dialog-auto-show" },
    iconHtml: providerIcon(provider, label), titleCaption: title,
    bodyHtml: `<p class="settings-error" role="alert">${escapeHtml(message)}</p>`,
  });
}

export async function handleModelSettingsRequest(request: Request, url: URL, renderPickerUpdates: () => Promise<string>): Promise<Response | undefined> {
  if (url.pathname === "/settings/models/providers" && request.method === "GET") {
    const surface = modelSetupSurfaces.find((candidate) => candidate === (url.searchParams.get("surface") ?? "settings"));
    if (!surface) return response("Unknown model setup surface", { status: 400 });
    return response(renderProviderList(groupModelProviders(await providerSummaries()).other, surface, url.searchParams.get("q") ?? ""));
  }
  if (url.pathname === "/settings/models/catalogue" && request.method === "GET") {
    const requestedSurface = url.searchParams.get("surface") ?? "settings";
    const surface = modelSetupSurfaces.find((candidate) => candidate === requestedSurface);
    if (!surface) return response("Unknown model catalogue surface", { status: 400 });
    const provider = (await providerSummaries()).find((candidate) => candidate.provider === url.searchParams.get("provider"));
    if (!provider) return response("Unknown provider", { status: 400 });
    const catalogue = provider.connected ? await providerCatalogue(provider.provider) : [];
    return response(renderProviderModels(catalogue, surface, provider, url.searchParams.get("q") ?? ""));
  }
  if (url.pathname === "/settings/models/catalogue/refresh" && request.method === "POST") {
    let feedback: Pick<CustomModelsView, "error" | "status">;
    try {
      const runtime = await createPiModelRuntime();
      const result = await runtime.refresh({ allowNetwork: true, force: true });
      const errors = [...result.errors].map(([provider, error]) => `${provider}: ${error.message}`);
      if (result.aborted) errors.push("Refresh was interrupted.");
      feedback = errors.length
        ? { error: `Model catalogue refresh was incomplete. ${errors.join(" ")}` }
        : { status: "Model catalogue refreshed." };
    } catch (error) {
      feedback = { error: `Model catalogue refresh failed. ${error instanceof Error ? error.message : String(error)}` };
    }
    return stream(replace("model_setup_settings", await renderModelSetup("settings", { open: true, ...feedback })) + await renderPickerUpdates());
  }
  if (url.pathname === "/settings/models/dialog" && request.method === "GET") {
    const html = await renderModelSetupDialog();
    return wantsStream(request) ? stream(update("settings_modal_host", html)) : response(html);
  }
  if (url.pathname === "/settings/models/custom" && request.method === "POST") {
    const form = await request.formData();
    const source = String(form.get("models") ?? "");
    try {
      const result = await setCustomModelsJson(source);
      const skipped = result.skippedOfficialModels;
      const status = skipped.length
        ? `Saved. ${skipped.length} ${skipped.length === 1 ? "model is" : "models are"} already in the official catalogue and will use the official definition: ${skipped.map(modelKey).join(", ")}.`
        : "Custom model configuration saved.";
      return stream(replace("model_setup_settings", await renderModelSetup("settings", { open: true, status })) + await renderPickerUpdates());
    } catch (error) {
      return stream(replace("custom_models_settings", renderCustomModelsSettings({ source, open: true, error: error instanceof Error ? error.message : String(error) })));
    }
  }
  let match = url.pathname.match(/^\/settings\/providers\/([^/]+)\/flow$/);
  if (match && request.method === "POST") {
    const provider = decodeURIComponent(match[1]!);
    const method = url.searchParams.get("method") ?? "";
    const surface = url.searchParams.get("surface") === "onboarding" ? "onboarding" : "settings";
    const summary = (await providerSummaries()).find((candidate) => candidate.provider === provider);
    if (!summary) return response("Unknown provider", { status: 400 });
    const label = summary.label;
    if (!summary.methods.includes(method)) return response("Unsupported authentication method", { status: 400 });
    if (method === "oauth") {
      try {
        const flow = await startOAuthFlow(provider, label);
        return stream(append(surface === "onboarding" ? "onboarding_modal_host" : "settings_modal_host", oauthFlowModal(flow)));
      } catch (error) {
        return stream(append(surface === "onboarding" ? "onboarding_modal_host" : "settings_modal_host", providerErrorModal(provider, label, `Could not connect ${label}`, error instanceof Error ? error.message : String(error))));
      }
    }
    return stream(append(surface === "onboarding" ? "onboarding_modal_host" : "settings_modal_host", apiKeyModal(provider, label, surface)));
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
      if (error instanceof ProviderCatalogueRefreshError) {
        return stream(`${await refreshProviderState(provider, renderPickerUpdates)}${replace("settings_flow_dialog", providerErrorModal(provider, label, `${label} connected`, error.message))}`);
      }
      return stream(replace("settings_flow_dialog", apiKeyModal(provider, label, surface, error instanceof Error ? error.message : String(error))));
    }
    return stream(`${await refreshProviderState(provider, renderPickerUpdates)}${remove("settings_flow_dialog")}`);
  }
  match = url.pathname.match(/^\/settings\/providers\/([^/]+)\/oauth\/([^/]+)\/(status|prompt|finish|cancel)$/);
  if (match && request.method === "POST") {
    const provider = decodeURIComponent(match[1]!);
    const flowId = decodeURIComponent(match[2]!);
    const action = match[3]!;
    const flow = pendingOAuthFlows.get(flowId);
    if (!flow || flow.provider !== provider) return stream(remove("settings_flow_dialog"));
    if (action === "prompt") {
      const form = await request.formData();
      flow.redirectSubmitted = true;
      flow.prompt?.resolve(String(form.get("value") ?? ""));
      flow.prompt = undefined;
      await waitForOAuthFlowReady(flow);
      return stream(replace("settings_flow_dialog", oauthFlowModal(flow)));
    }
    if (action === "cancel" || action === "finish") {
      if (action === "cancel") flow.abort.abort();
      pendingOAuthFlows.delete(flowId);
      return stream(`${await refreshProviderState(provider, renderPickerUpdates)}${remove("settings_flow_dialog")}`);
    }
    return stream(replace("settings_flow_dialog", oauthFlowModal(flow)));
  }
  match = url.pathname.match(/^\/settings\/providers\/([^/]+)\/disconnect$/);
  if (match && request.method === "POST") {
    const provider = decodeURIComponent(match[1]!);
    await disconnectModelProvider(provider);
    return stream(await refreshProviderState(provider, renderPickerUpdates));
  }
  if (["/settings/models/add", "/settings/models/remove"].includes(url.pathname) && request.method === "POST") return await handleModelPickerAction(request, url.pathname, renderPickerUpdates);
  return undefined;
}

async function handleModelPickerAction(request: Request, pathname: string, renderPickerUpdates: () => Promise<string>): Promise<Response> {
  const form = await request.formData();
  const model = parseModelRef(String(form.get("model") ?? ""));
  if (!model) return response("Invalid model", { status: 400 });
  const option = (await providerCatalogue(model.provider)).find((candidate) => candidate.id === model.id);
  if (!option) return response("Unknown model", { status: 400 });
  const favorite = pathname === "/settings/models/add";
  if (favorite && !(await createPiModelRuntime()).getProviderAuthStatus(model.provider).configured) return response("Provider not connected", { status: 400 });
  const current = await getConfiguredAgentModels();
  const index = current.findIndex((candidate) => modelKey(candidate) === modelKey(model));
  if (favorite && index < 0) current.push({ provider: option.provider, id: option.id, label: option.label });
  if (!favorite && index >= 0) current.splice(index, 1);
  await setPickerAgentModels(current, current.find((candidate) => candidate.active));
  const actions = modelSetupSurfaces.map((surface) => replaceTargets(`.${domId("model_favorite", surface, model.provider, model.id)}`, favoriteAction({ ...option, configured: favorite }, surface))).join("");
  return stream(actions + await refreshWorkingState() + await renderPickerUpdates());
}
