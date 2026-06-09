import type { WorkspaceTabContribution } from "@atelier/shared";

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function domId(...parts: string[]): string {
  return parts.join("_").replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function renderHealthTab(workspaceId: string): WorkspaceTabContribution {
  return {
    key: "health",
    label: "Health",
    paneHtml: `<section class="tab-pane" data-tab-pane="health">${renderHealthPane(workspaceId)}</section>`,
  };
}

export function renderHealthPane(workspaceId: string): string {
  return `<div class="health-pane" data-controller="container-health" data-container-health-workspace-id-value="${escapeHtml(workspaceId)}" data-container-health-stream-url-value="/workspaces/${encodeURIComponent(workspaceId)}/health/stream">
    <div class="health-shell">
      ${renderSummary(workspaceId)}
      <section class="health-graphs">
        ${renderGraph(workspaceId, "cpu", "CPU %", "0%")}
        ${renderGraph(workspaceId, "memory", "Memory %", "0%")}
        ${renderGraph(workspaceId, "network", "Network I/O", "0 B/s")}
        ${renderGraph(workspaceId, "block", "Block I/O", "0 B/s")}
      </section>
      <div class="health-grid">
        ${renderProcesses(workspaceId, [])}
        <div class="health-side">
          ${renderWarnings(workspaceId, [])}
          ${renderFacts(workspaceId, undefined)}
        </div>
      </div>
    </div>
  </div>`;
}

function renderGraph(workspaceId: string, key: string, label: string, value: string): string {
  return `<article class="health-card health-graph" data-health-graph="${escapeHtml(key)}">
    <div class="health-card-head"><span>${escapeHtml(label)}</span><strong data-health-graph-value="${escapeHtml(key)}">${escapeHtml(value)}</strong></div>
    <svg viewBox="0 0 120 42" preserveAspectRatio="none" aria-hidden="true"><path class="health-graph-fill" data-health-graph-fill="${escapeHtml(key)}"></path><path class="health-graph-line" data-health-graph-line="${escapeHtml(key)}"></path></svg>
  </article>`;
}

export interface HealthSummaryView {
  cpuPercent?: number;
  memoryUsageBytes?: number;
  memoryLimitBytes?: number;
  memoryPercent?: number;
  networkRxRateBytes?: number;
  networkTxRateBytes?: number;
  blockReadRateBytes?: number;
  blockWriteRateBytes?: number;
  pids?: number;
}

export interface ProcessView {
  pid: string;
  user: string;
  cpuPercent: number | null;
  memoryPercent: number | null;
  rssKb: number | null;
  command: string;
}

export interface FactView {
  name?: string;
  image?: string;
  status?: string;
  startedAt?: string;
  restartCount?: number;
}

export function renderSummary(workspaceId: string, summary: HealthSummaryView = {}): string {
  const memText = summary.memoryUsageBytes !== undefined && summary.memoryLimitBytes !== undefined ? `${formatBytes(summary.memoryUsageBytes)} / ${formatBytes(summary.memoryLimitBytes)}` : "Waiting…";
  return `<section id="${domId("health_summary", workspaceId)}" class="health-summary">
    ${stat("CPU", percent(summary.cpuPercent), severity(summary.cpuPercent, 75, 90))}
    ${stat("Memory", summary.memoryPercent === undefined ? memText : `${percent(summary.memoryPercent)} · ${memText}`, severity(summary.memoryPercent, 75, 90))}
    ${stat("Network", `${formatBytes(summary.networkRxRateBytes ?? 0)}/s ↓ · ${formatBytes(summary.networkTxRateBytes ?? 0)}/s ↑`, "")}
    ${stat("Block I/O", `${formatBytes(summary.blockReadRateBytes ?? 0)}/s read · ${formatBytes(summary.blockWriteRateBytes ?? 0)}/s write`, "")}
    ${stat("Processes", summary.pids === undefined ? "—" : String(summary.pids), "")}
  </section>`;
}

function stat(label: string, value: string, className: string): string {
  return `<article class="health-stat ${className}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`;
}

export function renderProcesses(workspaceId: string, processes: ProcessView[], error?: string): string {
  const rows = error ? `<tr><td colspan="5" class="muted">${escapeHtml(error)}</td></tr>` : processes.length === 0 ? `<tr><td colspan="5" class="muted">Waiting for process samples…</td></tr>` : processes.map((process) => `<tr class="${severity(process.cpuPercent ?? 0, 50, 85)}">
    <td><code>${escapeHtml(process.pid)}</code></td><td>${escapeHtml(process.user)}</td><td>${process.cpuPercent === null ? "—" : percent(process.cpuPercent)}</td><td>${process.memoryPercent === null ? "—" : percent(process.memoryPercent)}</td><td title="${escapeHtml(process.command)}">${escapeHtml(process.command)}</td>
  </tr>`).join("");
  return `<section id="${domId("health_processes", workspaceId)}" class="health-panel health-processes"><div class="health-panel-head"><h3>Hot processes</h3><span>sorted by CPU</span></div><table><thead><tr><th>PID</th><th>User</th><th>CPU</th><th>MEM</th><th>Command</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

export function renderWarnings(workspaceId: string, warnings: string[]): string {
  return `<section id="${domId("health_warnings", workspaceId)}" class="health-panel"><div class="health-panel-head"><h3>Signals</h3></div>${warnings.length === 0 ? `<p class="muted">No pressure detected.</p>` : `<ul class="health-warnings">${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>`}</section>`;
}

export function renderFacts(workspaceId: string, facts?: FactView, error?: string): string {
  const rows = error ? `<p class="muted">${escapeHtml(error)}</p>` : `<dl class="health-facts"><dt>Name</dt><dd>${escapeHtml(facts?.name ?? "—")}</dd><dt>Image</dt><dd>${escapeHtml(facts?.image ?? "—")}</dd><dt>Status</dt><dd>${escapeHtml(facts?.status ?? "—")}</dd><dt>Started</dt><dd>${escapeHtml(formatDate(facts?.startedAt))}</dd><dt>Restarts</dt><dd>${escapeHtml(facts?.restartCount ?? "—")}</dd></dl>`;
  return `<section id="${domId("health_facts", workspaceId)}" class="health-panel"><div class="health-panel-head"><h3>Container facts</h3></div>${rows}</section>`;
}

export function renderConnection(workspaceId: string, state: "live" | "error", message: string): string {
  return `<div id="${domId("health_connection", workspaceId)}" class="health-connection ${state}">${escapeHtml(message)}</div>`;
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let next = value;
  let unit = 0;
  while (next >= 1024 && unit < units.length - 1) { next /= 1024; unit++; }
  return `${next >= 10 || unit === 0 ? next.toFixed(0) : next.toFixed(1)} ${units[unit]}`;
}

function percent(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "—" : `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function severity(value: number | null | undefined, warn: number, danger: number): string {
  if (value === null || value === undefined) return "";
  if (value >= danger) return "danger";
  if (value >= warn) return "warn";
  return "";
}

function formatDate(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}
