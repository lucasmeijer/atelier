import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AtelierCoreError, defaultDataDir, getWorkspacePreviewPort, workspaceContainerName, workspacePreviewPorts, type AtelierEventBus } from "@atelier/core";
import { ids, renderAttachmentChip } from "./render.ts";
import { sseFrame, turboStream, turboStreamResponse } from "./html.ts";
import { getWorkspaceAgentRuntime, isFakeMode, type RewindMode, type SubmitMode } from "./runtime.ts";
import { ensureDefaultWorkspaceAgent, listWorkspaceAgents, type WorkspaceAgentInfo } from "./session-store.ts";
import type { ImageRef } from "./transcript.ts";
import { maybeNameWorkspaceFromAgentPrompt } from "./workspace-title-suggestion.ts";

export interface AgentRouteOptions {
  events?: AtelierEventBus;
}

export interface AgentWorkspaceCreationContext {
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
    await submitInitialAgentPrompt(workspaceId, agentContext, { events });
  });
}

const imageMimeByExtension: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
};

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

function extensionOf(path: string): string {
  return (path.split(".").pop() ?? "").toLowerCase();
}

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
// Attachment staging
// ---------------------------------------------------------------------------

function attachmentDraftsDir(): string {
  return join(defaultDataDir(), "agent-attachment-drafts");
}

function attachmentDraftDir(draftId: string): string {
  return join(attachmentDraftsDir(), draftId);
}

function validDraftId(draftId: string): boolean {
  return /^[a-zA-Z0-9_-]{8,80}$/.test(draftId);
}

function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  return base.replace(/[^a-zA-Z0-9._ ()-]/g, "_").slice(0, 120) || "file";
}

interface StagedAttachment {
  id: string;
  name: string;
  path: string;
  size: number;
  isImage: boolean;
}

async function findStagedAttachment(draftId: string, attachmentId: string): Promise<StagedAttachment | undefined> {
  if (!validDraftId(draftId) || !/^[a-f0-9-]{8,40}$/.test(attachmentId)) return undefined;
  const dir = join(attachmentDraftDir(draftId), attachmentId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  const name = names[0];
  if (!name) return undefined;
  const path = join(dir, name);
  const file = Bun.file(path);
  return { id: attachmentId, name, path, size: file.size, isImage: Boolean(imageMimeByExtension[extensionOf(name)]) };
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
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/followups\/([^/]+)\/cancel$/)) && request.method === "POST") {
    const runtime = await getWorkspaceAgentRuntime(await requireAgent(params[0], params[1]), options);
    await runtime.cancelFollowup(params[2]);
    return turboStreamResponse("");
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/abort$/)) && request.method === "POST") {
    const runtime = await getWorkspaceAgentRuntime(await requireAgent(params[0], params[1]), options);
    await runtime.abort();
    return turboStreamResponse("");
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/model$/)) && request.method === "POST") {
    const form = await request.formData();
    const [provider, modelId] = String(form.get("model") ?? "").split("::");
    const runtime = await getWorkspaceAgentRuntime(await requireAgent(params[0], params[1]), options);
    if (provider && modelId) await runtime.setModel(provider, modelId);
    return turboStreamResponse("");
  }
  if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/thinking$/)) && request.method === "POST") {
    const form = await request.formData();
    const level = String(form.get("level") ?? "");
    const runtime = await getWorkspaceAgentRuntime(await requireAgent(params[0], params[1]), options);
    if (level) await runtime.setThinkingLevel(level);
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
// Messages
// ---------------------------------------------------------------------------

async function agentMessagesEndpoint(workspaceId: string, label: string, request: Request, options: AgentRouteOptions): Promise<Response> {
  const agent = await requireAgent(workspaceId, label);
  const runtime = await getWorkspaceAgentRuntime(agent, options);
  const form = await request.formData();
  const text = String(form.get("text") ?? "");
  const modeRaw = String(form.get("mode") ?? "send");
  const mode: SubmitMode = modeRaw === "steer" || modeRaw === "followup" ? modeRaw : "send";
  const attachmentIds = form.getAll("attachment").map(String);
  const attachmentDraft = String(form.get("attachmentDraft") ?? "");

  const images: ImageRef[] = [];
  const attachmentNotes: string[] = [];
  for (const attachmentId of attachmentIds) {
    const staged = await findStagedAttachment(attachmentDraft, attachmentId);
    if (!staged) continue;
    if (staged.isImage) {
      const data = await readFile(staged.path);
      images.push({ mimeType: imageMimeByExtension[extensionOf(staged.name)] ?? "image/png", data: data.toString("base64") });
    } else {
      attachmentNotes.push(await deliverFileAttachment(workspaceId, staged));
    }
    await rm(join(attachmentDraftDir(attachmentDraft), staged.id), { recursive: true, force: true });
  }

  const trimmed = text.trim();
  if (trimmed) {
    await options.events?.emit("workspace_user_activity", { workspaceId });
    maybeNameWorkspaceFromAgentPrompt(workspaceId, [...runtime.userMessages(), trimmed], { events: options.events });
  }
  await runtime.submit(text, { mode, images, attachmentNotes });
  return turboStreamResponse("");
}

async function submitInitialAgentPrompt(workspaceId: string, context: AgentWorkspaceCreationContext, options: AgentRouteOptions): Promise<void> {
  const agent = await ensureDefaultWorkspaceAgent(workspaceId);
  const runtime = await getWorkspaceAgentRuntime(agent, options);
  if (context.model) {
    const [provider, modelId] = context.model.split("::");
    if (provider && modelId) await runtime.setModel(provider, modelId);
  }
  if (context.thinkingLevel) await runtime.setThinkingLevel(context.thinkingLevel);

  const images: ImageRef[] = [];
  const attachmentNotes: string[] = [];
  const draftId = context.attachmentDraft ?? "";
  if (validDraftId(draftId)) {
    let entries: string[] = [];
    try {
      entries = await readdir(attachmentDraftDir(draftId));
    } catch {
      entries = [];
    }
    for (const attachmentId of entries) {
      const staged = await findStagedAttachment(draftId, attachmentId);
      if (!staged) continue;
      if (staged.isImage) {
        const data = await readFile(staged.path);
        images.push({ mimeType: imageMimeByExtension[extensionOf(staged.name)] ?? "image/png", data: data.toString("base64") });
      } else {
        attachmentNotes.push(await deliverFileAttachment(workspaceId, staged));
      }
    }
    await rm(attachmentDraftDir(draftId), { recursive: true, force: true });
  }

  const prompt = context.initialPrompt ?? "";
  await options.events?.emit("workspace_user_activity", { workspaceId });
  maybeNameWorkspaceFromAgentPrompt(workspaceId, [...runtime.userMessages(), prompt.trim()], { events: options.events });
  await runtime.submit(prompt, { mode: "send", images, attachmentNotes });
}

async function deliverFileAttachment(workspaceId: string, staged: StagedAttachment): Promise<string> {
  if (isFakeMode()) return `[Attached file: ${staged.name}]`;
  const target = `/repos/.atelier-attachments/${staged.name}`;
  try {
    const content = await readFile(staged.path);
    const { execWorkspaceCommand } = await import("@atelier/core");
    const result = await execWorkspaceCommand(
      workspaceId,
      ["sh", "-c", `mkdir -p /repos/.atelier-attachments && base64 -d > '${target.replaceAll("'", `'\\''`)}'`],
      { stdin: content.toString("base64") },
    );
    if (result.exitCode !== 0) return `[Attached file ${staged.name}: failed to copy into workspace]`;
    return `[Attached file copied into the workspace at ${target}]`;
  } catch {
    return `[Attached file ${staged.name}: failed to copy into workspace]`;
  }
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

async function uploadAttachmentEndpoint(draftId: string, request: Request, rowId?: string): Promise<Response> {
  if (!validDraftId(draftId)) return turboStreamResponse("", { status: 400 });
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return turboStreamResponse("", { status: 400 });
  const attachmentId = crypto.randomUUID();
  const name = sanitizeFilename(file.name || "file");
  const dir = join(attachmentDraftDir(draftId), attachmentId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), Buffer.from(await file.arrayBuffer()));
  const chip = renderAttachmentChip(undefined, { id: attachmentId, name, size: file.size, isImage: Boolean(imageMimeByExtension[extensionOf(name)]) }, { draftId });
  return turboStreamResponse(turboStream("append", rowId || ids.draftAttachRow(draftId), chip));
}

async function deleteAttachmentEndpoint(draftId: string, attachmentId: string): Promise<Response> {
  const staged = await findStagedAttachment(draftId, attachmentId);
  if (staged) await rm(join(attachmentDraftDir(draftId), staged.id), { recursive: true, force: true });
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

  if (isFakeMode()) {
    const file = Bun.file(path);
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    const range = parseRange(request.headers.get("range"), file.size);
    if (range) {
      return new Response(file.slice(range.start, range.end + 1), {
        status: 206,
        headers: {
          "content-type": contentTypeFor(path),
          "content-range": `bytes ${range.start}-${range.end}/${file.size}`,
          "accept-ranges": "bytes",
        },
      });
    }
    return new Response(file, { headers: { "content-type": contentTypeFor(path), "accept-ranges": "bytes" } });
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

function publishedPortHost(): string {
  return process.env.ATELIER_DOCKER_PUBLISHED_PORT_HOST || "127.0.0.1";
}

export async function resolveWorkspacePortProxyTarget(workspaceId: string, port: number, path: string, search = ""): Promise<URL> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("bad port");
  if (!(workspacePreviewPorts as readonly number[]).includes(port)) {
    throw new Error(`Port ${port} is not published for previews. Use one of: ${workspacePreviewPorts.join(", ")}`);
  }
  const hostPort = isFakeMode() ? port : await getWorkspacePreviewPort(workspaceId, port);
  return new URL(`${path.startsWith("/") ? path : `/${path}`}${search}`, `http://${publishedPortHost()}:${hostPort}`);
}

