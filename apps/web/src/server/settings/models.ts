import { actionLinkHtml } from "@atelier/design-system/action-link";
import { buttonHtml } from "@atelier/design-system/button";
import { copyButtonHtml } from "@atelier/design-system/copy-button";
import { destructiveConfirmationHtml } from "@atelier/design-system/destructive-confirmation";
import { dialogHtml } from "@atelier/design-system/dialog";
import { Icons } from "@atelier/design-system/icons";
import {
  connectModelProviderApiKey,
  createPiModelRuntime,
  disconnectModelProvider,
  getConfiguredAgentModels,
  getCustomModelsJson,
  getPopularModelRank,
  getProviderApiKeyExample,
  loginPiOAuthProvider,
  setCustomModelsJson,
  setPickerAgentModels,
  type ConfiguredAgentModel,
  type PiAuthPrompt,
} from "@atelier/agent/server";
import { domId, escapeHtml } from "@atelier/shared";
import { append, remove, replace, replaceTargets, response, stream, update, updateTargets, wantsStream } from "./http.ts";
import { registerSettingsContribution } from "./registry.ts";
import { providerIcon, type SettingsSurface } from "./views.ts";

const providerDisconnectConfirmation = destructiveConfirmationHtml({
  trigger: { type: "button", variant: "danger", content: { kind: "caption", caption: "Disconnect" } },
  confirmCaption: "Disconnect",
  cancelCaption: "Cancel",
});

const modelRemovalConfirmation = destructiveConfirmationHtml({
  trigger: { type: "button", variant: "danger", content: { kind: "icon-only", iconHtml: Icons.Trash, label: "Remove configured model" } },
  confirmCaption: "Remove model",
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
  }).sort((a, b) => Number(b.connected) - Number(a.connected) || a.label.localeCompare(b.label));
}


function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}::${model.id}`;
}

function modelManagedListContent(model: ConfiguredAgentModel, description: string): string {
  return `${providerIcon(model.provider, model.provider, "settings-model-provider-icon managed-list__visual")}
    <div class="managed-list__content"><div class="managed-list__label"><span class="managed-list__label-text">${escapeHtml(model.label)}</span></div><div class="managed-list__description">${escapeHtml(description)}</div></div>`;
}

type ModelSetupSurface = SettingsSurface | "dialog";
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
    const aPopular = getPopularModelRank(a.provider, a.id);
    const bPopular = getPopularModelRank(b.provider, b.id);
    if (aPopular !== undefined || bPopular !== undefined) return (aPopular ?? Number.MAX_SAFE_INTEGER) - (bPopular ?? Number.MAX_SAFE_INTEGER);
    const aConnected = providers.get(a.provider)?.connected ?? false;
    const bConnected = providers.get(b.provider)?.connected ?? false;
    return Number(bConnected) - Number(aConnected) || a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label);
  });
  const available = new Set((await runtime.getAvailable()).map(modelKey));
  return { configured, models, providers, working: configured.some((model) => available.has(modelKey(model))) };
}

async function initiatedModel(provider: string, value: string): Promise<ConfiguredAgentModel | undefined> {
  const separator = value.indexOf("::");
  if (separator < 1 || value.slice(0, separator) !== provider) return undefined;
  const id = value.slice(separator + 2);
  const model = (await createPiModelRuntime()).getModels(provider).find((candidate) => candidate.id === id);
  return model ? { provider: model.provider, id: model.id, label: model.name ?? model.id } : undefined;
}

async function addConfiguredModel(model: ConfiguredAgentModel): Promise<void> {
  const current = await getConfiguredAgentModels();
  if (current.some((candidate) => modelKey(candidate) === modelKey(model))) return;
  current.push(model);
  await setPickerAgentModels(current, current.find((candidate) => candidate.active));
}

function providerState(provider: ProviderSummary): string {
  return `<span class="model-provider-state ${domId("model_provider_state", provider.provider)}" data-connected="${provider.connected}" hidden></span>`;
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
  return provider.methods.map((method) => `<form method="post" action="${providerAuthAction(provider, method, surface)}" data-turbo="true">${buttonHtml({
    type: "submit",
    variant: "secondary",
    content: { kind: "caption", caption: providerAuthLabel(method) },
  })}</form>`).join("");
}

function catalogueProviderForms(provider: ProviderSummary, surface: ModelSetupSurface): string {
  const authentication = provider.methods.map((method) => `<form id="${providerAuthFormId(provider, method, surface)}" method="post" action="${providerAuthAction(provider, method, surface)}" data-turbo="true" hidden></form>`).join("");
  return `<form id="${domId("model_catalogue_add", surface, provider.provider)}" method="post" action="/settings/models/add" data-turbo="true" hidden></form>${authentication}`;
}

function catalogueAuthenticationButtons(model: ModelCatalogueEntry, provider: ProviderSummary, surface: ModelSetupSurface): string {
  if (!provider.methods.length) return `<span class="settings-provider-desc">Provider unavailable</span>`;
  return provider.methods.map((method) => buttonHtml({
    type: "submit",
    variant: "secondary",
    content: { kind: "caption", caption: providerAuthLabel(method) },
    attributesHtml: `form="${providerAuthFormId(provider, method, surface)}" name="model" value="${escapeHtml(modelKey(model))}"`,
  })).join("");
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
  const rows = data.configured.map((model) => configuredModelRow(model, data.providers.get(model.provider) ?? { provider: model.provider, label: model.provider, connected: false, methods: [] }, surface)).join("");
  const models = `<div class="managed-list">${rows}</div>`;
  return `<section class="model-setup-section form-section"><h2>Configured models</h2>${models}</section>`;
}

function catalogueModelAction(model: ModelCatalogueEntry, provider: ProviderSummary, surface: ModelSetupSurface): string {
  const actionClass = domId("model_catalogue_action", surface, model.provider, model.id);
  const addButton = buttonHtml({
    type: "submit",
    variant: "primary",
    content: { kind: "caption", caption: "Add" },
    attributesHtml: `form="${domId("model_catalogue_add", surface, provider.provider)}" name="model" value="${escapeHtml(modelKey(model))}"`,
  });
  return `<div class="managed-list__actions model-catalogue-action ${actionClass}">
    ${model.configured
      ? `<span class="settings-provider-desc">Already added</span>`
      : `<span class="model-provider-disconnected-actions">${catalogueAuthenticationButtons(model, provider, surface)}</span><span class="model-provider-connected-actions">${addButton}</span>`}
  </div>`;
}

function catalogueModelRow(model: ModelCatalogueEntry, provider: ProviderSummary, surface: ModelSetupSurface): string {
  const popularityRank = getPopularModelRank(model.provider, model.id);
  return `<div class="managed-list__item model-catalogue-row" data-model-sort="${escapeHtml(`${model.provider} ${model.label}`.toLowerCase())}"${popularityRank === undefined ? "" : ` data-popularity-rank="${popularityRank}"`} data-search-text="${escapeHtml(`${model.label} ${model.provider} ${model.id}`.toLowerCase())}">
    ${providerState(provider)}
    ${modelManagedListContent(model, `${model.provider} · ${model.id}`)}
    ${catalogueModelAction(model, provider, surface)}
  </div>`;
}

const modelCatalogueLimit = 50;

function modelCatalogueFrameId(surface: ModelSetupSurface): string {
  return domId("model_catalogue_results", surface);
}

type ModelCatalogueFeedback = { message: string; error?: boolean; details?: string };

function renderModelCatalogueResults(data: ModelSetupData, surface: ModelSetupSurface, query: string, feedback?: ModelCatalogueFeedback): string {
  const normalizedQuery = query.trim().toLowerCase();
  const matchingModels = (normalizedQuery
    ? data.models.filter((model) => `${model.label} ${model.provider} ${model.id} ${data.providers.get(model.provider)?.label ?? ""}`.toLowerCase().includes(normalizedQuery))
    : data.models).filter((model) => data.providers.has(model.provider));
  const visibleModels = matchingModels.slice(0, modelCatalogueLimit);
  const visibleProviderIds = new Set(visibleModels.map((model) => model.provider));
  const providerForms = [...visibleProviderIds].map((provider) => catalogueProviderForms(data.providers.get(provider)!, surface)).join("");
  const rows = visibleModels.map((model) => catalogueModelRow(model, data.providers.get(model.provider)!, surface)).join("");
  const remaining = matchingModels.length - visibleModels.length;
  const more = remaining > 0 ? `<div class="managed-list__item model-catalogue-more" role="status" aria-disabled="true">Many results, use the filter box</div>` : "";
  const empty = matchingModels.length ? "" : `<div class="managed-list__empty">No matching models.</div>`;
  return `<turbo-frame id="${modelCatalogueFrameId(surface)}" class="model-catalogue-results">${providerForms}${feedback ? `<div class="model-catalogue-feedback${feedback.error ? " settings-error" : ""}" role="${feedback.error ? "alert" : "status"}">${escapeHtml(feedback.message)}${feedback.details ? `<details><summary>Refresh error details</summary>${escapeHtml(feedback.details)}</details>` : ""}</div>` : ""}<div class="model-catalogue-loading" role="status"><span class="status-spinner" aria-hidden="true"></span>Loading models…</div><div class="managed-list__items">${rows}${more}</div>${empty}</turbo-frame>`;
}

function renderModelCatalogue(data: ModelSetupData, surface: ModelSetupSurface): string {
  const frameId = modelCatalogueFrameId(surface);
  return `<div class="managed-list" data-managed-list-server-filter="true">
    <form id="${domId("model_catalogue_filter", surface)}" class="managed-list__filter" method="get" action="/settings/models/catalogue" data-controller="server-filter" data-action="input->server-filter#submit" data-turbo-frame="${frameId}">
      <input type="hidden" name="surface" value="${surface}">
      <input class="text-field" type="search" name="q" placeholder="Filter models and providers…" aria-label="Filter available models" autocomplete="off">
      <button type="submit" hidden>Filter models</button>
    </form>
    ${renderModelCatalogueResults(data, surface, "")}
  </div>`;
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
    attributesHtml: `form="${domId("model_catalogue_filter", "settings")}" formaction="/settings/models/catalogue/refresh" formmethod="post" data-turbo-submits-with="Refreshing…"`,
  });
  return `<details class="custom-models-settings" id="custom_models_settings"${view.open ? " open" : ""}>
    <summary>Advanced model settings</summary>
    <div>${refreshButton}</div>
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
  const id = surface === "dialog" ? "model_setup_dialog_content" : `model_setup_${surface}`;
  return `<div class="model-setup form-stack" id="${id}">
    ${modelSetupWorkingState(working)}
    <div class="configured-model-section configured-model-section-${surface}">${renderConfiguredModelsSection(data, surface)}</div>
    <section class="model-setup-section form-section"><h2>Available models</h2><div class="model-catalogue" data-controller="model-catalogue">${renderModelCatalogue(data, surface)}</div></section>
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
    element: { id: "model_setup_dialog",  attributesHtml: "data-dialog-auto-show" },
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

function apiKeyModal(id: string, label: string, surface: SettingsSurface, model?: ConfiguredAgentModel, error = ""): string {
  const inputId = domId("provider_api_key", id);
  const formId = domId("provider_api_key_form", id);
  const action = `/settings/providers/${encodeURIComponent(id)}/connect${surface === "onboarding" ? "?surface=onboarding" : ""}`;
  const initiatedModel = model ? `<input type="hidden" name="model" value="${escapeHtml(modelKey(model))}">` : "";
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
      ${initiatedModel}
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
  initiatedModel?: ConfiguredAgentModel;
};

const pendingOAuthFlows = new Map<string, PendingOAuthFlow>();

async function startOAuthFlow(provider: string, label: string, initiatedModel?: ConfiguredAgentModel): Promise<PendingOAuthFlow> {
  if (!(await createPiModelRuntime()).getProvider(provider)?.auth.oauth) throw new Error(`${label} does not support OAuth in this pi installation.`);
  const flow: PendingOAuthFlow = { id: crypto.randomUUID(), provider, label, status: "pending", abort: new AbortController(), initiatedModel };
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
    if (flow.initiatedModel) await addConfiguredModel(flow.initiatedModel);
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
    content: { kind: "caption", caption: `Open ${authenticationName} Authentication page so I can paste the button there` },
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
    ? `<p class="settings-oauth-waiting-status" role="status"><span class="settings-oauth-complete-marker" aria-hidden="true">✓</span><span>${escapeHtml(flow.label)} connected${flow.initiatedModel ? ` — ${escapeHtml(flow.initiatedModel.label)} was added to your models.` : " — You can now add models from this provider."}</span></p>`
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
  const detail = flow.initiatedModel ? `${flow.initiatedModel.label} was added to your models.` : "You can now add models from this provider.";
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
    content: { kind: "caption", caption: working ? "OK" : "No model configured yet" },
    attributesHtml: "data-model-setup-dialog-button",
  });
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
  return `${configuredSections}${catalogueActions}${replaceTargets(".model-setup-working-state", modelSetupWorkingState(working))}${replaceTargets("[data-model-setup-dialog-button]", modelSetupDialogButton(working))}`;
}


export async function handleModelSettingsRequest(request: Request, url: URL): Promise<Response | undefined> {
  if (url.pathname === "/settings/models/catalogue" && request.method === "GET") {
    const requestedSurface = url.searchParams.get("surface") ?? "settings";
    const surface = modelSetupSurfaces.find((candidate) => candidate === requestedSurface);
    if (!surface) return response("Unknown model catalogue surface", { status: 400 });
    return response(renderModelCatalogueResults(await modelSetupData(), surface, url.searchParams.get("q") ?? ""));
  }
  if (url.pathname === "/settings/models/catalogue/refresh" && request.method === "POST") {
    const form = await request.formData();
    const surface = modelSetupSurfaces.find((candidate) => candidate === form.get("surface"));
    if (!surface) return response("Unknown model catalogue surface", { status: 400 });
    let feedback: ModelCatalogueFeedback;
    try {
      const runtime = await createPiModelRuntime();
      const result = await runtime.refresh({ allowNetwork: true, force: true });
      const errors = [...result.errors].map(([provider, error]) => `${provider}: ${error.message}`);
      if (result.aborted) errors.push("Refresh was interrupted.");
      feedback = errors.length
        ? { message: result.aborted ? "Model catalogue refresh was interrupted." : `Could not refresh: ${[...result.errors.keys()].join(", ")}. Other catalogue updates have been applied.`, error: true, details: errors.join(" ") }
        : { message: "Model catalogue refreshed." };
    } catch (error) {
      feedback = { message: "Model catalogue refresh failed.", error: true, details: error instanceof Error ? error.message : String(error) };
    }
    return stream(replace(modelCatalogueFrameId(surface), renderModelCatalogueResults(await modelSetupData(), surface, String(form.get("q") ?? ""), feedback)));
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
      return stream(replace("model_setup_settings", await renderModelSetup("settings", { open: true, status })));
    } catch (error) {
      return stream(replace("custom_models_settings", renderCustomModelsSettings({ source, open: true, error: error instanceof Error ? error.message : String(error) })));
    }
  }
  let match = url.pathname.match(/^\/settings\/providers\/([^/]+)\/flow$/);
  if (match && request.method === "POST") {
    const provider = decodeURIComponent(match[1]!);
    const method = url.searchParams.get("method") ?? "api_key";
    const surface = url.searchParams.get("surface") === "onboarding" ? "onboarding" : "settings";
    const runtime = await createPiModelRuntime();
    const label = runtime.getProvider(provider)?.name ?? provider;
    const form = request.body ? await request.formData() : new FormData();
    const model = await initiatedModel(provider, String(form.get("model") ?? ""));
    if (method === "oauth") {
      try {
        const flow = await startOAuthFlow(provider, label, model);
        return stream(append(surface === "onboarding" ? "onboarding_modal_host" : "settings_modal_host", oauthFlowModal(flow)));
      } catch (error) {
        return stream(append(surface === "onboarding" ? "onboarding_modal_host" : "settings_modal_host", apiKeyModal(provider, label, surface, model, error instanceof Error ? error.message : String(error))));
      }
    }
    return stream(append(surface === "onboarding" ? "onboarding_modal_host" : "settings_modal_host", apiKeyModal(provider, label, surface, model)));
  }
  match = url.pathname.match(/^\/settings\/providers\/([^/]+)\/connect$/);
  if (match && request.method === "POST") {
    const provider = decodeURIComponent(match[1]!);
    const surface = url.searchParams.get("surface") === "onboarding" ? "onboarding" : "settings";
    const runtime = await createPiModelRuntime();
    const label = runtime.getProvider(provider)?.name ?? provider;
    const form = await request.formData();
    const secret = String(form.get("secret") ?? "");
    const model = await initiatedModel(provider, String(form.get("model") ?? ""));
    try {
      await connectModelProviderApiKey(provider, secret);
      if (model) await addConfiguredModel(model);
    } catch (error) {
      return stream(replace("settings_flow_dialog", apiKeyModal(provider, label, surface, model, error instanceof Error ? error.message : String(error))));
    }
    const configuredModelState = model ? await refreshConfiguredModelState(model) : "";
    return stream(`${await refreshProviderState(provider)}${configuredModelState}${remove("settings_flow_dialog")}`);
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
      await waitForOAuthFlowReady(flow);
      return stream(replace("settings_flow_dialog", oauthFlowModal(flow)));
    }
    if (action === "cancel") {
      flow.abort.abort();
      pendingOAuthFlows.delete(flowId);
      return stream(remove("settings_flow_dialog"));
    }
    if (action === "finish") {
      pendingOAuthFlows.delete(flowId);
      const configuredModelState = flow.initiatedModel && flow.status === "complete" ? await refreshConfiguredModelState(flow.initiatedModel) : "";
      return stream(`${await refreshProviderState(provider)}${configuredModelState}${remove("settings_flow_dialog")}`);
    }
    const providerState = flow.status === "complete" ? await refreshProviderState(provider) : "";
    const configuredModelState = flow.initiatedModel && flow.status === "complete" ? await refreshConfiguredModelState(flow.initiatedModel) : "";
    return stream(`${replace("settings_flow_dialog", oauthFlowModal(flow))}${providerState}${configuredModelState}`);
  }
  match = url.pathname.match(/^\/settings\/providers\/([^/]+)\/disconnect$/);
  if (match && request.method === "POST") {
    const provider = decodeURIComponent(match[1]!);
    await disconnectModelProvider(provider);
    return stream(await refreshProviderState(provider));
  }
  if (["/settings/models/add", "/settings/models/remove"].includes(url.pathname) && request.method === "POST") return await handleModelPickerAction(request, url.pathname);
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
