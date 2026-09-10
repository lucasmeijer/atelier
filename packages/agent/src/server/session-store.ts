import type { AgentToolBinding } from "@atelier/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { createKeyedOperationQueue, getAtelierRuntimeContext, isJsonObject } from "@atelier/core";
import type { GitProjectInitInstruction } from "@atelier/projects";
import { isGitProjectInit } from "@atelier/projects";
import { workspaceRoot, type WorkspaceInitInstruction } from "@atelier/workspace";

const bindingsSchema = Type.Array(Type.Object({ name: Type.String(), context: Type.Unknown() }, { additionalProperties: false }));
const additionalToolsEntryType = "atelier.additional-tools";

/** Read explicit host-authored metadata, never historical tool calls or model text. */
export function conversationToolBindings(entries: SessionEntry[]): AgentToolBinding[] {
  const entry = entries.findLast((entry) => entry.type === "custom" && entry.customType === additionalToolsEntryType);
  if (!entry || entry.type !== "custom") return [];
  const bindings = entry.data;
  Value.Assert(bindingsSchema, bindings);
  return bindings.map((binding) => {
    if (!isJsonObject(binding.context)) throw new Error("Invalid conversation tool binding");
    return { name: binding.name, context: binding.context };
  });
}

/** Publish the session and its bindings together, even before the first agent turn. */
async function initializeConversationSession(path: string, bindings: AgentToolBinding[] = []): Promise<void> {
  const manager = SessionManager.inMemory(workspaceRoot);
  if (bindings.length) manager.appendCustomEntry(additionalToolsEntryType, bindings);
  const content = bindings.length
    ? [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n"
    : "";
  const temporary = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}

export interface WorkspaceAgentConversationInfo {
  workspaceId: string;
  conversationId: string;
  label: string;
  title: string;
  path: string;
}

export interface WorkspaceAgentConversationCreateOptions {
  topic?: string;
  additionalTools?: AgentToolBinding[];
}

const sharedAgentFilePattern = /^([a-z0-9][a-z0-9-]*)--([a-zA-Z0-9][a-zA-Z0-9_.-]*)--agent-([1-9]\d*)--([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/;
export const projectlessSessionShareKey = "projectless";
export const sessionShareMountPath = "/atelier/session-share";
export const untitledAgentConversationTitle = "Untitled";
const serializeConversationOperation = createKeyedOperationQueue();

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

function sharedAgentSessionFilename(workspaceId: string, label: string, topic: string, conversationId: string): string {
  const number = Number(label.slice("Agent ".length));
  return `${sessionTopicSlug(topic)}--${workspaceId}--agent-${number}--${conversationId}.jsonl`;
}

function sharedAgentSessionPath(shareKey: string, workspaceId: string, label: string, topic: string, conversationId: string, dataDir = getAtelierRuntimeContext().atelierDataDir): string {
  return join(sessionShareDir(shareKey, dataDir), sharedAgentSessionFilename(workspaceId, label, topic, conversationId));
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

async function createWorkspaceAgentConversation(workspaceId: string, label: string, options: WorkspaceAgentConversationCreateOptions): Promise<WorkspaceAgentConversationInfo> {
  const store = await sessionDirForWorkspace(workspaceId);
  await mkdir(store.dir, { recursive: true });
  const conversationId = randomUUID();
  const path = sharedAgentSessionPath(store.shareKey, workspaceId, label, options.topic ?? "agent-session", conversationId);
  await writeConversationTitle(path, untitledAgentConversationTitle);
  // Listing discovers only .jsonl files, so publish the session after its title
  // and tool bindings are durable. Readers never see a partially prepared agent.
  await initializeConversationSession(path, options.additionalTools);
  return { workspaceId, conversationId, label, title: untitledAgentConversationTitle, path };
}

export async function ensureDefaultWorkspaceAgentConversation(workspaceId: string, options: WorkspaceAgentConversationCreateOptions = {}): Promise<WorkspaceAgentConversationInfo> {
  return await serializeConversationOperation(workspaceId, async () => {
    const current = (await listWorkspaceAgentConversationsUnlocked(workspaceId)).find((agent) => agent.label === "Agent 1");
    return current ?? await createWorkspaceAgentConversation(workspaceId, "Agent 1", options);
  });
}

async function listWorkspaceAgentConversationsUnlocked(workspaceId: string): Promise<WorkspaceAgentConversationInfo[]> {
  const store = await sessionDirForWorkspace(workspaceId);
  let entries: string[];
  try {
    entries = await readdir(store.dir);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return [];
    throw error;
  }
  const conversations = entries
    .map((entry) => ({ name: entry, parsed: parseWorkspaceAgentFilename(entry, workspaceId) }))
    .filter((entry): entry is { name: string; parsed: { conversationId: string; label: string; number: number } } => Boolean(entry.parsed))
    .sort((a, b) => a.parsed.number - b.parsed.number);
  return await Promise.all(conversations.map(async (entry) => {
    const path = join(store.dir, entry.name);
    const title = (await readFile(conversationTitlePath(path), "utf8")).replace(/\n$/, "");
    if (!title.trim()) throw new Error(`Agent conversation ${entry.parsed.conversationId} has an empty title`);
    return { workspaceId, conversationId: entry.parsed.conversationId, label: entry.parsed.label, title, path };
  }));
}

export async function listWorkspaceAgentConversations(workspaceId: string): Promise<WorkspaceAgentConversationInfo[]> {
  return await serializeConversationOperation(workspaceId, async () => await listWorkspaceAgentConversationsUnlocked(workspaceId));
}

export async function createNextWorkspaceAgentConversation(workspaceId: string, options: WorkspaceAgentConversationCreateOptions = {}): Promise<WorkspaceAgentConversationInfo> {
  return await serializeConversationOperation(workspaceId, async () => {
    const used = new Set((await listWorkspaceAgentConversationsUnlocked(workspaceId)).map((agent) => Number(agent.label.slice("Agent ".length))));
    let next = 1;
    while (used.has(next)) next += 1;
    return await createWorkspaceAgentConversation(workspaceId, `Agent ${next}`, options);
  });
}

/** Archive an Agent conversation's current session and create a fresh session for the same display label. */
export async function replaceWorkspaceAgentSession(agent: WorkspaceAgentConversationInfo): Promise<WorkspaceAgentConversationInfo> {
  return await serializeConversationOperation(agent.workspaceId, async () => {
    const bindings = conversationToolBindings(SessionManager.open(agent.path, dirname(agent.path), workspaceRoot).getEntries());
    await rename(agent.path, agent.path.replace(/\.jsonl$/, ".archived.jsonl"));
    await initializeConversationSession(agent.path, bindings);
    return agent;
  });
}

export async function setWorkspaceAgentConversationTitle(agent: WorkspaceAgentConversationInfo, title: string): Promise<WorkspaceAgentConversationInfo> {
  if (!title.trim()) throw new Error("Agent conversation title must not be empty");
  return await serializeConversationOperation(agent.workspaceId, async () => {
    await writeConversationTitle(agent.path, title);
    return { ...agent, title };
  });
}

export async function archiveWorkspaceAgentConversation(agent: WorkspaceAgentConversationInfo): Promise<void> {
  await serializeConversationOperation(agent.workspaceId, async () => {
    await rename(agent.path, agent.path.replace(/\.jsonl$/, ".archived.jsonl"));
    const titlePath = conversationTitlePath(agent.path);
    await rename(titlePath, titlePath.replace(/\.title$/, ".archived.title"));
  });
}
