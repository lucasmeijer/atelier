import { AtelierCoreError, execWorkspaceShell, listWorkspaces, runDocker, workspaceContainerName } from "@atelier/core";
import type { FactView, HealthSummaryView, ProcessView } from "./render.ts";

export interface HealthSnapshot {
  summary: HealthSummaryView;
  processes: ProcessView[];
  facts?: FactView;
  warnings: string[];
  graph: {
    cpu: number;
    memory: number;
    network: number;
    block: number;
    labels: { cpu: string; memory: string; network: string; block: string };
  };
  errors: { stats?: string; processes?: string; facts?: string };
}

interface PreviousCounters {
  at: number;
  networkRxBytes: number;
  networkTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
}

export async function collectHealthSnapshot(workspaceId: string, previous?: PreviousCounters): Promise<{ snapshot: HealthSnapshot; counters?: PreviousCounters }> {
  await ensureWorkspace(workspaceId);
  const [statsResult, processesResult, factsResult] = await Promise.allSettled([
    collectDockerStats(workspaceId, previous),
    collectProcesses(workspaceId),
    collectFacts(workspaceId),
  ]);

  const errors: HealthSnapshot["errors"] = {};
  const stats = statsResult.status === "fulfilled" ? statsResult.value : undefined;
  const processes = processesResult.status === "fulfilled" ? processesResult.value : [];
  const facts = factsResult.status === "fulfilled" ? factsResult.value : undefined;
  if (statsResult.status === "rejected") errors.stats = errorMessage(statsResult.reason);
  if (processesResult.status === "rejected") errors.processes = errorMessage(processesResult.reason);
  if (factsResult.status === "rejected") errors.facts = errorMessage(factsResult.reason);

  const summary = stats?.summary ?? {};
  const warnings = buildWarnings(summary, errors);
  const graph = {
    cpu: summary.cpuPercent ?? 0,
    memory: summary.memoryPercent ?? 0,
    network: (summary.networkRxRateBytes ?? 0) + (summary.networkTxRateBytes ?? 0),
    block: (summary.blockReadRateBytes ?? 0) + (summary.blockWriteRateBytes ?? 0),
    labels: {
      cpu: formatPercent(summary.cpuPercent),
      memory: formatPercent(summary.memoryPercent),
      network: `${formatBytes((summary.networkRxRateBytes ?? 0) + (summary.networkTxRateBytes ?? 0))}/s`,
      block: `${formatBytes((summary.blockReadRateBytes ?? 0) + (summary.blockWriteRateBytes ?? 0))}/s`,
    },
  };

  return { snapshot: { summary, processes, facts, warnings, graph, errors }, counters: stats?.counters };
}

async function ensureWorkspace(workspaceId: string): Promise<void> {
  const { workspaces } = await listWorkspaces();
  if (!workspaces.some((workspace) => workspace.id === workspaceId)) throw new AtelierCoreError("workspace_not_found", `workspace not found: ${workspaceId}`);
}

async function collectDockerStats(workspaceId: string, previous?: PreviousCounters): Promise<{ summary: HealthSummaryView; counters: PreviousCounters }> {
  const result = await runDocker(["stats", workspaceContainerName(workspaceId), "--no-stream", "--format", "{{json .}}"]);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "docker stats failed");
  const raw = JSON.parse(result.stdout.trim()) as Record<string, string>;
  const memory = parseUsageLimit(raw.MemUsage ?? "");
  const network = parseUsageLimit(raw.NetIO ?? "");
  const block = parseUsageLimit(raw.BlockIO ?? "");
  const now = Date.now();
  const counters: PreviousCounters = {
    at: now,
    networkRxBytes: network.used,
    networkTxBytes: network.limit,
    blockReadBytes: block.used,
    blockWriteBytes: block.limit,
  };
  const seconds = previous ? Math.max((now - previous.at) / 1000, 0.001) : 1;
  const rate = (current: number, prior: number | undefined) => previous && current >= (prior ?? 0) ? (current - (prior ?? 0)) / seconds : 0;
  const summary: HealthSummaryView = {
    cpuPercent: parsePercent(raw.CPUPerc),
    memoryUsageBytes: memory.used,
    memoryLimitBytes: memory.limit,
    memoryPercent: parsePercent(raw.MemPerc),
    networkRxRateBytes: rate(network.used, previous?.networkRxBytes),
    networkTxRateBytes: rate(network.limit, previous?.networkTxBytes),
    blockReadRateBytes: rate(block.used, previous?.blockReadBytes),
    blockWriteRateBytes: rate(block.limit, previous?.blockWriteBytes),
    pids: Number.parseInt(raw.PIDs ?? "", 10) || undefined,
  };
  return { summary, counters };
}

async function collectProcesses(workspaceId: string): Promise<ProcessView[]> {
  const script = `ps -eo pid,user,pcpu,pmem,rss,args --sort=-pcpu 2>/dev/null | head -16 || ps w 2>/dev/null | head -16 || true`;
  const result = await execWorkspaceShell(workspaceId, script, { user: "root", workdir: "/" });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "ps failed");
  const lines = result.stdout.trim().split(/\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  return lines.slice(1).map(parseProcessLine).filter((process): process is ProcessView => process !== undefined).sort((a, b) => (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1)).slice(0, 12);
}

function parseProcessLine(line: string): ProcessView | undefined {
  const parts = line.trim().split(/\s+/, 6);
  if (parts.length < 5) return undefined;
  const [pid = "", user = "", cpu = "", mem = "", rss = "", commandHead = ""] = parts;
  const commandStart = nthTokenIndex(line.trim(), 5);
  return {
    pid,
    user,
    cpuPercent: finiteOrNull(Number.parseFloat(cpu)),
    memoryPercent: finiteOrNull(Number.parseFloat(mem)),
    rssKb: finiteOrNull(Number.parseFloat(rss)),
    command: (commandStart >= 0 ? line.trim().slice(commandStart) : commandHead).slice(0, 180),
  };
}

async function collectFacts(workspaceId: string): Promise<FactView> {
  const result = await runDocker(["inspect", workspaceContainerName(workspaceId), "--format", "{{json .}}"]);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "docker inspect failed");
  const raw = JSON.parse(result.stdout.trim()) as { Name?: string; Config?: { Image?: string }; State?: { Status?: string; StartedAt?: string; RestartCount?: number } };
  return {
    name: raw.Name?.replace(/^\//, ""),
    image: raw.Config?.Image,
    status: raw.State?.Status,
    startedAt: raw.State?.StartedAt,
    restartCount: raw.State?.RestartCount,
  };
}

function buildWarnings(summary: HealthSummaryView, errors: HealthSnapshot["errors"]): string[] {
  const warnings: string[] = [];
  if (errors.stats) warnings.push(`Docker stats unavailable: ${errors.stats}`);
  if (errors.processes) warnings.push(`Process list unavailable: ${errors.processes}`);
  if (summary.cpuPercent !== undefined && summary.cpuPercent >= 90) warnings.push("CPU pressure is critical.");
  else if (summary.cpuPercent !== undefined && summary.cpuPercent >= 75) warnings.push("CPU pressure is elevated.");
  if (summary.memoryPercent !== undefined && summary.memoryPercent >= 90) warnings.push("Memory usage is critical.");
  else if (summary.memoryPercent !== undefined && summary.memoryPercent >= 75) warnings.push("Memory usage is elevated.");
  return warnings;
}

function parsePercent(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value.replace("%", ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseUsageLimit(value: string): { used: number; limit: number } {
  const [used = "0", limit = "0"] = value.split("/").map((part) => part.trim());
  return { used: parseDockerBytes(used), limit: parseDockerBytes(limit) };
}

function parseDockerBytes(value: string): number {
  const match = value.trim().match(/^([0-9.]+)\s*([a-zA-Z]+)?$/);
  if (!match) return 0;
  const amount = Number.parseFloat(match[1] ?? "0");
  const unit = (match[2] ?? "B").toLowerCase();
  const powers: Record<string, number> = { b: 0, kb: 1, kib: 1, mb: 2, mib: 2, gb: 3, gib: 3, tb: 4, tib: 4, pb: 5, pib: 5 };
  return amount * 1024 ** (powers[unit] ?? 0);
}

function nthTokenIndex(value: string, tokenIndex: number): number {
  let inToken = false;
  let count = 0;
  for (let index = 0; index < value.length; index++) {
    const space = /\s/.test(value[index] ?? "");
    if (!space && !inToken) {
      if (count === tokenIndex) return index;
      count++;
      inToken = true;
    }
    if (space) inToken = false;
  }
  return -1;
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatPercent(value: number | undefined): string {
  return value === undefined ? "—" : `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let next = value;
  let unit = 0;
  while (next >= 1024 && unit < units.length - 1) { next /= 1024; unit++; }
  return `${next >= 10 || unit === 0 ? next.toFixed(0) : next.toFixed(1)} ${units[unit]}`;
}
