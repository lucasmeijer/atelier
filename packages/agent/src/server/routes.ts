import { readFile } from "node:fs/promises";
import { AtelierCoreError, readJsonObject, requestAcceptsJson, type AtelierEventBus } from "@atelier/core";
import { atelierCableConnectionHeader, type AgentWorkspaceParameters } from "@atelier/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { getModelThinkingLevel, setModelThinkingLevel } from "./pi-config-models.ts";
import { parseModelRef } from "./model-state.ts";
import { getWorkspaceInit, workspaceContainerName, workspacePreviewPortUrl, type WorkspaceAgentViewInvalidatedEvent } from "@atelier/workspace";
import { isGitProjectInit, neverOfferProjectPreparation } from "@atelier/projects";
import {
  deliverAttachmentDraft,
  agentAttachmentDraftId,
  extensionOf,
  findStagedAttachment,
  imageMimeByExtension,
  moveAttachmentDraft,
  removeAttachmentDraft,
  removeStagedAttachment,
  removeStagedAttachments,
  stageAttachment,
  validDraftId,
} from "./attachment-drafts.ts";
import { ids, renderAgentPanePromptInput, renderAttachmentChip } from "./render.ts";
import { turboStream, turboStreamResponse } from "./html.ts";
import { expandPromptTemplate, listPromptTemplates, parseCompactCommand, parseAgentSessionNameCommand } from "./prompt-templates.ts";
import { listFileCompletions, renderFileCompletionMenu } from "./file-completions.ts";
import { loadWorkspaceSkills } from "./skills.ts";
import { renderSlashCommandCatalog } from "./slash-commands.ts";
import { getWorkspaceAgentRuntime, type SubmitMode } from "./runtime.ts";
import { handleAgentTreeRequest } from "./session-tree.ts";
import { ensureDefaultWorkspaceAgentConversation, listWorkspaceAgentConversations, type WorkspaceAgentConversationInfo } from "./session-store.ts";
import { maybeNameAgentFromPrompt, renameAgentFromContext, setAgentSessionTitle } from "./agent-title-suggestion.ts";
import { parseAgentServiceTier } from "./service-tier.ts";
import { acceptInitialPromptDraft, removeInitialPromptDraft, stageInitialPrompt } from "./initial-prompt-draft.ts";

interface AgentRouteOptions {
  events?: AtelierEventBus;
  getRuntime?: typeof getWorkspaceAgentRuntime;
  suggestTitleFromPrompt?: typeof maybeNameAgentFromPrompt;
}

async function invalidateAgentView(options: AgentRouteOptions, workspaceId: string, conversationId: string, exceptConnectionId?: string, html?: string): Promise<void> {
  const event: WorkspaceAgentViewInvalidatedEvent = { workspaceId, conversationId };
  if (exceptConnectionId) event.exceptConnectionId = exceptConnectionId;
  if (html) event.html = html;
  await options.events?.emit("workspace_agent_view_invalidated", event);
}

async function resolveAgentRuntime(agent: WorkspaceAgentConversationInfo, options: AgentRouteOptions): ReturnType<typeof getWorkspaceAgentRuntime> {
  return await (options.getRuntime ?? getWorkspaceAgentRuntime)(agent, { events: options.events });
}

async function removeInitialPromptAfterAcceptedAction(request: Request, options: AgentRouteOptions, workspaceId: string, conversationId: string): Promise<string> {
  await removeInitialPromptDraft(workspaceId, conversationId);
  const html = turboStream("remove", ids.initialPromptSuggestion({ workspaceId, conversationId }), "");
  await invalidateAgentView(options, workspaceId, conversationId, request.headers.get(atelierCableConnectionHeader) ?? undefined, html);
  return html;
}

export function registerAgentEvents(events: AtelierEventBus): void {
  events.on("workspace_created", async ({ workspaceId, context }) => {
    const agentContext = context?.agent;
    if (!agentContext) return;
    const hasPrompt = !agentContext.initialPromptMode && Boolean(agentContext.initialPrompt?.trim());
    if (hasPrompt) await events.emit("workspace_provision_step", { workspaceId, id: "agent.initial_prompt", label: "Start initial agent task", parentId: "workspace.integrations", status: "running" });
    await initializeWorkspaceAgent(workspaceId, agentContext, { events });
    if (hasPrompt) await events.emit("workspace_provision_step", { workspaceId, id: "agent.initial_prompt", label: "Start initial agent task", parentId: "workspace.integrations", status: "done" });
  });
}

interface AgentFileMimeRegistry {
  [extension: string]: string;
}

const mimeByExtension: AgentFileMimeRegistry = {
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

async function requireAgentConversation(workspaceId: string, conversationId: string): Promise<WorkspaceAgentConversationInfo> {
  const conversations = await listWorkspaceAgentConversations(workspaceId);
  const conversation = conversations.find((candidate) => candidate.conversationId === conversationId);
  if (!conversation) throw new AtelierCoreError("agent_conversation_not_found", `Agent conversation not found: ${conversationId}`);
  return conversation;
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
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/initial-prompt-draft\/accept$/)) && request.method === "POST") {
    const ctx = { workspaceId: params[0], conversationId: params[1] };
    await requireAgentConversation(ctx.workspaceId, ctx.conversationId);
    const draft = await acceptInitialPromptDraft(ctx.workspaceId, ctx.conversationId);
    const suggestionRemoved = turboStream("remove", ids.initialPromptSuggestion(ctx), "");
    await invalidateAgentView(options, ctx.workspaceId, ctx.conversationId, request.headers.get(atelierCableConnectionHeader) ?? undefined, suggestionRemoved);
    return turboStreamResponse(`${turboStream("replace", ids.input(ctx), renderAgentPanePromptInput(ctx, draft.prompt))}${suggestionRemoved}`);
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/initial-prompt-draft\/(decline|never)$/)) && request.method === "POST") {
    const ctx = { workspaceId: params[0], conversationId: params[1] };
    await requireAgentConversation(ctx.workspaceId, ctx.conversationId);
    if (params[2] === "never") {
      const init = await getWorkspaceInit(ctx.workspaceId);
      if (!isGitProjectInit(init)) throw new AtelierCoreError("invalid_workspace_source", "workspace is not associated with a project");
      await neverOfferProjectPreparation(init.projectId);
    }
    return turboStreamResponse(await removeInitialPromptAfterAcceptedAction(request, options, ctx.workspaceId, ctx.conversationId));
  }

  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/messages$/)) && request.method === "POST") {
    return await agentMessagesEndpoint(params[0], params[1], request, options);
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/transcript-items\/([^/]+)$/)) && request.method === "GET") {
    const runtime = await resolveAgentRuntime(await requireAgentConversation(params[0], params[1]), options);
    const count = Math.max(100, Math.min(100_000, Number(url.searchParams.get("count") ?? 100) || 100));
    const html = await runtime.detailHtml(params[2], count);
    return new Response(html || "not found", { status: html ? 200 : 404, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/session-images\/([^/]+)\/(\d+)$/)) && request.method === "GET") {
    const agent = await requireAgentConversation(params[0], params[1]);
    return await sessionImageEndpoint(agent.path, params[2], Number(params[3]));
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/completions$/)) && request.method === "GET") {
    await requireAgentConversation(params[0], params[1]);
    return await completionsEndpoint(params[0], url);
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/completion-catalog$/)) && request.method === "GET") {
    return await completionCatalogEndpoint(params[0]);
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/tree(\/summary|\/label|)$/))) {
    const [workspaceId, conversationId, suffix] = params;
    const response = await handleAgentTreeRequest(request, url, suffix, async () => await resolveAgentRuntime(await requireAgentConversation(workspaceId, conversationId), options));
    if (response && request.method === "POST") await invalidateAgentView(options, workspaceId, conversationId);
    return response;
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/completions\/prompt-template-expand$/)) && request.method === "POST") {
    await requireAgentConversation(params[0], params[1]);
    return await expandPromptTemplateEndpoint(params[0], request);
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/abort$/)) && request.method === "POST") {
    const runtime = await resolveAgentRuntime(await requireAgentConversation(params[0], params[1]), options);
    await runtime.abort();
    await invalidateAgentView(options, params[0], params[1]);
    return requestAcceptsJson(request) ? Response.json({ agent: { conversationId: params[1], state: "idle", aborted: true } }) : turboStreamResponse("");
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/model$/)) && request.method === "POST") {
    const json = requestAcceptsJson(request);
    const value = json ? (await readJsonObject(request)).model : (await request.formData()).get("model");
    const model = parseModelRef(String(value ?? ""));
    if (!model) {
      if (json) throw new AtelierCoreError("invalid_arguments", "valid model is required");
      return turboStreamResponse("");
    }
    const runtime = await resolveAgentRuntime(await requireAgentConversation(params[0], params[1]), options);
    await runtime.setModel(model.provider, model.id);
    await invalidateAgentView(options, params[0], params[1]);
    return json ? Response.json({ agent: { conversationId: params[1], model: `${model.provider}::${model.id}` } }) : turboStreamResponse("");
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/service-tier$/)) && request.method === "POST") {
    const json = requestAcceptsJson(request);
    const value = json ? (await readJsonObject(request)).serviceTier : (await request.formData()).get("serviceTier");
    const serviceTier = parseAgentServiceTier(value);
    const runtime = await resolveAgentRuntime(await requireAgentConversation(params[0], params[1]), options);
    await runtime.setServiceTier(serviceTier);
    await invalidateAgentView(options, params[0], params[1]);
    return json ? Response.json({ agent: { conversationId: params[1], serviceTier } }) : turboStreamResponse("");
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/thinking$/)) && request.method === "POST") {
    const json = requestAcceptsJson(request);
    const value = json ? (await readJsonObject(request)).level : (await request.formData()).get("level");
    const level = String(value ?? "");
    if (!level) {
      if (json) throw new AtelierCoreError("invalid_arguments", "level is required");
      return turboStreamResponse("");
    }
    const runtime = await resolveAgentRuntime(await requireAgentConversation(params[0], params[1]), options);
    await runtime.setThinkingLevel(level);
    const model = runtime.currentModel();
    if (model) await setModelThinkingLevel(model.provider, model.id, level);
    await invalidateAgentView(options, params[0], params[1]);
    return json ? Response.json({ agent: { conversationId: params[1], thinkingLevel: level } }) : turboStreamResponse("");
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/rewind$/)) && request.method === "POST") {
    const form = await request.formData();
    const entry = String(form.get("entry") ?? "");
    const requestedMode = String(form.get("rewindMode") ?? "discard");
    const mode = requestedMode === "summary" ? "summary" : "discard";
    const customInstructions = mode === "summary" ? String(form.get("customInstructions") ?? "") : undefined;
    const runtime = await resolveAgentRuntime(await requireAgentConversation(params[0], params[1]), options);
    if (entry) {
      await runtime.rewind(entry, mode, customInstructions);
      await invalidateAgentView(options, params[0], params[1]);
    }
    return turboStreamResponse("");
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Completions + messages
// ---------------------------------------------------------------------------

async function completionCatalogEndpoint(workspaceId: string): Promise<Response> {
  const [templates, { skills }] = await Promise.all([listPromptTemplates(workspaceId), loadWorkspaceSkills(workspaceId)]);
  return new Response(renderSlashCommandCatalog(templates, skills), { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function completionsEndpoint(workspaceId: string, url: URL): Promise<Response> {
  const query = url.searchParams.get("q") ?? "";
  const mode = url.searchParams.get("mode") === "fuzzy" ? "fuzzy" : "direct";
  const html = renderFileCompletionMenu(await listFileCompletions(workspaceId, query, mode));
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function expandPromptTemplateEndpoint(workspaceId: string, request: Request): Promise<Response> {
  const form = await request.formData();
  const text = String(form.get("text") ?? "");
  const expanded = await expandPromptTemplate(workspaceId, text);
  return new Response(expanded, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

async function agentMessagesEndpoint(workspaceId: string, conversationId: string, request: Request, options: AgentRouteOptions): Promise<Response> {
  const agent = await requireAgentConversation(workspaceId, conversationId);
  const json = requestAcceptsJson(request) ? await readJsonObject(request) : undefined;
  const form = json ? undefined : await request.formData();
  const text = String(json?.text ?? form?.get("text") ?? "");
  if (text.trim() === "/new") {
    const runtime = await resolveAgentRuntime(agent, options);
    await runtime.newSession();
    const promptRemoved = await removeInitialPromptAfterAcceptedAction(request, options, workspaceId, conversationId);
    return json ? Response.json({ agent: { conversationId, state: "idle" } }) : turboStreamResponse(promptRemoved);
  }
  if (text.trim() === "/park") {
    await options.events?.emit("workspace_park_requested", { workspaceId });
    const promptRemoved = await removeInitialPromptAfterAcceptedAction(request, options, workspaceId, conversationId);
    return json ? Response.json({ agent: { conversationId, state: "idle" }, workspace: { id: workspaceId, parked: true } }) : turboStreamResponse(promptRemoved);
  }
  const compactCommand = parseCompactCommand(text);
  if (compactCommand) {
    const runtime = await resolveAgentRuntime(agent, options);
    await options.events?.emit("workspace_user_activity", { workspaceId });
    await runtime.compact(compactCommand.customInstructions);
    const promptRemoved = await removeInitialPromptAfterAcceptedAction(request, options, workspaceId, conversationId);
    return json ? Response.json({ agent: { conversationId, state: "idle", compacted: true } }) : turboStreamResponse(promptRemoved);
  }
  const nameCommand = parseAgentSessionNameCommand(text);
  if (nameCommand) {
    if (nameCommand.title) {
      await setAgentSessionTitle(agent, nameCommand.title, { events: options.events });
    } else {
      const runtime = await resolveAgentRuntime(agent, options);
      renameAgentFromContext(agent, runtime.userMessages(), { events: options.events, agentModel: runtime.currentModel() });
    }
    const promptRemoved = await removeInitialPromptAfterAcceptedAction(request, options, workspaceId, conversationId);
    return json ? Response.json({ agent: { conversationId, state: "idle" } }) : turboStreamResponse(promptRemoved);
  }

  const mode: SubmitMode = (json?.mode ?? form?.get("mode")) === "steer" ? "steer" : "send";
  const attachmentDraft = agentAttachmentDraftId(workspaceId, conversationId);
  if (form && String(form.get("attachmentDraft") ?? "") !== attachmentDraft) {
    return turboStreamResponse("", { status: 422 });
  }
  const attachmentIds = form?.getAll("attachment").map(String) ?? [];
  const { images, attachmentNotes } = attachmentIds.length > 0
    ? await deliverAttachmentDraft(workspaceId, attachmentDraft, attachmentIds)
    : { images: [], attachmentNotes: [] };
  const reviewCommentIds = (form?.getAll("reviewComment").map(String) ?? []).filter((id) => /^[a-f0-9-]{36}$/.test(id));
  const sections: string[] = [];
  if (reviewCommentIds.length) await options.events?.emit("workspace_agent_prompt_preparing", { workspaceId, reviewCommentIds, sections });
  const expandedText = await expandPromptTemplate(workspaceId, [text, ...sections].filter((section) => section.trim()).join("\n\n"));
  const trimmed = expandedText.trim();
  if (!trimmed && images.length === 0 && attachmentNotes.length === 0) {
    const message = "A prompt or completed attachment is required";
    return json
      ? Response.json({ error: { code: "invalid_arguments", message } }, { status: 422 })
      : turboStreamResponse("", { status: 422 });
  }
  const runtime = await resolveAgentRuntime(agent, options);
  const namingContext = trimmed ? { messages: [...runtime.userMessages(), trimmed], agentModel: runtime.currentModel() } : undefined;
  await runtime.submit(expandedText, { mode, images, attachmentNotes });
  if (namingContext) {
    await options.events?.emit("workspace_user_activity", { workspaceId });
    (options.suggestTitleFromPrompt ?? maybeNameAgentFromPrompt)(agent, namingContext.messages, { events: options.events, agentModel: namingContext.agentModel });
  }
  await removeStagedAttachments(attachmentDraft, attachmentIds);
  if (reviewCommentIds.length) await options.events?.emit("workspace_agent_prompt_submitted", { workspaceId, reviewCommentIds });
  const promptRemoved = await removeInitialPromptAfterAcceptedAction(request, options, workspaceId, conversationId);
  const acceptedHeaders = { "x-atelier-attachment-draft-consumed": "true" };
  return json
    ? Response.json({ agent: { conversationId, state: "running" } }, { status: 202, headers: acceptedHeaders })
    : turboStreamResponse(promptRemoved, { headers: acceptedHeaders });
}

async function initializeWorkspaceAgent(workspaceId: string, context: AgentWorkspaceParameters, options: AgentRouteOptions): Promise<void> {
  const agent = await ensureDefaultWorkspaceAgentConversation(workspaceId);
  const runtime = await resolveAgentRuntime(agent, options);
  const modelRef = context.model ? parseModelRef(context.model) : undefined;
  if (modelRef) await runtime.setModel(modelRef.provider, modelRef.id);
  const thinkingLevel = context.thinkingLevel || (modelRef ? await getModelThinkingLevel(modelRef.provider, modelRef.id) : undefined);
  if (thinkingLevel) await runtime.setThinkingLevel(thinkingLevel);
  if (context.serviceTier) await runtime.setServiceTier(context.serviceTier);

  const initialPromptMode = context.initialPromptMode;
  if (initialPromptMode) {
    const prompt = context.initialPrompt ?? "";
    if (prompt) await stageInitialPrompt(workspaceId, agent.conversationId, prompt, initialPromptMode);
    const attachmentDraft = context.attachmentDraft ?? "";
    if (initialPromptMode === "composer" && validDraftId(attachmentDraft)) {
      await moveAttachmentDraft(attachmentDraft, agentAttachmentDraftId(workspaceId, agent.conversationId));
    }
    return;
  }

  const prompt = await expandPromptTemplate(workspaceId, context.initialPrompt ?? "");
  const draftId = context.attachmentDraft ?? "";
  const { images, attachmentNotes } = validDraftId(draftId)
    ? await deliverAttachmentDraft(workspaceId, draftId)
    : { images: [], attachmentNotes: [] };
  if (!prompt.trim() && images.length === 0 && attachmentNotes.length === 0) return;

  await options.events?.emit("workspace_user_activity", { workspaceId });
  maybeNameAgentFromPrompt(agent, [...runtime.userMessages(), prompt.trim()], { events: options.events, agentModel: runtime.currentModel() });
  await runtime.submit(prompt, { mode: "send", images, attachmentNotes });
  if (validDraftId(draftId)) await removeAttachmentDraft(draftId);
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
  const chip = renderAttachmentChip(staged, draftId);
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
const sessionImageEntrySchema = Type.Object({
  id: Type.String(),
  message: Type.Object({ content: Type.Array(Type.Unknown()) }),
});
const sessionImagePartSchema = Type.Object({
  type: Type.Literal("image"),
  mimeType: Type.String(),
  data: Type.String(),
});

export async function sessionImageEndpoint(sessionFile: string, entryId: string, contentIndex: number): Promise<Response> {
  const lines = (await readFile(sessionFile, "utf8")).split("\n").filter(Boolean);
  const entry = lines
    .map((line) => {
      const candidate: unknown = JSON.parse(line);
      return Value.Check(sessionImageEntrySchema, candidate) ? candidate : undefined;
    })
    .find((candidate) => candidate?.id === entryId);
  if (!entry) return new Response("not found", { status: 404 });

  const part = entry.message.content[contentIndex];
  if (!Value.Check(sessionImagePartSchema, part) || !sessionImageMimeTypes.has(part.mimeType)) {
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
  const headers = new Headers({
    "content-type": contentTypeFor(path),
    "accept-ranges": "bytes",
  });
  if (range) {
    headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
    headers.set("content-length", String(range.end - range.start + 1));
    return new Response(proc.stdout, { status: 206, headers });
  }
  headers.set("content-length", String(size));
  return new Response(proc.stdout, { headers });
}

// ---------------------------------------------------------------------------
// Dev-server proxy
// ---------------------------------------------------------------------------

export async function resolveWorkspacePortProxyTarget(workspaceId: string, port: number, path: string, search = ""): Promise<URL> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("bad port");
  return await workspacePreviewPortUrl(workspaceId, port, `${path.startsWith("/") ? path : `/${path}`}${search}`);
}
