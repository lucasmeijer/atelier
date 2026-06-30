import { mkdir, open, readdir } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { getAtelierRuntimeContext } from "@atelier/core";
import type { GitProjectInitInstruction } from "@atelier/projects";
import { isGitProjectInit } from "@atelier/projects";

export interface WorkspaceAgentInfo {
  workspaceId: string;
  label: string;
  path: string;
}

export interface WorkspaceAgentCreateOptions {
  topic?: string;
}

const sharedAgentFilePattern = /^([a-z0-9][a-z0-9-]*)--([a-zA-Z0-9][a-zA-Z0-9_.-]*)--agent-([1-9]\d*)--([a-f0-9]{6})\.jsonl$/;
export const projectlessSessionShareKey = "projectless";
export const sessionShareMountPath = "/atelier/session-share";

function workspaceMetadataInitPath(workspaceId: string, dataDir = getAtelierRuntimeContext().atelierDataDir): string {
  return join(dataDir, "workspaces", workspaceId, "metadata", "init.json");
}

async function workspaceProjectInit(workspaceId: string, dataDir = getAtelierRuntimeContext().atelierDataDir): Promise<GitProjectInitInstruction | undefined> {
  const file = Bun.file(workspaceMetadataInitPath(workspaceId, dataDir));
  if (!(await file.exists())) return undefined;
  const init = JSON.parse(await file.text()) as Parameters<typeof isGitProjectInit>[0];
  return isGitProjectInit(init) ? init : undefined;
}

export function sessionShareKeySlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug || projectlessSessionShareKey;
}

export function sessionShareKeyForInit(init: unknown): string {
  const workspaceInit = init as Parameters<typeof isGitProjectInit>[0];
  if (!isGitProjectInit(workspaceInit)) return projectlessSessionShareKey;
  const key = typeof workspaceInit.sessionShareKey === "string" && workspaceInit.sessionShareKey.trim()
    ? workspaceInit.sessionShareKey
    : workspaceInit.name;
  return sessionShareKeySlug(key);
}

export async function workspaceSessionShareKey(workspaceId: string, dataDir = getAtelierRuntimeContext().atelierDataDir): Promise<string> {
  return sessionShareKeyForInit(await workspaceProjectInit(workspaceId, dataDir));
}

export function sessionShareDir(shareKey: string, dataDir = getAtelierRuntimeContext().atelierDataDir): string {
  return join(dataDir, "session-shares", sessionShareKeySlug(shareKey));
}

export function sessionTopicSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "agent-session";
}

function sharedAgentSessionPath(shareKey: string, workspaceId: string, label: string, topic: string, dataDir = getAtelierRuntimeContext().atelierDataDir): string {
  const number = Number(label.slice("Agent ".length));
  const guid = createHash("sha256").update(`${workspaceId}\0${label}\0${randomBytes(16).toString("hex")}`).digest("hex").slice(0, 6);
  return join(sessionShareDir(shareKey, dataDir), `${sessionTopicSlug(topic)}--${workspaceId}--agent-${number}--${guid}.jsonl`);
}

export function parseWorkspaceAgentFilename(name: string, workspaceId?: string): { label: string; number: number } | undefined {
  const projectMatch = name.match(sharedAgentFilePattern);
  if (projectMatch) {
    if (workspaceId !== undefined && projectMatch[2] !== workspaceId) return undefined;
    const number = Number(projectMatch[3]);
    return { label: `Agent ${number}`, number };
  }

  return undefined;
}

async function touch(path: string): Promise<void> {
  const file = await open(path, "a");
  await file.close();
}

async function sessionDirForWorkspace(workspaceId: string, dataDir = getAtelierRuntimeContext().atelierDataDir): Promise<{ shareKey: string; dir: string }> {
  const shareKey = await workspaceSessionShareKey(workspaceId, dataDir);
  return { shareKey, dir: sessionShareDir(shareKey, dataDir) };
}

export async function ensureDefaultWorkspaceAgent(workspaceId: string, options: WorkspaceAgentCreateOptions = {}): Promise<WorkspaceAgentInfo> {
  const store = await sessionDirForWorkspace(workspaceId);
  await mkdir(store.dir, { recursive: true });
  const existing = await listWorkspaceAgents(workspaceId);
  const current = existing.find((agent) => agent.label === "Agent 1");
  if (current) return current;
  const label = "Agent 1";
  const path = sharedAgentSessionPath(store.shareKey, workspaceId, label, options.topic ?? "agent-session");
  await touch(path);
  return { workspaceId, label, path };
}

export async function listWorkspaceAgents(workspaceId: string): Promise<WorkspaceAgentInfo[]> {
  const store = await sessionDirForWorkspace(workspaceId);
  let entries: string[];
  try {
    entries = await readdir(store.dir);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return [];
    throw error;
  }
  return entries
    .map((entry) => ({ name: entry, parsed: parseWorkspaceAgentFilename(entry, workspaceId) }))
    .filter((entry): entry is { name: string; parsed: { label: string; number: number } } => Boolean(entry.parsed))
    .sort((a, b) => a.parsed.number - b.parsed.number)
    .map((entry) => ({ workspaceId, label: entry.parsed.label, path: join(store.dir, entry.name) }));
}

export async function createNextWorkspaceAgent(workspaceId: string, options: WorkspaceAgentCreateOptions = {}): Promise<WorkspaceAgentInfo> {
  const store = await sessionDirForWorkspace(workspaceId);
  await mkdir(store.dir, { recursive: true });
  const existing = await listWorkspaceAgents(workspaceId);
  const used = new Set(existing.map((agent) => Number(agent.label.slice("Agent ".length))));
  let next = 1;
  while (used.has(next)) next += 1;
  const label = `Agent ${next}`;
  const path = sharedAgentSessionPath(store.shareKey, workspaceId, label, options.topic ?? "agent-session");
  await touch(path);
  return { workspaceId, label, path };
}
