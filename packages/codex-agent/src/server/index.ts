import { buttonHtml } from "@atelier/design-system/button";
import { observableTerminalStaticFiles } from "@atelier/observable-terminal/server";
import { domId, escapeHtml, providerBrandIconHtml, turboStream, turboStreamResponse, type WorkspaceModule } from "@atelier/shared";
import { closeCodexSession, codexSession, codexSessionAlive, createCodexSession, listCodexSessions } from "./sessions.ts";
import { codexSocketHandler } from "./sockets.ts";

function statusId(workspaceId: string, id: string) { return domId("codex_status", workspaceId, id); }
function retryButton() { return buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Retry connection" }, attributesHtml: 'data-action="codex-terminal#retry"' }); }

export const atelierServerModule: WorkspaceModule = {
  id: "codex-agent",
  staticFiles: {
    ...observableTerminalStaticFiles,
    "/codex-agent.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  },
  initialize(context) { context.registerSocketHandler(codexSocketHandler); },
  agentProvider: {
    id: "codex", label: "Codex", iconHtml: providerBrandIconHtml("openai"),
    create: ({ workspaceId }) => createCodexSession(workspaceId),
    tabs: {
      async list({ workspaceId }) { return listCodexSessions(workspaceId).map(({ id, title }) => ({ id, title })); },
      async render({ workspaceId, conversationId }) {
        const session = codexSession(workspaceId, conversationId);
        const alive = await codexSessionAlive(workspaceId, session);
        const url = `/workspaces/${encodeURIComponent(workspaceId)}/codex-agents/${encodeURIComponent(conversationId)}`;
        const attachments = session.input.attachmentNotes.map((note) => `<p>${escapeHtml(note)}</p>`).join("");
        const images = session.input.images.map((image, index) => `<img alt="Initial prompt attachment ${index + 1}" src="data:${escapeHtml(image.mimeType)};base64,${escapeHtml(image.data)}">`).join("");
        return `<section class="codex-agent-body" data-controller="codex-terminal" data-codex-terminal-url-value="${url}" data-action="atelier:workspace-pane-visible@window->codex-terminal#refresh atelier:theme-change@document->codex-terminal#theme">
          <div class="codex-agent-intro"><strong>Codex placeholder</strong><p>This is an interactive shell. No Codex agent is running.</p>
          ${session.input.text || attachments || images ? `<details open><summary>Initial prompt · Not executed</summary><pre>${escapeHtml(session.input.text)}</pre>${attachments}<div class="codex-prompt-images">${images}</div></details>` : ""}</div>
          <div id="${statusId(workspaceId, conversationId)}" class="codex-terminal-status" role="status">${alive ? "" : "Session ended"}</div>
          ${alive ? '<div class="observable-terminal-host" data-codex-terminal-target="terminal" tabindex="0"></div>' : ""}
        </section>`;
      },
      close: ({ workspaceId, conversationId }) => closeCodexSession(workspaceId, conversationId),
    },
    launch: {
      async renderFooter({ frameId }) { return `<turbo-frame id="${escapeHtml(frameId)}"><span class="codex-launch-note">Placeholder · prompt and attachments are saved, not executed.</span></turbo-frame>`; },
      async prepare() { return { agent: {} }; },
      async submit() { return { async prepare() { return { agent: {} }; } }; },
      async prepareWorkspace(workspaceId, context) { await createCodexSession(workspaceId, context?.agent?.input); },
    },
  },
  routes: [{ async handle(request, url) {
    const match = url.pathname.match(/^\/workspaces\/([^/]+)\/codex-agents\/([^/]+)\/status$/);
    if (!match || request.method !== "GET") return undefined;
    const workspaceId = decodeURIComponent(match[1]!);
    const id = decodeURIComponent(match[2]!);
    const alive = await codexSessionAlive(workspaceId, codexSession(workspaceId, id));
    return turboStreamResponse(turboStream("update", statusId(workspaceId, id), alive ? `Connection lost. ${retryButton()}` : "Session ended"));
  } }],
};
