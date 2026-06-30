import { AtelierCoreError, type AtelierEventBus } from "@atelier/core";
import { getModelThinkingLevel, setModelThinkingLevel } from "./pi-config-models.ts";
import { parseModelRef, rememberPreferredAgentModel } from "./model-state.ts";
import { workspaceContainerName, workspacePreviewPortUrl } from "@atelier/workspace";
import {
  deliverAttachmentDraft,
  extensionOf,
  findStagedAttachment,
  imageMimeByExtension,
  removeStagedAttachment,
  stageAttachment,
  validDraftId,
} from "./attachment-drafts.ts";
import { ids, renderAttachmentChip } from "./render.ts";
import { sseFrame, turboStream, turboStreamResponse } from "./html.ts";
import { expandPromptTemplate, listPromptTemplates, renderPromptTemplateMenu } from "./prompt-templates.ts";
import { getWorkspaceAgentRuntime, type RewindMode, type SubmitMode } from "./runtime.ts";
import { ensureDefaultWorkspaceAgent, listWorkspaceAgents, type WorkspaceAgentInfo } from "./session-store.ts";
import { maybeNameWorkspaceFromAgentPrompt } from "./workspace-title-suggestion.ts";

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
  if (!initialPrompt?.trim()) return undefined;
  return {
    initialPrompt,
    model: typeof record.model === "string" ? record.model : undefined,
    thinkingLevel: typeof record.thinkingLevel === "string" ? record.thinkingLevel : undefined,
    attachmentDraft: typeof record.attachmentDraft === "string" ? record.attachmentDraft : undefined,
  };
}

export function registerAgentEvents(events: AtelierEventBus): void {
  events.on("workspace_created", async ({ workspaceId, context }) => {
    const agentContext = parseAgentWorkspaceCreationContext(context?.agent);
    if (!agentContext) return;
    await events.emit("workspace_provision_step", { workspaceId, id: "agent.initial_prompt", label: "Start initial agent task", parentId: "workspace.integrations", status: "running" });
    await submitInitialAgentPrompt(workspaceId, agentContext, { events });
    await events.emit("workspace_provision_step", { workspaceId, id: "agent.initial_prompt", label: "Start initial agent task", parentId: "workspace.integrations", status: "done" });
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

  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/events$/)) && request.method === "GET") {
    return await agentEventsEndpoint(params[0], params[1], options);
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/messages$/)) && request.method === "POST") {
    return await agentMessagesEndpoint(params[0], params[1], request, options);
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/prompt-templates$/)) && request.method === "GET") {
    return await promptTemplatesEndpoint(params[0], url);
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/abort$/)) && request.method === "POST") {
    const runtime = await getWorkspaceAgentRuntime(await requireAgent(params[0], params[1]), options);
    await runtime.abort();
    return turboStreamResponse("");
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/model$/)) && request.method === "POST") {
    const form = await request.formData();
    const modelRef = parseModelRef(String(form.get("model") ?? ""));
    const runtime = await getWorkspaceAgentRuntime(await requireAgent(params[0], params[1]), options);
    if (modelRef) {
      await runtime.setModel(modelRef.provider, modelRef.id);
      await rememberPreferredAgentModel(`${modelRef.provider}::${modelRef.id}`);
    }
    return turboStreamResponse("");
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/thinking$/)) && request.method === "POST") {
    const form = await request.formData();
    const level = String(form.get("level") ?? "");
    const runtime = await getWorkspaceAgentRuntime(await requireAgent(params[0], params[1]), options);
    if (level) {
      await runtime.setThinkingLevel(level);
      const model = runtime.currentModel();
      if (model) await setModelThinkingLevel(model.provider, model.id, level);
    }
    return turboStreamResponse("");
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/rewind$/)) && request.method === "POST") {
    const form = await request.formData();
    const entry = String(form.get("entry") ?? "");
    const mode = String(form.get("rewindMode") ?? "discard") as RewindMode;
    const note = String(form.get("note") ?? "");
    const runtime = await getWorkspaceAgentRuntime(await requireAgent(params[0], params[1]), options);
    if (entry) await runtime.rewind(entry, ["discard", "summary", "custom"].includes(mode) ? mode : "discard", note);
    return turboStreamResponse("");
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

async function agentEventsEndpoint(workspaceId: string, label: string, options: AgentRouteOptions = {}): Promise<Response> {
  const agent = await requireAgent(workspaceId, label);
  const runtime = await getWorkspaceAgentRuntime(agent, options);
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (html: string) => {
        try {
          controller.enqueue(encoder.encode(sseFrame(html)));
        } catch {
          // Stream closed.
        }
      };
      unsubscribe = runtime.subscribe(send);
      send(await runtime.snapshotStream());
      keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keepalive\n\n`));
        } catch {
          // Stream closed.
        }
      }, 5_000);
    },
    cancel() {
      unsubscribe?.();
      if (keepalive) clearInterval(keepalive);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    },
  });
}

// ---------------------------------------------------------------------------
// Prompt templates + messages
// ---------------------------------------------------------------------------

async function promptTemplatesEndpoint(workspaceId: string, url: URL): Promise<Response> {
  const templates = await listPromptTemplates(workspaceId);
  const q = url.searchParams.get("q") ?? "";
  return new Response(renderPromptTemplateMenu(templates, q), { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function agentMessagesEndpoint(workspaceId: string, label: string, request: Request, options: AgentRouteOptions): Promise<Response> {
  const agent = await requireAgent(workspaceId, label);
  const runtime = await getWorkspaceAgentRuntime(agent, options);
  const form = await request.formData();
  const text = String(form.get("text") ?? "");
  const modeRaw = String(form.get("mode") ?? "send");
  const mode: SubmitMode = modeRaw === "steer" ? "steer" : "send";
  const attachmentIds = form.getAll("attachment").map(String);
  const attachmentDraft = String(form.get("attachmentDraft") ?? "");
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
  return turboStreamResponse("");
}

async function submitInitialAgentPrompt(workspaceId: string, context: AgentWorkspaceCreationContext, options: AgentRouteOptions): Promise<void> {
  const agent = await ensureDefaultWorkspaceAgent(workspaceId);
  const runtime = await getWorkspaceAgentRuntime(agent, options);
  const modelRef = context.model ? parseModelRef(context.model) : undefined;
  if (modelRef) await runtime.setModel(modelRef.provider, modelRef.id);
  const thinkingLevel = context.thinkingLevel || (modelRef ? await getModelThinkingLevel(modelRef.provider, modelRef.id) : undefined);
  if (thinkingLevel) await runtime.setThinkingLevel(thinkingLevel);

  const draftId = context.attachmentDraft ?? "";
  const { images, attachmentNotes } = validDraftId(draftId)
    ? await deliverAttachmentDraft(workspaceId, draftId)
    : { images: [], attachmentNotes: [] };

  const prompt = await expandPromptTemplate(workspaceId, context.initialPrompt ?? "");
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

