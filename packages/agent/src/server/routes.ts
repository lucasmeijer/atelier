import { readFile } from "node:fs/promises";
import { AtelierCoreError, readJsonObject, requestAcceptsJson, type AtelierEventBus } from "@atelier/core";
import { getModelThinkingLevel, setModelThinkingLevel } from "./pi-config-models.ts";
import { parseModelRef } from "./model-state.ts";
import { setWorkspaceTitle, workspaceContainerName, workspacePreviewPortUrl } from "@atelier/workspace";
import {
  deliverAttachmentDraft,
  extensionOf,
  findStagedAttachment,
  imageMimeByExtension,
  removeAttachmentDraft,
  removeStagedAttachment,
  stageAttachment,
  validDraftId,
} from "./attachment-drafts.ts";
import { ids, renderAttachmentChip } from "./render.ts";
import { turboStream, turboStreamResponse } from "./html.ts";
import { expandPromptTemplate, listPromptTemplates, parseWorkspaceNameCommand } from "./prompt-templates.ts";
import { listFileCompletions, renderFileCompletionMenu } from "./file-completions.ts";
import { loadWorkspaceSkills } from "./skills.ts";
import { renderSlashCommandMenu } from "./slash-commands.ts";
import { getWorkspaceAgentRuntime, type SubmitMode } from "./runtime.ts";
import { handleAgentTreeRequest } from "./session-tree.ts";
import { ensureDefaultWorkspaceAgent, listWorkspaceAgents, type WorkspaceAgentInfo } from "./session-store.ts";
import { maybeNameWorkspaceFromAgentPrompt, renameWorkspaceFromAgentContext } from "./workspace-title-suggestion.ts";

interface AgentRouteOptions {
  events?: AtelierEventBus;
}

interface AgentWorkspaceCreationContext {
  initialPrompt?: string;
  model?: string;
  thinkingLevel?: string;
  attachmentDraft?: string;
}

function parseAgentWorkspaceCreationContext(value: unknown): AgentWorkspaceCreationContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const initialPrompt = typeof record.initialPrompt === "string" ? record.initialPrompt : undefined;
  const model = typeof record.model === "string" ? record.model : undefined;
  const thinkingLevel = typeof record.thinkingLevel === "string" ? record.thinkingLevel : undefined;
  if (!initialPrompt?.trim() && !model && !thinkingLevel) return undefined;
  return {
    initialPrompt,
    model,
    thinkingLevel,
    attachmentDraft: typeof record.attachmentDraft === "string" ? record.attachmentDraft : undefined,
  };
}

export function registerAgentEvents(events: AtelierEventBus): void {
  events.on("workspace_created", async ({ workspaceId, context }) => {
    const agentContext = parseAgentWorkspaceCreationContext(context?.agent);
    if (!agentContext) return;
    const hasPrompt = Boolean(agentContext.initialPrompt?.trim());
    if (hasPrompt) await events.emit("workspace_provision_step", { workspaceId, id: "agent.initial_prompt", label: "Start initial agent task", parentId: "workspace.integrations", status: "running" });
    await initializeWorkspaceAgent(workspaceId, agentContext, { events });
    if (hasPrompt) await events.emit("workspace_provision_step", { workspaceId, id: "agent.initial_prompt", label: "Start initial agent task", parentId: "workspace.integrations", status: "done" });
  });
}

const mimeByExtension: Record<string, string> = {
  ...imageMimeByExtension,
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  ogv: "video/ogg",
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  pdf: "application/pdf",
};

function contentTypeFor(path: string): string {
  return mimeByExtension[extensionOf(path)] ?? "application/octet-stream";
}

async function requireAgent(workspaceId: string, label: string): Promise<WorkspaceAgentInfo> {
  const agents = await listWorkspaceAgents(workspaceId);
  const agent = agents.find((candidate) => candidate.label === label);
  if (!agent) throw new AtelierCoreError("agent_not_found", `agent not found: ${label}`);
  return agent;
}

// ---------------------------------------------------------------------------
// Route handling
// ---------------------------------------------------------------------------

export async function handleAgentRequest(request: Request, url: URL, options: AgentRouteOptions = {}): Promise<Response | undefined> {
  const match = (pattern: RegExp): string[] | undefined => {
    const result = url.pathname.match(pattern);
    return result ? result.slice(1).map(decodeURIComponent) : undefined;
  };

  let params: string[] | undefined;

  if ((params = match(/^\/agent-attachment-drafts\/([^/]+)\/attachments$/)) && request.method === "POST") {
    return await uploadAttachmentEndpoint(params[0], request, url.searchParams.get("row") ?? undefined);
  }
  if ((params = match(/^\/agent-attachment-drafts\/([^/]+)\/attachments\/([^/]+)\/delete$/)) && request.method === "POST") {
    return await deleteAttachmentEndpoint(params[0], params[1]);
  }
  if ((params = match(/^\/agent-attachment-drafts\/([^/]+)\/discard$/)) && request.method === "POST") {
    if (!validDraftId(params[0])) return new Response("invalid attachment draft", { status: 400 });
    await removeAttachmentDraft(params[0]);
    return new Response(null, { status: 204 });
  }

  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/messages$/)) && request.method === "POST") {
    return await agentMessagesEndpoint(params[0], params[1], request, options);
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/transcript-items\/([^/]+)$/)) && request.method === "GET") {
    const runtime = await getWorkspaceAgentRuntime(await requireAgent(params[0], params[1]), options);
    const count = Math.max(100, Math.min(100_000, Number(url.searchParams.get("count") ?? 100) || 100));
    const html = await runtime.detailHtml(params[2], count);
    return new Response(html || "not found", { status: html ? 200 : 404, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/session-images\/([^/]+)\/(\d+)$/)) && request.method === "GET") {
    const agent = await requireAgent(params[0], params[1]);
    return await sessionImageEndpoint(agent.path, params[2], Number(params[3]));
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/completions$/)) && request.method === "GET") {
    return await completionsEndpoint(params[0], url);
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/tree(\/summary|\/label|)$/))) {
    const [workspaceId, label, suffix] = params;
    return await handleAgentTreeRequest(request, url, suffix, async () => await getWorkspaceAgentRuntime(await requireAgent(workspaceId, label), options));
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/completions\/prompt-template-expand$/)) && request.method === "POST") {
    return await expandPromptTemplateEndpoint(params[0], request);
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/abort$/)) && request.method === "POST") {
    const runtime = await getWorkspaceAgentRuntime(await requireAgent(params[0], params[1]), options);
    await runtime.abort();
    return requestAcceptsJson(request) ? Response.json({ agent: { label: params[1], state: "idle", aborted: true } }) : turboStreamResponse("");
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/model$/)) && request.method === "POST") {
    const json = requestAcceptsJson(request);
    const value = json ? (await readJsonObject(request)).model : (await request.formData()).get("model");
    const model = parseModelRef(String(value ?? ""));
    if (!model) {
      if (json) throw new AtelierCoreError("invalid_arguments", "valid model is required");
      return turboStreamResponse("");
    }
    const runtime = await getWorkspaceAgentRuntime(await requireAgent(params[0], params[1]), options);
    await runtime.setModel(model.provider, model.id);
    return json ? Response.json({ agent: { label: params[1], model: `${model.provider}::${model.id}` } }) : turboStreamResponse("");
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/thinking$/)) && request.method === "POST") {
    const json = requestAcceptsJson(request);
    const value = json ? (await readJsonObject(request)).level : (await request.formData()).get("level");
    const level = String(value ?? "");
    if (!level) {
      if (json) throw new AtelierCoreError("invalid_arguments", "level is required");
      return turboStreamResponse("");
    }
    const runtime = await getWorkspaceAgentRuntime(await requireAgent(params[0], params[1]), options);
    await runtime.setThinkingLevel(level);
    const model = runtime.currentModel();
    if (model) await setModelThinkingLevel(model.provider, model.id, level);
    return json ? Response.json({ agent: { label: params[1], thinkingLevel: level } }) : turboStreamResponse("");
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/rewind$/)) && request.method === "POST") {
    const form = await request.formData();
    const entry = String(form.get("entry") ?? "");
    const requestedMode = String(form.get("rewindMode") ?? "discard");
    const mode = requestedMode === "summary" ? "summary" : "discard";
    const customInstructions = mode === "summary" ? String(form.get("customInstructions") ?? "") : undefined;
    const runtime = await getWorkspaceAgentRuntime(await requireAgent(params[0], params[1]), options);
    if (entry) await runtime.rewind(entry, mode, customInstructions);
    return turboStreamResponse("");
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Completions + messages
// ---------------------------------------------------------------------------

async function completionsEndpoint(workspaceId: string, url: URL): Promise<Response> {
  const query = url.searchParams.get("q") ?? "";
  let html: string;
  if (url.searchParams.get("kind") === "slash-command") {
    const [templates, { skills }] = await Promise.all([listPromptTemplates(workspaceId), loadWorkspaceSkills(workspaceId)]);
    html = renderSlashCommandMenu(templates, skills, query);
  } else {
    html = renderFileCompletionMenu(await listFileCompletions(workspaceId, query, url.searchParams.get("mode") === "fuzzy" ? "fuzzy" : "direct"));
  }
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function expandPromptTemplateEndpoint(workspaceId: string, request: Request): Promise<Response> {
  const form = await request.formData();
  const text = String(form.get("text") ?? "");
  const expanded = await expandPromptTemplate(workspaceId, text);
  return new Response(expanded, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

async function agentMessagesEndpoint(workspaceId: string, label: string, request: Request, options: AgentRouteOptions): Promise<Response> {
  const agent = await requireAgent(workspaceId, label);
  const runtime = await getWorkspaceAgentRuntime(agent, options);
  const json = requestAcceptsJson(request) ? await readJsonObject(request) : undefined;
  const form = json ? undefined : await request.formData();
  const text = String(json?.text ?? form?.get("text") ?? "");
  const attachmentDraft = String(json?.attachmentDraft ?? form?.get("attachmentDraft") ?? "");
  if (text.trim() === "/new") {
    await runtime.newSession();
    if (validDraftId(attachmentDraft)) await removeAttachmentDraft(attachmentDraft);
    return json ? Response.json({ agent: { label, state: "idle" } }) : turboStreamResponse("");
  }
  const nameCommand = parseWorkspaceNameCommand(text);
  if (nameCommand) {
    if (nameCommand.title) {
      await setWorkspaceTitle(workspaceId, nameCommand.title);
      await options.events?.emit("workspace_title_changed", { workspaceId, title: nameCommand.title });
    } else {
      renameWorkspaceFromAgentContext(workspaceId, runtime.userMessages(), { events: options.events, agentModel: runtime.currentModel() });
    }
    if (validDraftId(attachmentDraft)) await removeAttachmentDraft(attachmentDraft);
    return json ? Response.json({ agent: { label, state: "idle" } }) : turboStreamResponse("");
  }

  const mode: SubmitMode = (json?.mode ?? form?.get("mode")) === "steer" ? "steer" : "send";
  const attachmentIds = form?.getAll("attachment").map(String) ?? [];
  const { images, attachmentNotes } = attachmentIds.length > 0
    ? await deliverAttachmentDraft(workspaceId, attachmentDraft, attachmentIds)
    : { images: [], attachmentNotes: [] };

  const expandedText = await expandPromptTemplate(workspaceId, text);
  const trimmed = expandedText.trim();
  if (trimmed) {
    await options.events?.emit("workspace_user_activity", { workspaceId });
    maybeNameWorkspaceFromAgentPrompt(workspaceId, [...runtime.userMessages(), trimmed], { events: options.events, agentModel: runtime.currentModel() });
  }
  await runtime.submit(expandedText, { mode, images, attachmentNotes });
  return json ? Response.json({ agent: { label, state: "running" } }, { status: 202 }) : turboStreamResponse("");
}

async function initializeWorkspaceAgent(workspaceId: string, context: AgentWorkspaceCreationContext, options: AgentRouteOptions): Promise<void> {
  const agent = await ensureDefaultWorkspaceAgent(workspaceId);
  const runtime = await getWorkspaceAgentRuntime(agent, options);
  const modelRef = context.model ? parseModelRef(context.model) : undefined;
  if (modelRef) await runtime.setModel(modelRef.provider, modelRef.id);
  const thinkingLevel = context.thinkingLevel || (modelRef ? await getModelThinkingLevel(modelRef.provider, modelRef.id) : undefined);
  if (thinkingLevel) await runtime.setThinkingLevel(thinkingLevel);

  const prompt = await expandPromptTemplate(workspaceId, context.initialPrompt ?? "");
  const draftId = context.attachmentDraft ?? "";
  const { images, attachmentNotes } = validDraftId(draftId)
    ? await deliverAttachmentDraft(workspaceId, draftId)
    : { images: [], attachmentNotes: [] };
  if (!prompt.trim() && images.length === 0 && attachmentNotes.length === 0) return;

  await options.events?.emit("workspace_user_activity", { workspaceId });
  maybeNameWorkspaceFromAgentPrompt(workspaceId, [...runtime.userMessages(), prompt.trim()], { events: options.events, agentModel: runtime.currentModel() });
  await runtime.submit(prompt, { mode: "send", images, attachmentNotes });
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

async function uploadAttachmentEndpoint(draftId: string, request: Request, rowId?: string): Promise<Response> {
  if (!validDraftId(draftId)) return turboStreamResponse("", { status: 400 });
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return turboStreamResponse("", { status: 400 });
  const staged = await stageAttachment(draftId, file);
  const chip = renderAttachmentChip(undefined, staged, { draftId });
  return turboStreamResponse(turboStream("append", rowId || ids.draftAttachRow(draftId), chip));
}

async function deleteAttachmentEndpoint(draftId: string, attachmentId: string): Promise<Response> {
  if (!await findStagedAttachment(draftId, attachmentId)) return turboStreamResponse("", { status: 404 });
  await removeStagedAttachment(draftId, attachmentId);
  return turboStreamResponse(turboStream("remove", ids.draftChip(draftId, attachmentId)));
}

// ---------------------------------------------------------------------------
// Pi session image serving
// ---------------------------------------------------------------------------

const sessionImageMimeTypes = new Set(Object.values(imageMimeByExtension));

export async function sessionImageEndpoint(sessionFile: string, entryId: string, contentIndex: number): Promise<Response> {
  const lines = (await readFile(sessionFile, "utf8")).split("\n").filter(Boolean);
  const entry = lines
    .map((line) => JSON.parse(line) as { id?: string; message?: { content?: unknown } })
    .find((candidate) => candidate.id === entryId);
  if (!entry || !Array.isArray(entry.message?.content)) return new Response("not found", { status: 404 });

  const part = entry.message.content[contentIndex] as { type?: unknown; mimeType?: unknown; data?: unknown } | undefined;
  if (part?.type !== "image" || typeof part.mimeType !== "string" || !sessionImageMimeTypes.has(part.mimeType) || typeof part.data !== "string") {
    return new Response("not found", { status: 404 });
  }

  const data = Buffer.from(part.data, "base64");
  return new Response(data, { headers: {
    "cache-control": "private, max-age=31536000, immutable",
    "content-length": String(data.byteLength),
    "content-security-policy": "default-src 'none'; sandbox",
    "content-type": part.mimeType,
    "x-content-type-options": "nosniff",
  } });
}

// ---------------------------------------------------------------------------
// Container file serving (Range-capable, for <img>/<video>)
// ---------------------------------------------------------------------------

function parseRange(header: string | null, size: number): { start: number; end: number } | undefined {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return undefined;
  if (match[1] === "" && match[2] === "") return undefined;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return undefined;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (!Number.isFinite(start) || start > end) return undefined;
  return { start, end };
}

export async function workspaceFileEndpoint(workspaceId: string, path: string, request: Request): Promise<Response> {
  if (!path.startsWith("/") || path.includes("..") || path.includes("\0")) {
    return new Response("bad path", { status: 400 });
  }

  const container = workspaceContainerName(workspaceId);
  const quoted = `'${path.replaceAll("'", `'\\''`)}'`;
  const stat = Bun.spawnSync(["docker", "exec", container, "sh", "-c", `stat -c %s ${quoted} 2>/dev/null || stat -f %z ${quoted}`]);
  const size = Number(new TextDecoder().decode(stat.stdout).trim());
  if (stat.exitCode !== 0 || !Number.isFinite(size)) return new Response("not found", { status: 404 });

  const range = parseRange(request.headers.get("range"), size);
  const command = range
    ? `tail -c +${range.start + 1} ${quoted} | head -c ${range.end - range.start + 1}`
    : `cat ${quoted}`;
  const proc = Bun.spawn(["docker", "exec", container, "sh", "-c", command], { stdout: "pipe", stderr: "ignore" });
  const headers: Record<string, string> = {
    "content-type": contentTypeFor(path),
    "accept-ranges": "bytes",
  };
  if (range) {
    headers["content-range"] = `bytes ${range.start}-${range.end}/${size}`;
    headers["content-length"] = String(range.end - range.start + 1);
    return new Response(proc.stdout, { status: 206, headers });
  }
  headers["content-length"] = String(size);
  return new Response(proc.stdout, { headers });
}

// ---------------------------------------------------------------------------
// Dev-server proxy
// ---------------------------------------------------------------------------

export async function resolveWorkspacePortProxyTarget(workspaceId: string, port: number, path: string, search = ""): Promise<URL> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("bad port");
  return await workspacePreviewPortUrl(workspaceId, port, `${path.startsWith("/") ? path : `/${path}`}${search}`);
}

