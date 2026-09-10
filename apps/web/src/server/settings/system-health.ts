import { actionLinkHtml } from "@atelier/design-system/action-link";
import { escapeHtml, type SettingsContribution } from "@atelier/shared";
import { readDockerRuntimeConnection, readSharedLayerStorage, readBuildCacheStorage, type BuildCacheStorage, type SharedLayerStorage } from "@atelier/workspace-image";
import { response } from "./http.ts";

const frameId = "settings_shared_layer_storage";
const statsPath = "/settings/system-health/storage";
const buildCacheFrameId = "settings_build_cache_storage";
const buildCachePath = "/settings/system-health/build-cache";

function timestamp(value: string): string {
  const caption = new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" });
  return `<time datetime="${escapeHtml(value)}">${escapeHtml(caption)} UTC</time>`;
}

function gb(bytes: number): string {
  if (bytes > 0 && bytes < 10_000_000) return "&lt;0.01 GB";
  return `${(bytes / 1_000_000_000).toLocaleString("en", { maximumFractionDigits: 2 })} GB`;
}

function storageResult(stats: SharedLayerStorage): string {
  const overTarget = stats.totalBytes > stats.targetBytes;
  return `<dl class="settings-health-metrics${overTarget ? " settings-health-over-target" : ""}">
      <div><dt>Used</dt><dd>${gb(stats.usedBytes)}</dd></div>
      <div><dt>Unused</dt><dd>${gb(stats.unusedBytes)}</dd></div>
      <div><dt>Total</dt><dd>${gb(stats.totalBytes)}</dd></div>
      <div><dt>Target</dt><dd>${gb(stats.targetBytes)}</dd></div>
    </dl>
    <p class="settings-health-status${overTarget ? " settings-health-over-target" : ""}" role="status"><span class="status-dot ${overTarget ? "warning" : "success"}" aria-hidden="true"></span>${overTarget ? "Above cleanup target. Referenced layers are protected." : "Within cleanup target."}</p>
    ${stats.usedBytes > stats.targetBytes ? `<p class="settings-health-over-target">Cannot reach target: layers still in use exceed ${gb(stats.targetBytes)}.</p>` : ""}
    <p class="settings-health-caption">Used includes parked workspaces and in-progress unpacking. Unused layers are reclaimed automatically when above target.</p>
    <p class="settings-health-caption">Measured ${timestamp(stats.measuredAt)}</p>
    ${stats.gcFailure ? `<div class="settings-error" role="alert"><strong>Last cleanup failed</strong><p>${escapeHtml(stats.gcFailure.message)}</p><p>${timestamp(stats.gcFailure.at)}</p></div>` : ""}
  `;
}

async function renderStorageFrame(): Promise<string> {
  let content: string;
  try {
    const connection = await readDockerRuntimeConnection();
    content = connection
      ? storageResult(await readSharedLayerStorage(connection))
      : `<p class="settings-health-caption" role="status">Shared runtime not available.</p>`;
  } catch (error) {
    console.error("System Health storage measurement failed", error);
    content = `<p class="settings-error" role="alert">Could not measure shared image storage: ${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`;
  }
  const refresh = actionLinkHtml({ href: statsPath, variant: "secondary", content: { kind: "caption", caption: "Refresh" }, attributesHtml: `data-turbo-frame="${frameId}"` });
  return `<turbo-frame id="${frameId}"><div class="settings-health-heading"><h3>Shared unpacked image layers</h3>${refresh}</div><p class="settings-health-caption">Installation-wide shared image storage</p><p class="settings-health-refreshing" role="status"><span class="status-dot running" aria-hidden="true"></span> Measuring storage…</p><div class="settings-health-result">${content}</div></turbo-frame>`;
}

function buildCacheResult(stats: BuildCacheStorage): string {
  const overTarget = stats.targetBytes !== null && stats.totalBytes > stats.targetBytes;
  const warning = overTarget || !stats.gcEnabled;
  const status = !stats.gcEnabled ? "Automatic cleanup is disabled on one or more workers."
    : overTarget ? "Above cleanup target. In-use cache is protected."
    : stats.targetBytes === null ? "Automatic cleanup enabled; no overall size target." : "Within cleanup target.";
  return `<dl class="settings-health-metrics${overTarget ? " settings-health-over-target" : ""}">
      <div><dt>In use</dt><dd>${gb(stats.inUseBytes)}</dd></div>
      <div><dt>Reclaimable</dt><dd>${gb(stats.reclaimableBytes)}</dd></div>
      <div><dt>Total</dt><dd>${gb(stats.totalBytes)}</dd></div>
      <div><dt>GC target</dt><dd>${stats.targetBytes === null ? "Not configured" : gb(stats.targetBytes)}</dd></div>
    </dl>
    <p class="settings-health-status${warning ? " settings-health-over-target" : ""}" role="status"><span class="status-dot ${warning ? "warning" : "success"}" aria-hidden="true"></span>${status}</p>
    <p class="settings-health-caption">BuildKit-accounted cache, separate from shared unpacked image layers and registry storage. Reclaimable cache is removed according to GC policies. The target is not a hard quota; free-space rules may reclaim more.</p>
    <p class="settings-health-caption">Measured ${timestamp(stats.measuredAt)}</p>`;
}

async function renderBuildCacheFrame(): Promise<string> {
  let content: string;
  try {
    const connection = await readDockerRuntimeConnection();
    content = connection?.buildServices
      ? buildCacheResult(await readBuildCacheStorage(connection))
      : `<p class="settings-health-caption" role="status">Shared BuildKit runtime not available.</p>`;
  } catch (error) {
    console.error("System Health BuildKit measurement failed", error);
    content = `<p class="settings-error" role="alert">Could not measure build cache: ${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`;
  }
  const refresh = actionLinkHtml({ href: buildCachePath, variant: "secondary", content: { kind: "caption", caption: "Refresh" }, attributesHtml: `data-turbo-frame="${buildCacheFrameId}"` });
  return `<turbo-frame id="${buildCacheFrameId}"><div class="settings-health-heading"><h3>Build cache</h3>${refresh}</div><p class="settings-health-caption">Installation-wide BuildKit cache</p><p class="settings-health-refreshing" role="status"><span class="status-dot running" aria-hidden="true"></span> Measuring build cache…</p><div class="settings-health-result">${content}</div></turbo-frame>`;
}

export const systemHealthSettings: SettingsContribution = {
  id: "system-health",
  label: "System health",
  order: 90,
  async render() {
    return `<section class="settings-sec settings-health" id="settings-sec-system-health"><h2>System health</h2><turbo-frame id="${frameId}" src="${statsPath}"><p role="status"><span class="status-dot running" aria-hidden="true"></span> Measuring shared image storage…</p></turbo-frame><turbo-frame id="${buildCacheFrameId}" src="${buildCachePath}"><p role="status"><span class="status-dot running" aria-hidden="true"></span> Measuring build cache…</p></turbo-frame></section>`;
  },
  async handleAction({ request, url }) {
    if (request.method === "GET" && url.pathname === statsPath) return response(await renderStorageFrame());
    if (request.method === "GET" && url.pathname === buildCachePath) return response(await renderBuildCacheFrame());
    return undefined;
  },
};
