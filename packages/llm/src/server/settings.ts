import { providerConnections, type ProviderConnection } from "./provider-connections.ts";
import { getPopularModelRank, getPopularProviderRank, getProviderApiKeyExample } from "./hardcoded-provider-knowledge.ts";
import { modelRefValue as modelKey, parseModelRef } from "./model-reference.ts";
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
  getConfiguredModels,
  getCustomModelsJson,
  seedProviderFavoriteModels,
  loginPiOAuthProvider,
  setCustomModelsJson,
  setConfiguredModels,
  type ConfiguredModel,
  type PiAuthPrompt,
} from "./pi-config-models.ts";
import { domId, escapeHtml, providerBadgeHtml } from "@atelier/shared";
import { append, remove, replace, replaceTargets, response, stream, update, wantsStream } from "@atelier/shared/http";

type ProviderSummary = { provider: string; label: string; connection: ProviderConnection; methods: string[] };

async function providerSummaries(): Promise<ProviderSummary[]> {
  const runtime = await createPiModelRuntime();
  const connections = await providerConnections(runtime);
  return runtime.getProviders().map((provider): ProviderSummary => ({
    provider: provider.id,
    label: provider.id === "openai-codex" ? "ChatGPT / Codex" : provider.id === "openai" ? "OpenAI API" : provider.name ?? provider.id,
    connection: connections.get(provider.id)!,
    methods: [provider.auth.oauth && "oauth", provider.auth.apiKey?.login && "api_key"].filter((method): method is string => Boolean(method)),
  })).sort((a, b) => (getPopularProviderRank(a.provider) ?? Number.MAX_SAFE_INTEGER) - (getPopularProviderRank(b.provider) ?? Number.MAX_SAFE_INTEGER) || a.label.localeCompare(b.label));
}

type ModelSetupSurface = "settings" | "onboarding" | "dialog" | "settings-dialog";
const modelSetupSurfaces: readonly ModelSetupSurface[] = ["settings", "onboarding", "dialog", "settings-dialog"];

type ModelCatalogueEntry = ConfiguredModel & { configured: boolean };

async function providerCatalogue(provider: string): Promise<ModelCatalogueEntry[]> {
  const runtime = await createPiModelRuntime();
  const favorites = (await getConfiguredModels()).filter((model) => model.provider === provider);
  const favoriteById = new Map(favorites.map((model) => [model.id, model]));
  const models = new Map(runtime.getModels(provider).map((model): [string, ModelCatalogueEntry] => [model.id, {
    provider, id: model.id, label: favoriteById.get(model.id)?.label ?? model.name ?? model.id, configured: favoriteById.has(model.id),
  }]));
  // Keep unavailable favorites visible so they can still be removed.
  for (const model of favorites) {
    if (!models.has(model.id)) models.set(model.id, { ...model, configured: true });
  }
  return [...models.values()].sort((a, b) => (getPopularModelRank(provider, a.id) ?? Number.MAX_SAFE_INTEGER) - (getPopularModelRank(provider, b.id) ?? Number.MAX_SAFE_INTEGER)
    || a.label.localeCompare(b.label));
}

function setupId(surface: ModelSetupSurface): string { return (surface === "dialog" || surface === "settings-dialog") ? "model_setup_dialog_content" : `model_setup_${surface}`; }
function setupUrl(surface: ModelSetupSurface, provider?: string): string {
  return `/settings/models/step?surface=${surface}${provider ? `&provider=${encodeURIComponent(provider)}` : ""}`;
}
function setupBack(surface: ModelSetupSurface): string {
  if (surface === "settings-dialog") return buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Back" }, attributesHtml: 'data-action="dialog#close"' });
  return actionLinkHtml({ href: setupUrl(surface), variant: "secondary", content: { kind: "caption", caption: "Back" }, attributesHtml: `data-turbo-frame="${setupId(surface)}"` });
}
function setupSkip(surface: ModelSetupSurface): string {
  return surface === "onboarding" ? `<form method="post" action="/onboarding/finish" data-turbo="true">${buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "Set up later" } })}</form>` : "";
}
function setupFrame(surface: ModelSetupSurface, body: string): string {
  return `<turbo-frame id="${setupId(surface)}" class="model-setup form-stack">${body}</turbo-frame>`;
}
function providerHeading(provider: Pick<ProviderSummary, "provider" | "label">): string {
  return `<div class="model-setup-heading">${providerBadgeHtml(provider.provider, provider.label, "settings-provider-icon")}<span>${escapeHtml(provider.label)}</span></div>`;
}
/** Every connection state supplies content; this shell alone owns its placement. */
function renderConnectionStep(provider: Pick<ProviderSummary, "provider" | "label">, surface: ModelSetupSurface, options: {
  bodyHtml: string;
  actionsHtml?: string;
  attributesHtml?: string;
}): string {
  return setupFrame(surface, `<div id="model_connection_step" class="model-provider-connection"${options.attributesHtml ? ` ${options.attributesHtml}` : ""}>
    ${providerHeading(provider)}
    <div class="model-connection-content">
      ${options.bodyHtml}
    </div>
    <div class="model-setup-actions">${options.actionsHtml ?? setupBack(surface)}</div>
  </div>`);
}
function providerAuthAction(provider: ProviderSummary, method: string, surface: ModelSetupSurface): string {
  return `/settings/providers/${encodeURIComponent(provider.provider)}/flow?method=${encodeURIComponent(method)}&surface=${surface}`;
}
function renderConnectionMethods(provider: ProviderSummary, surface: ModelSetupSurface): string {
  return renderConnectionStep(provider, surface, {
    bodyHtml: `<div class="model-setup-choices">${provider.methods.map((method) => `<form method="post" action="${providerAuthAction(provider, method, surface)}" data-turbo="true">${buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: method === "oauth" ? "Use subscription" : "Use API key" } })}</form>`).join("")}</div>`,
  });
}
function providerListFrameId(surface: ModelSetupSurface): string { return domId("model_providers", surface); }
function groupModelProviders(providers: ProviderSummary[]) {
  const popular = providers.filter((provider) => getPopularProviderRank(provider.provider) !== undefined);
  return { popular, other: providers.filter((provider) => !popular.includes(provider)) };
}
function renderProvider(provider: ProviderSummary, surface: ModelSetupSurface): string {
  const attentionId = domId("provider_attention", surface, provider.provider);
  const attention = provider.connection === "needs_attention" ? `<span class="model-provider-attention">${Icons.Exclamation}</span><span class="model-provider-attention-hint" id="${attentionId}" role="tooltip">Sign-in needs attention</span>` : "";
  return `<form class="model-provider-choice" method="post" action="${setupUrl(surface, provider.provider)}" data-turbo="true">${actionItemHtml({
    kind: "single",
    element: { tag: "button", attributesHtml: `type="submit"${provider.connection === "needs_attention" ? ` aria-describedby="${attentionId}"` : ""}` },
    label: { kind: "text", text: provider.label },
    leadingHtml: `<span aria-hidden="true">${providerBadgeHtml(provider.provider, provider.label, "settings-provider-icon")}</span>`,
    trailingHtml: attention,
  })}</form>`;
}
function renderProviderList(providers: ProviderSummary[], surface: ModelSetupSurface, query = ""): string {
  const normalized = query.trim().toLowerCase();
  const matching = providers.filter((provider) => `${provider.label} ${provider.provider}`.toLowerCase().includes(normalized));
  return `<turbo-frame id="${providerListFrameId(surface)}"><div class="model-providers" tabindex="0" role="region" aria-label="Other providers">${matching.map((provider) => renderProvider(provider, surface)).join("") || '<div class="managed-list__empty" role="status">No matching providers.</div>'}</div></turbo-frame>`;
}
function providerFrameId(surface: ModelSetupSurface, provider: string): string { return domId("model_provider_models", surface, provider); }
function renderFavorites(favorites: ConfiguredModel[], surface: ModelSetupSurface, provider: string): string {
  const rows = favorites.filter((model) => model.provider === provider).map((model) => `<div class="model-favorite-row"><span class="model-favorite-name">${escapeHtml(model.label)}</span>
    <form method="post" action="/settings/models/remove" data-turbo="true"><input type="hidden" name="model" value="${escapeHtml(modelKey(model))}">
      ${buttonHtml({ type: "submit", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Close, label: `Remove ${model.label}` } })}
    </form></div>`).join("");
  return `<div class="${domId("model_favorites", surface, provider)} model-favorites"><p>Favorite models</p><div class="model-favorites-list">${rows || '<p class="managed-list__empty">No favorites yet.</p>'}</div></div>`;
}
function catalogueModelRow(model: ModelCatalogueEntry, surface: ModelSetupSurface): string {
  return `<form class="${domId("model_catalogue_row", surface, model.provider, model.id)}" method="post" action="/settings/models/add" data-turbo="true">
    <input type="hidden" name="model" value="${escapeHtml(modelKey(model))}">
    ${actionItemHtml({ kind: "single", element: { tag: "button", attributesHtml: `type="submit"${model.configured ? " disabled" : ""} title="${escapeHtml(model.id)}"` }, label: { kind: "text", text: `${model.label}${model.configured ? " (Already added)" : ""}` } })}
  </form>`;
}
function renderProviderModels(catalogue: ModelCatalogueEntry[], surface: ModelSetupSurface, provider: ProviderSummary, query: string): string {
  const normalized = query.trim().toLowerCase();
  const models = catalogue.filter((model) => `${model.label} ${model.id}`.toLowerCase().includes(normalized));
  return `<turbo-frame class="model-provider-results" id="${providerFrameId(surface, provider.provider)}"><div class="model-provider-models" tabindex="0" role="region" aria-label="${escapeHtml(provider.label)} models">${models.map((model) => catalogueModelRow(model, surface)).join("") || '<div class="managed-list__empty">No matching models.</div>'}</div></turbo-frame>`;
}
function continueButton(provider: string, working: boolean): string {
  return `<span class="${domId("model_setup_continue", provider)}">${buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Continue" }, disabled: !working })}</span>`;
}
async function providerHasFavorite(provider: string): Promise<boolean> {
  const available = new Set((await (await createPiModelRuntime()).getAvailable(provider)).map((model) => model.id));
  return (await getConfiguredModels()).some((model) => model.provider === provider && available.has(model.id));
}
async function renderModelSelection(provider: ProviderSummary, surface: ModelSetupSurface, error = ""): Promise<string> {
  const frameId = providerFrameId(surface, provider.provider);
  return setupFrame(surface, `${error ? `<p class="settings-error" role="alert">${escapeHtml(error)}</p>` : ""}
    ${renderFavorites(await getConfiguredModels(), surface, provider.provider)}
    <div class="model-all-models"><p>All models</p><div class="managed-list" data-managed-list-server-filter="true"><form class="managed-list__filter" method="get" action="/settings/models/catalogue" data-controller="server-filter" data-action="input->server-filter#submit" data-turbo-frame="${frameId}">
      <input type="hidden" name="surface" value="${surface}"><input type="hidden" name="provider" value="${escapeHtml(provider.provider)}">
      <input class="text-field" type="search" name="q" placeholder="Find a model…" aria-label="Find a model" autocomplete="off"><button type="submit" hidden>Search</button>
    </form>${renderProviderModels(await providerCatalogue(provider.provider), surface, provider, "")}</div></div>
    <div class="model-setup-actions model-selection-actions">${surface === "dialog" ? setupBack(surface) : ""}${setupSkip(surface)}<form method="post" action="/settings/models/finish?surface=${surface}&provider=${encodeURIComponent(provider.provider)}" data-turbo="true">${continueButton(provider.provider, await providerHasFavorite(provider.provider))}</form></div>`);
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

function renderProviderPicker(providers: ProviderSummary[], surface: ModelSetupSurface, customModels?: CustomModelsView): string {
  if (surface !== "onboarding") {
    const configured = providers.filter((provider) => provider.connection !== "disconnected");
    return setupFrame(surface, `<p>Your providers</p><div class="model-popular-providers">${configured.map((provider) => renderProvider(provider, surface)).join("") || '<p class="model-empty-providers">No connected providers.</p>'}</div>
      <p>Connect more providers</p>
      ${renderProviderChoices(providers.filter((provider) => provider.connection === "disconnected"), surface)}
      ${customModels ? renderCustomModelsSettings(customModels) : ""}`);
  }
  return setupFrame(surface, `<p>Bring your own subscription or API key</p>${renderProviderChoices(providers, surface)}${setupSkip(surface)}`);
}
function renderProviderChoices(providers: ProviderSummary[], surface: ModelSetupSurface): string {
  const { popular, other } = groupModelProviders(providers);
  return `<div class="model-provider-groups"><div class="model-popular-providers">${popular.map((provider) => renderProvider(provider, surface)).join("")}</div>
    <details>${actionItemHtml({ kind: "single", element: { tag: "summary" }, label: { kind: "text", text: "Other providers" }, leadingHtml: Icons.Disclosure })}
      <div class="model-other-providers-body"><form method="get" action="/settings/models/providers" data-controller="server-filter" data-action="input->server-filter#submit" data-turbo-frame="${providerListFrameId(surface)}">
        <input type="hidden" name="surface" value="${surface}"><input class="text-field" type="search" name="q" placeholder="Find a provider…" aria-label="Find a provider" autocomplete="off"><button type="submit" hidden>Search</button>
      </form>${renderProviderList(other, surface)}</div>
    </details>
  </div>`;
}

async function renderModelSetup(surface: ModelSetupSurface = "settings", customModelsView?: Omit<CustomModelsView, "source">): Promise<string> {
  const customModels = surface === "settings" ? { source: await getCustomModelsJson(), ...customModelsView } : undefined;
  return renderProviderPicker(await providerSummaries(), surface, customModels);
}
function modelSetupDialog(body: string, surface: ModelSetupSurface = "dialog"): string {
  return dialogHtml({ element: { id: surface === "onboarding" ? "onboarding_dialog" : "model_setup_dialog", attributesHtml: "data-dialog-auto-show" }, iconHtml: Icons.Settings, titleCaption: surface === "onboarding" ? "Set up Atelier" : "Models", bodyHtml: body, omitCancelButton: surface === "onboarding" });
}
async function modelSelectionDialog(provider: ProviderSummary, surface: ModelSetupSurface, error = ""): Promise<string> {
  const forgetCaption = `Forget ${provider.label.replace(" / ", "/")} credentials`;
  const disconnect = surface === "settings-dialog" ? `<form method="post" action="/settings/providers/${encodeURIComponent(provider.provider)}/disconnect?surface=${surface}" data-turbo="true">${destructiveConfirmationHtml({
    trigger: { type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Trash, label: forgetCaption } },
    confirmCaption: forgetCaption,
    cancelCaption: "Cancel",
  })}</form>` : "";
  return dialogHtml({
    element: { id: surface === "onboarding" ? "onboarding_dialog" : "model_setup_dialog", attributesHtml: "data-dialog-auto-show" },
    iconHtml: providerBadgeHtml(provider.provider, provider.label, "settings-provider-icon"),
    titleCaption: `${provider.label} Models`,
    headerActionsHtml: disconnect,
    bodyHtml: await renderModelSelection(provider, surface, error),
    omitCancelButton: surface === "onboarding",
  });
}
export async function renderModelSetupDialog(surface: "dialog" | "settings-dialog" | "onboarding" = "dialog"): Promise<string> {
  const providers = await providerSummaries();
  const connected = providers.filter((provider) => provider.connection === "connected");
  if (surface === "onboarding" && connected.length) {
    return modelSelectionDialog(connected[0]!, surface);
  }
  return modelSetupDialog(renderProviderPicker(providers, surface), surface);
}
async function refreshConnectedProviders(): Promise<string> {
  return replace(setupId("settings"), await renderModelSetup("settings"));
}
async function renderModelSetupSettings(): Promise<string> {
  return `<section class="settings-sec settings-sec-models" id="settings-sec-models">${await renderModelSetup("settings")}</section>`;
}
export const modelSettingsContribution = { id: "models", label: "Models", order: 40, render: renderModelSetupSettings };
function renderApiKeyConnectionStep(id: string, label: string, surface: ModelSetupSurface, error = ""): string {
  const inputId = domId("provider_api_key", id);
  const formId = domId("provider_api_key_form", id);
  return renderConnectionStep({ provider: id, label }, surface, {
    bodyHtml: `${error ? `<p class="settings-error" role="alert">${escapeHtml(error)}</p>` : ""}
      <form id="${formId}" class="form-stack" method="post" action="/settings/providers/${encodeURIComponent(id)}/connect?surface=${surface}" data-turbo="true">
        <input id="${inputId}" class="text-field" type="password" aria-label="API key" data-1p-ignore name="secret" placeholder="${escapeHtml(getProviderApiKeyExample(id) ?? "API key")}" autocomplete="off" required autofocus>
      </form>`,
    actionsHtml: setupBack(surface) + buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Connect" }, attributesHtml: `form="${formId}"` }),
  });
}

type PendingPrompt = { input: Exclude<PiAuthPrompt, { type: "select" }>; resolve: (value: string) => void; reject: (error: Error) => void };
type PendingOAuthFlow = {
  id: string;
  provider: string;
  label: string;
  surface: ModelSetupSurface;
  revision: number;
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

async function startOAuthFlow(provider: string, label: string, surface: ModelSetupSurface, refreshComposers: () => Promise<string>): Promise<PendingOAuthFlow> {
  // The credential runtime serializes logins per provider. An abandoned dialog must
  // not leave the next attempt queued behind a device code nobody will approve.
  for (const previous of pendingOAuthFlows.values()) {
    if (previous.provider !== provider || previous.status !== "pending") continue;
    previous.status = "error";
    previous.error = "This sign-in was replaced by a newer attempt. Start again to connect.";
    previous.prompt = undefined;
    previous.abort.abort();
  }
  const flow: PendingOAuthFlow = { id: crypto.randomUUID(), provider, label, surface, revision: 0, status: "pending", abort: new AbortController() };
  pendingOAuthFlows.set(flow.id, flow);
  void loginPiOAuthProvider(provider, {
    signal: flow.abort.signal,
    notify: (event) => {
      if (event.type === "auth_url") { flow.revision++; flow.authUrl = event.url; flow.instructions = event.instructions; }
      else if (event.type === "device_code") { flow.revision++; flow.userCode = event.userCode; flow.verificationUri = event.verificationUri; flow.intervalSeconds = event.intervalSeconds; }
    },
    prompt: (prompt) => handleOAuthPrompt(flow, prompt),
  }).then(async () => {
    await seedProviderFavoriteModels(provider);
    await refreshComposers();
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
    flow.revision++;
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
    content: { kind: "caption", caption: `Open ${authenticationName} sign-in page` },
    attributesHtml: `target="_blank" rel="noreferrer"${hidden ? ' data-oauth-device-auth hidden data-action="oauth-flow#showWaitingStatus"' : ""}`,
  });
}

function oauthDeviceCodeBody(flow: PendingOAuthFlow, complete = false): string {
  const copyButton = copyButtonHtml({
    label: `Copy ${flow.userCode ?? ""} into clipboard`,
    caption: `Copy ${flow.userCode ?? ""}`,
    copyText: flow.userCode ?? "",
    attributesHtml: 'data-action="oauth-flow#showDeviceAuth"',
  });
  const confirmationName = flow.provider === "openai-codex" ? "OpenAI-Codex" : flow.label;
  const status = complete
    ? `<p class="settings-oauth-waiting-status" role="status"><span class="settings-oauth-complete-marker" aria-hidden="true">✓</span><span>${escapeHtml(flow.label)} connected</span></p>`
    : `<p class="settings-oauth-waiting-status" data-oauth-waiting-status hidden><span class="status-spinner" aria-hidden="true"></span><span>Waiting for ${escapeHtml(confirmationName)}…</span></p>`;
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
  return `<form id="${oauthRedirectFormId(flow)}" class="settings-oauth-card" method="post" action="/settings/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/prompt" data-turbo="true"><label for="${inputId}">${escapeHtml(prompt.message)}</label><input id="${inputId}" class="settings-input text-field" type="${prompt.type === "secret" ? "password" : "text"}" name="value" data-1p-ignore placeholder="${escapeHtml(prompt.placeholder ?? "")}"${prompt.type === "manual_code" || prompt.type === "secret" ? " required" : ""}></form>`;
}

function oauthBrowserRedirectBody(flow: PendingOAuthFlow): string {
  const prompt = flow.prompt;
  const promptForm = oauthPromptForm(flow);
  return `<div class="settings-oauth-card">
    <p>After signing in, copy the localhost URL here—even if that page won’t load.</p>
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

function renderOAuthConnectionStep(flow: PendingOAuthFlow): string {
  const pollMs = Math.max(1500, Math.min(15000, (flow.intervalSeconds ?? 3) * 1000));
  const doneButton = buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Done" } });
  const backButton = buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "Back" } });
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
      ? `<form method="post" action="/settings/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/cancel" data-turbo="true">${backButton}</form>${flow.prompt ? submitUrlButton : ""}`
      : `<form method="post" action="/settings/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/finish" data-turbo="true">${backButton}</form>`;
  return renderConnectionStep(flow, flow.surface, {
    bodyHtml: body,
    actionsHtml: action,
    attributesHtml: `data-controller="oauth-flow" data-oauth-flow-status-url-value="/settings/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/status?revision=${flow.revision}" data-oauth-flow-active-value="${flow.status === "pending" && !(flow.prompt && !flow.authUrl && !flow.verificationUri)}" data-oauth-flow-poll-ms-value="${pollMs}"`,
  });
}
async function connectedStep(provider: string, surface: ModelSetupSurface, renderPickerUpdates: () => Promise<string>, error = ""): Promise<Response> {
  const summary = (await providerSummaries()).find((candidate) => candidate.provider === provider)!;
  return stream(replace(surface === "onboarding" ? "onboarding_dialog" : "model_setup_dialog", await modelSelectionDialog(summary, surface, error)) + await refreshConnectedProviders() + await renderPickerUpdates());
}

export async function handleModelSettingsRequest(request: Request, url: URL, renderPickerUpdates: () => Promise<string>, finishOnboarding: () => Promise<Response>): Promise<Response | undefined> {
  if (!url.pathname.startsWith("/settings/models/") && !url.pathname.startsWith("/settings/providers/")) return undefined;
  const surface = modelSetupSurfaces.find((candidate) => candidate === (url.searchParams.get("surface") ?? "settings"));
  if (!surface) return response("Unknown model setup surface", { status: 400 });
  if (url.pathname === "/settings/models/step" && (request.method === "GET" || request.method === "POST")) {
    const providerId = url.searchParams.get("provider");
    if (!providerId) {
      if (surface === "dialog" || surface === "settings-dialog") return stream(replace("model_setup_dialog", modelSetupDialog(await renderModelSetup(surface))));
      return response(await renderModelSetup(surface));
    }
    const provider = (await providerSummaries()).find((candidate) => candidate.provider === providerId);
    if (!provider) return response("Unknown provider", { status: 400 });
    const targetSurface = surface === "settings" ? "settings-dialog" : surface;
    if (provider.connection === "connected") {
      const html = await modelSelectionDialog(provider, targetSurface);
      return stream(surface === "settings" ? remove("model_setup_dialog") + append("settings_modal_host", html)
        : replace(surface === "onboarding" ? "onboarding_dialog" : "model_setup_dialog", html));
    }
    const method = provider.connection === "needs_attention" ? "oauth" : provider.methods.length === 1 ? provider.methods[0] : undefined;
    const step = method === "oauth"
      ? renderOAuthConnectionStep(await startOAuthFlow(provider.provider, provider.label, targetSurface, renderPickerUpdates))
      : method === "api_key" ? renderApiKeyConnectionStep(provider.provider, provider.label, targetSurface)
      : renderConnectionMethods(provider, targetSurface);
    return stream(surface === "settings"
      ? remove("model_setup_dialog") + append("settings_modal_host", modelSetupDialog(step))
      : replace(setupId(surface), step));
  }
  if (url.pathname === "/settings/models/finish" && request.method === "POST") {
    const provider = url.searchParams.get("provider") ?? "";
    if (!await providerHasFavorite(provider)) return response("Choose at least one available model", { status: 422 });
    if (surface === "onboarding") return await finishOnboarding();
    return stream(remove("model_setup_dialog") + await refreshConnectedProviders() + await renderPickerUpdates());
  }
  if (url.pathname === "/settings/models/providers" && request.method === "GET") {
    const providers = await providerSummaries();
    const choices = surface === "onboarding" ? providers : providers.filter((provider) => provider.connection === "disconnected");
    return response(renderProviderList(groupModelProviders(choices).other, surface, url.searchParams.get("q") ?? ""));
  }
  if (url.pathname === "/settings/models/catalogue" && request.method === "GET") {
    const provider = (await providerSummaries()).find((candidate) => candidate.provider === url.searchParams.get("provider"));
    if (!provider) return response("Unknown provider", { status: 400 });
    const catalogue = provider.connection === "connected" ? await providerCatalogue(provider.provider) : [];
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
    const fromSettings = surface === "settings-dialog";
    const html = await renderModelSetupDialog(fromSettings ? "settings-dialog" : "dialog");
    return wantsStream(request) ? stream(fromSettings ? remove("model_setup_dialog") + append("settings_modal_host", html) : update("settings_modal_host", html)) : response(html);
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
    const summary = (await providerSummaries()).find((candidate) => candidate.provider === provider);
    if (!summary) return response("Unknown provider", { status: 400 });
    if (summary.connection === "connected") return connectedStep(provider, surface, renderPickerUpdates);
    if (!summary.methods.includes(method)) return response("Unsupported authentication method", { status: 400 });
    return stream(replace(setupId(surface), method === "oauth" ? renderOAuthConnectionStep(await startOAuthFlow(provider, summary.label, surface, renderPickerUpdates)) : renderApiKeyConnectionStep(provider, summary.label, surface)));
  }
  match = url.pathname.match(/^\/settings\/providers\/([^/]+)\/connect$/);
  if (match && request.method === "POST") {
    const provider = decodeURIComponent(match[1]!);
    const summary = (await providerSummaries()).find((candidate) => candidate.provider === provider);
    if (!summary || !summary.methods.includes("api_key")) return response("Unknown API key provider", { status: 400 });
    if (summary.connection === "connected") return connectedStep(provider, surface, renderPickerUpdates);
    const form = await request.formData();
    try {
      await connectModelProviderApiKey(provider, String(form.get("secret") ?? ""));
      await seedProviderFavoriteModels(provider);
    } catch (error) {
      if (error instanceof ProviderCatalogueRefreshError) return connectedStep(provider, surface, renderPickerUpdates, error.message);
      return stream(replace(setupId(surface), renderApiKeyConnectionStep(provider, summary.label, surface, error instanceof Error ? error.message : String(error))));
    }
    return connectedStep(provider, surface, renderPickerUpdates);
  }
  match = url.pathname.match(/^\/settings\/providers\/([^/]+)\/oauth\/([^/]+)\/(status|prompt|finish|cancel)$/);
  if (match && request.method === "POST") {
    const provider = decodeURIComponent(match[1]!);
    const flowId = decodeURIComponent(match[2]!);
    const action = match[3]!;
    const flow = pendingOAuthFlows.get(flowId);
    if (!flow || flow.provider !== provider) return response("Sign-in session expired", { status: 410 });
    if (action === "prompt") {
      const form = await request.formData();
      flow.redirectSubmitted = true;
      flow.prompt?.resolve(String(form.get("value") ?? ""));
      flow.prompt = undefined;
      await waitForOAuthFlowReady(flow);
    }
    if (flow.status === "complete") {
      pendingOAuthFlows.delete(flowId);
      return connectedStep(provider, flow.surface, renderPickerUpdates);
    }
    if (action === "cancel" || action === "finish") {
      flow.abort.abort();
      pendingOAuthFlows.delete(flowId);
      return stream((flow.surface === "settings-dialog" ? remove("model_setup_dialog") : replace(setupId(flow.surface), await renderModelSetup(flow.surface))) + (flow.status === "error" ? await refreshConnectedProviders() : "") + await renderPickerUpdates());
    }
    if (action === "status" && flow.status === "pending" && url.searchParams.get("revision") === String(flow.revision)) return stream("");
    return stream(replace(setupId(flow.surface), renderOAuthConnectionStep(flow)));
  }
  match = url.pathname.match(/^\/settings\/providers\/([^/]+)\/disconnect$/);
  if (match && request.method === "POST") {
    const provider = decodeURIComponent(match[1]!);
    await disconnectModelProvider(provider);
    return stream(remove("model_setup_dialog") + await refreshConnectedProviders() + await renderPickerUpdates());
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
  const current = await getConfiguredModels();
  const index = current.findIndex((candidate) => modelKey(candidate) === modelKey(model));
  if (favorite && index < 0) current.push({ provider: option.provider, id: option.id, label: option.label });
  if (!favorite && index >= 0) current.splice(index, 1);
  await setConfiguredModels(current);
  const actions = modelSetupSurfaces.map((surface) =>
    replaceTargets(`.${domId("model_catalogue_row", surface, model.provider, model.id)}`, catalogueModelRow({ ...option, configured: favorite }, surface))
    + replaceTargets(`.${domId("model_favorites", surface, model.provider)}`, renderFavorites(current, surface, model.provider)),
  ).join("");
  return stream(actions + replaceTargets(`.${domId("model_setup_continue", model.provider)}`, continueButton(model.provider, await providerHasFavorite(model.provider))) + await renderPickerUpdates());
}
