import { actionItemHtml } from "@atelier/design-system/action-item";
import { Icons } from "@atelier/design-system/icons";
import { actionLinkHtml } from "@atelier/design-system/action-link";
import { escapeHtml, type SettingsContribution } from "@atelier/shared";
import { readDockerRuntimeConnection, readSharedLayerStorage, readSharedContentStorage, type SharedContentStorage, readBuildCacheStorage, type BuildCacheStorage, type SharedLayerStorage, type DockerRuntimeConnection } from "@atelier/workspace-image";
import { response, update } from "./http.ts";

function timestamp(value: string): string {
  const date = new Date(value);
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  const units = [[31_536_000, "year"], [2_592_000, "month"], [86_400, "day"], [3600, "hour"], [60, "minute"]] as const;
  const unit = units.find(([duration]) => seconds >= duration);
  const caption = unit ? new Intl.RelativeTimeFormat("en", { numeric: "always" }).format(-Math.floor(seconds / unit[0]), unit[1]) : "just now";
  return `<time datetime="${escapeHtml(value)}" title="${escapeHtml(date.toUTCString())}">${caption}</time>`;
}

function gb(bytes: number): string {
  if (bytes > 0 && bytes < 10_000_000) return "&lt;0.01 GB";
  return `${(bytes / 1_000_000_000).toLocaleString("en", { maximumFractionDigits: 2 })} GB`;
}

function measurementFooter(stats: Pick<SharedLayerStorage, "measuredAt" | "gcFailure">): string {
  return `${stats.gcFailure ? `<div class="settings-error" role="alert"><strong>Last cleanup failed</strong><p>${escapeHtml(stats.gcFailure.message)}</p><p>${timestamp(stats.gcFailure.at)}</p></div>` : ""}`;
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

interface StorageMeasurement {
  totalBytes: number;
  targetBytes: number | null;
  measuredAt: string;
  content: string;
}

function usageSummary(stats: StorageMeasurement): string {
  const total = gb(stats.totalBytes).replace(" GB", "");
  return `<span title="Storage used / cleanup target">${stats.targetBytes === null ? `${total} GB · no target` : `${total} / ${gb(stats.targetBytes)}`}</span>`;
}

interface StorageSection {
  id: string;
  path: string;
  title: string;
  caption: string;
  measure(connection: DockerRuntimeConnection): Promise<StorageMeasurement | null>;
}

const storageSections: StorageSection[] = [
  {
    id: "settings_shared_layer_storage", path: "/settings/system-health/storage",
    title: "Unpacked docker image layers", caption: "Installation-wide shared image storage",
    measure: async connection => {
      const stats = await readSharedLayerStorage(connection);
      return { ...stats, content: storageResult(stats) };
    },
  },
  {
    id: "settings_shared_content_storage", path: "/settings/system-health/content",
    title: "Compressed docker image layers", caption: "Installation-wide content store",
    measure: async connection => {
      const stats = await readSharedContentStorage(connection);
      return { ...stats, content: contentStorageResult(stats) };
    },
  },
  {
    id: "settings_build_cache_storage", path: "/settings/system-health/build-cache",
    title: "BuildKit cache", caption: "Installation-wide BuildKit cache",
    measure: async connection => {
      if (!connection.buildServices) return null;
      const stats = await readBuildCacheStorage(connection);
      return { ...stats, content: buildCacheResult(stats) };
    },
  },
];

async function renderStorageFrame(section: StorageSection): Promise<string> {
  let content: string;
  let summary = "Unavailable";
  let measuredAt = "";
  try {
    const connection = await readDockerRuntimeConnection();
    const measurement = connection ? await section.measure(connection) : null;
    content = measurement ? measurement.content : `<p class="settings-health-caption" role="status">Shared runtime not available.</p>`;
    if (measurement) {
      summary = usageSummary(measurement);
      measuredAt = `Measured ${timestamp(measurement.measuredAt)}`;
    }
  } catch (error) {
    summary = "Could not measure";
    console.error(`System Health measurement failed: ${section.title}`, error);
    content = `<p class="settings-error" role="alert">Could not measure ${escapeHtml(section.title.toLowerCase())}: ${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`;
  }
  const refresh = actionLinkHtml({ href: section.path, variant: "secondary", content: { kind: "caption", caption: "Refresh" }, attributesHtml: `data-turbo-frame="${section.id}"` });
  return `<turbo-frame id="${section.id}"><p class="settings-health-refreshing" role="status"><span class="status-dot running" aria-hidden="true"></span> Measuring storage…</p><div class="settings-health-result">${content}</div><div class="settings-health-footer"><span class="settings-health-caption">${measuredAt}</span>${refresh}</div>${update(`${section.id}_summary`, summary)}</turbo-frame>`;
}

export const systemHealthSettings: SettingsContribution = {
  id: "system-health",
  label: "System health",
  order: 90,
  async render() {
    const sources = storageSections.map(section => `<details class="settings-health-source">
      ${actionItemHtml({ kind: "single", element: { tag: "summary" }, label: { kind: "text", text: section.title }, leadingHtml: Icons.Disclosure, trailingHtml: `<span class="settings-health-summary" id="${section.id}_summary">Measuring…</span>` })}
      <div class="settings-health-body"><p class="settings-health-caption">${escapeHtml(section.caption)}</p><turbo-frame id="${section.id}" src="${section.path}"><p role="status"><span class="status-dot running" aria-hidden="true"></span> Measuring ${escapeHtml(section.title.toLowerCase())}…</p></turbo-frame></div>
    </details>`).join("");
    return `<section class="settings-sec settings-health" id="settings-sec-system-health"><details>
      ${actionItemHtml({ kind: "single", element: { tag: "summary" }, label: { kind: "text", text: "System health" }, leadingHtml: Icons.Disclosure })}
      <div class="settings-health-sources">${sources}</div>
    </details></section>`;
  },
  async handleAction({ request, url }) {
    const section = storageSections.find(section => section.path === url.pathname);
    if (request.method === "GET" && section) return response(await renderStorageFrame(section));
    return undefined;
  },
};
