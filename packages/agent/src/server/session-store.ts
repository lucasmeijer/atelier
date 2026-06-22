import { mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { defaultDataDir } from "@atelier/core";

export interface WorkspaceAgentInfo {
  workspaceId: string;
  label: string;
  path: string;
}

const agentFilePattern = /^Agent ([1-9]\d*)\.jsonl$/;

function workspaceAgentsDir(workspaceId: string, dataDir = defaultDataDir()): string {
  return join(dataDir, "workspace-agents", workspaceId);
}

export function workspaceAgentSessionPath(workspaceId: string, label: string, dataDir = defaultDataDir()): string {
  return join(workspaceAgentsDir(workspaceId, dataDir), `${label}.jsonl`);
}

export function parseWorkspaceAgentFilename(name: string): { label: string; number: number } | undefined {
  const match = name.match(agentFilePattern);
  if (!match) return undefined;
  const number = Number(match[1]);
  return { label: `Agent ${number}`, number };
}

async function touch(path: string): Promise<void> {
  const file = await open(path, "a");
  await file.close();
}

export async function ensureDefaultWorkspaceAgent(workspaceId: string): Promise<WorkspaceAgentInfo> {
  await mkdir(workspaceAgentsDir(workspaceId), { recursive: true });
  const label = "Agent 1";
  const path = workspaceAgentSessionPath(workspaceId, label);
  await touch(path);
  return { workspaceId, label, path };
}

export async function listWorkspaceAgents(workspaceId: string): Promise<WorkspaceAgentInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(workspaceAgentsDir(workspaceId));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return [];
    throw error;
  }
  return entries
    .map((entry) => parseWorkspaceAgentFilename(entry))
    .filter((entry): entry is { label: string; number: number } => Boolean(entry))
    .sort((a, b) => a.number - b.number)
    .map((entry) => ({ workspaceId, label: entry.label, path: workspaceAgentSessionPath(workspaceId, entry.label) }));
}

export async function createNextWorkspaceAgent(workspaceId: string): Promise<WorkspaceAgentInfo> {
  await mkdir(workspaceAgentsDir(workspaceId), { recursive: true });
  const existing = await listWorkspaceAgents(workspaceId);
  const used = new Set(existing.map((agent) => Number(agent.label.slice("Agent ".length))));
  let next = 1;
  while (used.has(next)) next += 1;
  const label = `Agent ${next}`;
  const path = workspaceAgentSessionPath(workspaceId, label);
  await touch(path);
  return { workspaceId, label, path };
}
