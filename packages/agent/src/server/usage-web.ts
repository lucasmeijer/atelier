import { requestAcceptsJson } from "@atelier/core";
import { getConfiguredAgentModels } from "./pi-config-models.ts";
import { selectPacingWindow } from "./usage-window.ts";
import { connectedUsageProviders, getProviderUsageOverview, supportedUsageProviders, type ProviderUsageOverview, type UsageProvider } from "./provider-usage.ts";
import type { MeasuredUsage } from "./usage-ledger.ts";
import { actionLinkHtml } from "@atelier/design-system/action-link";
import { dialogHtml } from "@atelier/design-system/dialog";
import { Icons } from "@atelier/design-system/icons";
import { escapeHtml, providerBrandColor, providerBrandIconHtml, turboStream, turboStreamResponse, workspaceModuleModalFrameId, workspaceAgentSelectionEvent, type WorkspaceModuleRouteContext } from "@atelier/shared";

function response(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function jsonResponse<Body extends object>(body: Body, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function providerIcon(provider: string, label: string): string {
  return `<div class="usage-provider-icon" style="--provider-color:${providerBrandColor(provider)}">${providerBrandIconHtml(provider, label)}</div>`;
}

export function renderUsagePaneAction(): string {
  const button = usageButtonHtml();
  const actions = [
    ...[workspaceAgentSelectionEvent, "atelier:usage-provider:changed", "atelier:workspace-residency-visible", "atelier:workspace-residency-hidden"].map((event) => `${event}@document->usage-button#selectionChanged:capture`),
    "atelier:usage:refreshed@document->usage-button#refresh",
    "visibilitychange@document->usage-button#refresh",
    "focus@window->usage-button#refresh",
  ].join(" ");
  return `<span data-controller="usage-button" data-action="${actions}"><template data-usage-button-target="empty">${button}</template><turbo-frame id="usage_button_content">${button}</turbo-frame></span>`;
}
const overviewFrameId = "usage_overview";
const providerPath = (id: string) => `/usage/providers/${encodeURIComponent(id)}`;
const providerFrameId = (id: string) => `usage_provider_${id}`;
const number = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 1 });
const date = (value: string) => new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Two compact units for allowance windows, reset countdowns, and pacing gaps. */
function usageDuration(seconds: number): string {
  let remaining = Math.max(0, Math.floor(seconds));
  const parts: string[] = [];
  for (const [size, suffix] of [[86400, "d"], [3600, "h"], [60, "m"], [1, "s"]] as const) {
    const count = Math.floor(remaining / size);
    remaining %= size;
    if (count) parts.push(`${count}${suffix}`);
    if (parts.length === 2) break;
  }
  return parts.join(" ") || "0s";
}

/** Display the schedule distance, not a prediction of allowance exhaustion. */
function usagePace(seconds: number | null): string {
  if (seconds === null) return "";
  if (Math.abs(seconds) < 1) return "On pace";
  return `${usageDuration(Math.abs(seconds))} ${seconds > 0 ? "ahead of" : "behind"} pace`;
}

function measuredBreakdown(measured: MeasuredUsage): string {
  return `<dl class="usage-token-breakdown"><div><dt>Input (uncached)</dt><dd>${number(measured.input)}</dd></div><div><dt>Cached input</dt><dd>${number(measured.cacheRead)}</dd></div><div><dt>Cache writes</dt><dd>${number(measured.cacheWrite)}</dd></div><div><dt>Output incl. reasoning</dt><dd>${number(measured.output)}</dd></div></dl>`;
}

function renderUsageWindow({ reported: window, measured: local, timing }: ProviderUsageOverview["windows"][number]): string {
  const label = `${window.limitName} · ${usageDuration(window.durationSeconds)}`;
  const remaining = (new Date(window.resetsAt).getTime() - Date.now()) / 1000;
  const difference = timing.paceDifferenceSeconds;
  const pace = usagePace(difference);
  return `<article class="usage-limit"><h4>${escapeHtml(label)}</h4>
    <div class="usage-limit-heading usage-caption"><span title="Window start inferred from reset time minus duration">Time <strong>${number(timing.elapsedPercent)}%</strong></span><span>Usage <strong>${number(window.usedPercent)}%</strong></span></div>
    <div class="usage-comparison${difference === null ? " usage-comparison--inactive" : ""}" aria-hidden="true">
      <span class="usage-comparison__time" style="width:${timing.elapsedPercent}%"></span>
      <span class="usage-comparison__usage" style="width:${window.usedPercent}%"></span>
      <span class="usage-comparison__shared" style="width:${Math.min(timing.elapsedPercent, window.usedPercent)}%"></span>
    </div>
    <div class="usage-limit-heading usage-caption"><span>${remaining > 0 ? `Resets in ${usageDuration(remaining)}` : "Reset due"}</span>${pace ? `<span title="Distance along the linear allowance schedule, not a forecast">${pace}</span>` : ""}</div>
    ${local ? `<details class="usage-window-local"><summary>Atelier · <strong>${number(local.totalTokens)} tokens</strong>${local.partialCoverage ? " · partial" : ""}${window.meteredFeature ? " · all Codex" : ""}</summary>${measuredBreakdown(local)}</details>` : ""}
  </article>`;
}

function renderUsageLimits({ reported, error, windows }: ProviderUsageOverview): string {
  if (error) return `<p class="usage-error" role="alert">${escapeHtml(error)}</p>`;
  if (!reported) return "<p>Disconnected.</p>";
  const used = windows.filter(({ reported }) => reported.usedPercent > 0);
  const unused = windows.filter(({ reported }) => reported.usedPercent === 0);
  return `${reported.limitReached || reported.allowed === false ? '<p class="usage-error" role="status">Subscription limit reached.</p>' : ""}${used.map(renderUsageWindow).join("")}${unused.length ? `<details class="usage-unused"><summary>Unused limits (${unused.length})</summary><div class="usage-section">${unused.map(renderUsageWindow).join("")}</div></details>` : ""}${windows.length ? "" : '<p>No limits reported.</p>'}`;
}

function renderUsageProvider(overview: ProviderUsageOverview): string {
  const { reported, measured } = overview;
  return `<section class="usage-provider" data-controller="usage-snapshot"><header class="usage-provider-heading"><h2>${providerIcon(overview.provider.id, overview.provider.label)}${escapeHtml(overview.provider.label)}</h2>${reported ? `<span class="usage-plan">${escapeHtml(reported.plan)}</span>` : ""}</header>
    <section class="usage-section">
      ${renderUsageLimits(overview)}
    </section>
    <section class="usage-section"><div class="usage-limit-heading"><h3>Atelier</h3><span class="usage-caption">30d · this installation</span></div>
      <div class="usage-total"><strong>${number(measured.totalTokens)}</strong><span>tokens · ${number(measured.requests)} ${measured.requests === 1 ? "response" : "responses"}</span></div>
      <details><summary>Token breakdown${measured.partialCoverage ? ` · tracked since ${date(measured.trackingSince)}` : ""}</summary>${measuredBreakdown(measured)}<p class="usage-caption">Includes all accounts used here. Tokens aren’t equivalent to subscription percentages.${measured.partialCoverage ? " Earlier usage is not recorded." : ""}</p></details>
    </section>
  </section>`;
}

function usageButtonHtml(comparison?: { referencePercent: number; valuePercent: number }, label = "Usage"): string {
  return actionLinkHtml({ href: "/usage", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Usage, label }, perimeterComparison: comparison, attributesHtml: `data-turbo-frame="${workspaceModuleModalFrameId}"` });
}

async function renderUsageButton(providerId: string | null): Promise<string> {
  // Direct Usage/Settings pages have no visible workspace. Use the persisted
  // most-recent model choice, not an arbitrary connected provider.
  providerId ??= (await getConfiguredAgentModels()).find((model) => model.active)?.provider ?? null;
  const provider = supportedUsageProviders.find((provider) => provider.id === providerId);
  if (!provider) return usageButtonHtml(undefined, providerId ? `Usage — ${providerId}: limits not supported` : "Usage");
  const overview = await getProviderUsageOverview(provider);
  const selected = selectPacingWindow(overview.windows);
  if (!selected) return usageButtonHtml(undefined, `Usage — ${provider.label}: limits unavailable`);
  const { reported, timing } = selected;
  const pace = usagePace(timing.paceDifferenceSeconds);
  return usageButtonHtml({ referencePercent: timing.elapsedPercent, valuePercent: reported.usedPercent }, `Usage — ${provider.label} · ${reported.limitName} ${usageDuration(reported.durationSeconds)}: Time ${number(timing.elapsedPercent)}%, Usage ${number(reported.usedPercent)}% · ${pace}`);
}

function providerPlaceholder(provider: UsageProvider): string {
  return `<turbo-frame id="${providerFrameId(provider.id)}" src="${providerPath(provider.id)}"><section class="usage-provider"><h2>${escapeHtml(provider.label)}</h2><p role="status"><span class="status-spinner" aria-hidden="true"></span> Loading…</p></section></turbo-frame>`;
}

async function renderUsageOverview(): Promise<string> {
  const providers = await connectedUsageProviders();
  return `<turbo-frame id="${overviewFrameId}" class="usage-overview">${providers.map(providerPlaceholder).join("") || '<p class="usage-caption">Connect OpenAI Codex in Settings to see usage.</p>'}</turbo-frame>`;
}

async function renderUsageDialog(): Promise<string> {
  return dialogHtml({
    element: { id: "usage_dialog", attributesHtml: "data-dialog-auto-show" },
    iconHtml: Icons.Usage,
    titleCaption: "Usage",
    bodyHtml: await renderUsageOverview(),
    footerHtml: actionLinkHtml({ href: "/usage/overview", variant: "secondary", content: { kind: "caption", caption: "Refresh" }, attributesHtml: `data-turbo-frame="${overviewFrameId}"` }),
  });
}

export async function handleUsageRequest(request: Request, url: URL, context: WorkspaceModuleRouteContext): Promise<Response | undefined> {
  if (request.method !== "GET") return undefined;
  const json = requestAcceptsJson(request);
  if (url.pathname === "/usage/button") {
    const button = await renderUsageButton(url.searchParams.get("provider"));
    return request.headers.get("accept")?.includes("text/vnd.turbo-stream.html")
      ? turboStreamResponse(turboStream("update", "usage_button_content", button))
      : response(`<turbo-frame id="usage_button_content">${button}</turbo-frame>`);
  }
  if (url.pathname === "/usage") {
    if (json) return jsonResponse({ providers: await Promise.all((await connectedUsageProviders()).map(getProviderUsageOverview)) });
    const dialog = await renderUsageDialog();
    return request.headers.has("turbo-frame")
      ? response(`<turbo-frame id="${workspaceModuleModalFrameId}">${dialog}</turbo-frame>`)
      : context.renderModalPage(dialog);
  }
  if (url.pathname === "/usage/overview") return response(await renderUsageOverview());
  const match = url.pathname.match(/^\/usage\/providers\/([^/]+)$/);
  if (!match) return undefined;
  const provider = supportedUsageProviders.find((provider) => provider.id === match[1]);
  if (!provider) return jsonResponse({ error: { code: "unsupported_usage_provider", message: "Subscription usage is not supported for this provider." } }, 404);
  const overview = await getProviderUsageOverview(provider);
  return json ? jsonResponse(overview) : response(`<turbo-frame id="${providerFrameId(provider.id)}">${renderUsageProvider(overview)}</turbo-frame>`);
}
