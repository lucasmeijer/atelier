import { mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getAtelierRuntimeContext } from "@atelier/core";
import type { GitProjectInitInstruction } from "@atelier/projects";
import { isGitProjectInit } from "@atelier/projects";
import type { WorkspaceAgentConversationContribution, WorkspaceInitInstruction } from "@atelier/workspace";

export interface WorkspaceAgentInfo {
  workspaceId: string;
  conversationId: string;
  label: string;
  title: string;
  path: string;
}

export interface WorkspaceAgentCreateOptions {
  topic?: string;
}

const sharedAgentFilePattern = /^([a-z0-9][a-z0-9-]*)--([a-zA-Z0-9][a-zA-Z0-9_.-]*)--agent-([1-9]\d*)--([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/;
export const projectlessSessionShareKey = "projectless";
export const sessionShareMountPath = "/atelier/session-share";

function workspaceMetadataInitPath(workspaceId: string, dataDir = getAtelierRuntimeContext().atelierDataDir): string {
  return join(dataDir, "workspaces", workspaceId, "metadata", "init.json");
}

async function workspaceProjectInit(workspaceId: string, dataDir = getAtelierRuntimeContext().atelierDataDir): Promise<GitProjectInitInstruction | undefined> {
  const file = Bun.file(workspaceMetadataInitPath(workspaceId, dataDir));
  if (!(await file.exists())) return undefined;
  const init: unknown = JSON.parse(await file.text());
  return isGitProjectInit(init) ? init : undefined;
}

function sessionSlug(value: string, maxLength: number, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || fallback;
}

export function sessionShareKeySlug(value: string): string {
  return sessionSlug(value, 80, projectlessSessionShareKey);
}

export function sessionShareKeyForInit(init: WorkspaceInitInstruction | undefined): string {
  if (!isGitProjectInit(init)) return projectlessSessionShareKey;
  const key = init.sessionShareKey.trim()
    ? init.sessionShareKey
    : init.name;
  return sessionShareKeySlug(key);
}

export async function workspaceSessionShareKey(workspaceId: string, dataDir = getAtelierRuntimeContext().atelierDataDir): Promise<string> {
  return sessionShareKeyForInit(await workspaceProjectInit(workspaceId, dataDir));
}

export function sessionShareDir(shareKey: string, dataDir = getAtelierRuntimeContext().atelierDataDir): string {
  return join(dataDir, "session-shares", sessionShareKeySlug(shareKey));
}

export function sessionTopicSlug(value: string): string {
  return sessionSlug(value, 48, "agent-session");
}

function sharedAgentSessionPath(shareKey: string, workspaceId: string, label: string, topic: string, conversationId: string, dataDir = getAtelierRuntimeContext().atelierDataDir): string {
  const number = Number(label.slice("Agent ".length));
  return join(sessionShareDir(shareKey, dataDir), `${sessionTopicSlug(topic)}--${workspaceId}--agent-${number}--${conversationId}.jsonl`);
}

export function parseWorkspaceAgentFilename(name: string, workspaceId?: string): { conversationId: string; label: string; number: number } | undefined {
  const projectMatch = name.match(sharedAgentFilePattern);
  if (projectMatch) {
    if (workspaceId !== undefined && projectMatch[2] !== workspaceId) return undefined;
    const number = Number(projectMatch[3]);
    return { conversationId: projectMatch[4]!, label: `Agent ${number}`, number };
  }

  return undefined;
}

async function touch(path: string): Promise<void> {
  const file = await open(path, "a");
  await file.close();
}

function conversationTitlePath(sessionPath: string): string {
  return sessionPath.replace(/\.jsonl$/, ".title");
}

async function writeConversationTitle(sessionPath: string, title: string): Promise<void> {
  const path = conversationTitlePath(sessionPath);
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporaryPath, `${title}\n`);
  await rename(temporaryPath, path);
}

async function sessionDirForWorkspace(workspaceId: string, dataDir = getAtelierRuntimeContext().atelierDataDir): Promise<{ shareKey: string; dir: string }> {
  const shareKey = await workspaceSessionShareKey(workspaceId, dataDir);
  return { shareKey, dir: sessionShareDir(shareKey, dataDir) };
}

async function createWorkspaceAgentSession(workspaceId: string, label: string, topic = "agent-session", conversationId = randomUUID()): Promise<WorkspaceAgentInfo> {
  const store = await sessionDirForWorkspace(workspaceId);
  await mkdir(store.dir, { recursive: true });
  const path = sharedAgentSessionPath(store.shareKey, workspaceId, label, topic, conversationId);
  await touch(path);
  await writeConversationTitle(path, "Untitled");
  return { workspaceId, conversationId, label, title: "Untitled", path };
}

export async function ensureDefaultWorkspaceAgent(workspaceId: string, options: WorkspaceAgentCreateOptions = {}): Promise<WorkspaceAgentInfo> {
  const current = (await listWorkspaceAgents(workspaceId)).find((agent) => agent.label === "Agent 1");
  return current ?? await createWorkspaceAgentSession(workspaceId, "Agent 1", options.topic);
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
  const agents = entries
    .map((entry) => ({ name: entry, parsed: parseWorkspaceAgentFilename(entry, workspaceId) }))
    .filter((entry): entry is { name: string; parsed: { conversationId: string; label: string; number: number } } => Boolean(entry.parsed))
    .sort((a, b) => a.parsed.number - b.parsed.number);
  return await Promise.all(agents.map(async (entry) => {
    const path = join(store.dir, entry.name);
    const title = (await readFile(conversationTitlePath(path), "utf8")).replace(/\n$/, "");
    if (!title.trim()) throw new Error(`Agent conversation ${entry.parsed.conversationId} has an empty title`);
    return { workspaceId, conversationId: entry.parsed.conversationId, label: entry.parsed.label, title, path };
  }));
}

export async function createNextWorkspaceAgent(workspaceId: string, options: WorkspaceAgentCreateOptions = {}): Promise<WorkspaceAgentInfo> {
  const used = new Set((await listWorkspaceAgents(workspaceId)).map((agent) => Number(agent.label.slice("Agent ".length))));
  let next = 1;
  while (used.has(next)) next += 1;
  return await createWorkspaceAgentSession(workspaceId, `Agent ${next}`, options.topic);
}

/** Archive an Agent conversation's current session and create a fresh session for the same display label. */
export async function replaceWorkspaceAgentSession(agent: WorkspaceAgentInfo): Promise<WorkspaceAgentInfo> {
  await rename(agent.path, agent.path.replace(/\.jsonl$/, ".archived.jsonl"));
  await touch(agent.path);
  return agent;
}

export async function setWorkspaceAgentConversationTitle(agent: WorkspaceAgentInfo, title: string): Promise<WorkspaceAgentInfo> {
  if (!title.trim()) throw new Error("Agent conversation title must not be empty");
  await writeConversationTitle(agent.path, title);
  return { ...agent, title };
}

export async function archiveWorkspaceAgentConversation(agent: WorkspaceAgentInfo): Promise<void> {
  await rename(agent.path, agent.path.replace(/\.jsonl$/, ".archived.jsonl"));
  const titlePath = conversationTitlePath(agent.path);
  await rename(titlePath, titlePath.replace(/\.title$/, ".archived.title"));
}

export async function workspaceAgentConversationContributions(workspaceId: string): Promise<WorkspaceAgentConversationContribution[]> {
  return (await listWorkspaceAgents(workspaceId)).map((agent) => ({
    id: agent.conversationId,
    title: agent.title,
    archive: async () => await archiveWorkspaceAgentConversation(agent),
  }));
}
