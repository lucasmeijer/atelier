import { actionLinkHtml } from "@atelier/design-system/action-link";
import { escapeHtml, type SettingsContribution } from "@atelier/shared";
import { readDockerRuntimeConnection, readSharedLayerStorage, readSharedContentStorage, type SharedContentStorage, readBuildCacheStorage, type BuildCacheStorage, type SharedLayerStorage, type DockerRuntimeConnection } from "@atelier/workspace-image";
import { response } from "./http.ts";

function timestamp(value: string): string {
  const caption = new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" });
  return `<time datetime="${escapeHtml(value)}">${escapeHtml(caption)} UTC</time>`;
}

function gb(bytes: number): string {
  if (bytes > 0 && bytes < 10_000_000) return "&lt;0.01 GB";
  return `${(bytes / 1_000_000_000).toLocaleString("en", { maximumFractionDigits: 2 })} GB`;
}

function measurementFooter(stats: Pick<SharedLayerStorage, "measuredAt" | "gcFailure">): string {
  return `<p class="settings-health-caption">Measured ${timestamp(stats.measuredAt)}</p>
    ${stats.gcFailure ? `<div class="settings-error" role="alert"><strong>Last cleanup failed</strong><p>${escapeHtml(stats.gcFailure.message)}</p><p>${timestamp(stats.gcFailure.at)}</p></div>` : ""}`;
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
    ${measurementFooter(stats)}
  `;
}

function contentStorageResult(stats: SharedContentStorage): string {
  const overTarget = stats.totalBytes > stats.targetBytes;
  const protectedBytes = stats.pinnedBytes + stats.ingestBytes;
  return `<dl class="settings-health-metrics${overTarget ? " settings-health-over-target" : ""}">
      <div><dt>Pinned</dt><dd>${gb(stats.pinnedBytes)}</dd></div>
      <div><dt>Reclaimable</dt><dd>${gb(stats.reclaimableBytes)}</dd></div>
      <div><dt>Total</dt><dd>${gb(stats.totalBytes)}</dd></div>
      <div><dt>GC target</dt><dd>${gb(stats.targetBytes)}</dd></div>
    </dl>
    <p class="settings-health-status${overTarget ? " settings-health-over-target" : ""}" role="status"><span class="status-dot ${overTarget ? "warning" : "success"}" aria-hidden="true"></span>${overTarget ? "Above cleanup target. Pinned content and uploads are protected." : "Within cleanup target."}</p>
    ${protectedBytes > stats.targetBytes ? `<p class="settings-health-over-target">Cannot reach target: pinned content and uploads exceed ${gb(stats.targetBytes)}.</p>` : ""}
    <p class="settings-health-caption">Unowned blobs expire after ${stats.retentionDays} days. Above target, younger unowned blobs are removed oldest-first. This is a soft target, not a hard quota.</p>
    <p class="settings-health-caption">Running and parked workspaces retain their pins until deletion; Docker image pruning does not release them. Pre-existing blobs are protected until all potential existing consumers are deleted.</p>
    <p class="settings-health-caption">Content payload bytes, including ${gb(stats.ingestBytes)} of unfinished uploads in Total. Excludes filesystem overhead, unpacked layers, registry storage and BuildKit cache.</p>
    ${measurementFooter(stats)}`;
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
    ${measurementFooter(stats)}`;
}

interface StorageSection {
  id: string;
  path: string;
  title: string;
  caption: string;
  measure(connection: DockerRuntimeConnection): Promise<string>;
}

const storageSections: StorageSection[] = [
  {
    id: "settings_shared_layer_storage", path: "/settings/system-health/storage",
    title: "Shared unpacked image layers", caption: "Installation-wide shared image storage",
    measure: async connection => storageResult(await readSharedLayerStorage(connection)),
  },
  {
    id: "settings_shared_content_storage", path: "/settings/system-health/content",
    title: "Shared compressed content", caption: "Installation-wide content store",
    measure: async connection => contentStorageResult(await readSharedContentStorage(connection)),
  },
  {
    id: "settings_build_cache_storage", path: "/settings/system-health/build-cache",
    title: "Build cache", caption: "Installation-wide BuildKit cache",
    measure: async connection => connection.buildServices
      ? buildCacheResult(await readBuildCacheStorage(connection))
      : `<p class="settings-health-caption" role="status">Shared BuildKit runtime not available.</p>`,
  },
];

async function renderStorageFrame(section: StorageSection): Promise<string> {
  let content: string;
  try {
    const connection = await readDockerRuntimeConnection();
    content = connection
      ? await section.measure(connection)
      : `<p class="settings-health-caption" role="status">Shared runtime not available.</p>`;
  } catch (error) {
    console.error(`System Health measurement failed: ${section.title}`, error);
    content = `<p class="settings-error" role="alert">Could not measure ${escapeHtml(section.title.toLowerCase())}: ${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`;
  }
  const refresh = actionLinkHtml({ href: section.path, variant: "secondary", content: { kind: "caption", caption: "Refresh" }, attributesHtml: `data-turbo-frame="${section.id}"` });
  return `<turbo-frame id="${section.id}"><div class="settings-health-heading"><h3>${escapeHtml(section.title)}</h3>${refresh}</div><p class="settings-health-caption">${escapeHtml(section.caption)}</p><p class="settings-health-refreshing" role="status"><span class="status-dot running" aria-hidden="true"></span> Measuring storage…</p><div class="settings-health-result">${content}</div></turbo-frame>`;
}

export const systemHealthSettings: SettingsContribution = {
  id: "system-health",
  label: "System health",
  order: 90,
  async render() {
    const frames = storageSections.map(section => `<turbo-frame id="${section.id}" src="${section.path}"><p role="status"><span class="status-dot running" aria-hidden="true"></span> Measuring ${escapeHtml(section.title.toLowerCase())}…</p></turbo-frame>`).join("");
    return `<section class="settings-sec settings-health" id="settings-sec-system-health"><h2>System health</h2>${frames}</section>`;
  },
  async handleAction({ request, url }) {
    const section = storageSections.find(section => section.path === url.pathname);
    if (request.method === "GET" && section) return response(await renderStorageFrame(section));
    return undefined;
  },
};
