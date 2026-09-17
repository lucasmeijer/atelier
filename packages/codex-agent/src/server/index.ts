import { prepareCodexModelSettings, renderCodexModelSettings } from "./model-settings.ts";
import { buttonHtml } from "@atelier/design-system/button";
import { observableTerminalStaticFiles } from "@atelier/observable-terminal/server";
import { domId, escapeHtml, providerBrandIconHtml, turboStream, turboStreamResponse, type WorkspaceModule } from "@atelier/shared";
import { closeCodexSession, codexSession, codexTerminalState, createCodexSession, listCodexSessions } from "./sessions.ts";
import { requireCodexSubscription } from "./auth.ts";
import { codexSocketHandler } from "./sockets.ts";

function statusId(workspaceId: string, id: string) { return domId("codex_status", workspaceId, id); }
function retryButton() { return buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Retry connection" }, attributesHtml: 'data-action="codex-terminal#retry"' }); }

function terminalStatus(terminal: { ended: boolean; exitCode?: number }): string {
  return terminal.ended ? `Session ended${terminal.exitCode ? ` (exit ${terminal.exitCode}). See terminal output for details.` : ""}` : "";
}

export const atelierServerModule: WorkspaceModule = {
  id: "codex-agent",
  staticFiles: {
    ...observableTerminalStaticFiles,
    "/codex-agent.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  },
  initialize(context) { context.registerSocketHandler(codexSocketHandler); },
  agentProvider: {
    id: "codex", label: "Codex", iconHtml: providerBrandIconHtml("openai"),
    async create({ workspaceId }) {
      await requireCodexSubscription();
      return createCodexSession(workspaceId, undefined, await prepareCodexModelSettings());
    },
    tabs: {
      async list({ workspaceId }) { return listCodexSessions(workspaceId).map(({ id, title }) => ({ id, title })); },
      async render({ workspaceId, conversationId }) {
        const session = codexSession(workspaceId, conversationId);
        const terminal = await codexTerminalState(workspaceId, session);
        const url = `/workspaces/${encodeURIComponent(workspaceId)}/codex-agents/${encodeURIComponent(conversationId)}`;
        return `<section class="codex-agent-body" data-controller="codex-terminal" data-codex-terminal-url-value="${url}" data-action="atelier:workspace-pane-visible@window->codex-terminal#refresh atelier:theme-change@document->codex-terminal#theme">
          <div id="${statusId(workspaceId, conversationId)}" class="codex-terminal-status" role="status">${session.error ? `Could not start Codex: ${escapeHtml(session.error)}` : terminalStatus(terminal)}</div>
          ${terminal.exists ? '<div class="observable-terminal-host" data-codex-terminal-target="terminal" tabindex="0"></div>' : ""}
        </section>`;
      },
      close: ({ workspaceId, conversationId }) => closeCodexSession(workspaceId, conversationId),
    },
    launch: {
      renderFooter: renderCodexModelSettings,
      async prepare(parameters) { await requireCodexSubscription(); return { agent: await prepareCodexModelSettings(parameters) }; },
      async submit(form) {
        await requireCodexSubscription();
        const settings = await prepareCodexModelSettings({ model: String(form.get("model") ?? ""), thinkingLevel: String(form.get("level") ?? "") });
        return { async prepare() { return { agent: settings }; } };
      },
      async prepareWorkspace(workspaceId, context) {
        if (!listCodexSessions(workspaceId).length) await createCodexSession(workspaceId, context?.agent?.input, context?.agent);
      },
    },
  },
  routes: [{ async handle(request, url) {
    const match = url.pathname.match(/^\/workspaces\/([^/]+)\/codex-agents\/([^/]+)\/status$/);
    if (!match || request.method !== "GET") return undefined;
    const workspaceId = decodeURIComponent(match[1]!);
    const id = decodeURIComponent(match[2]!);
    const session = codexSession(workspaceId, id);
    const terminal = await codexTerminalState(workspaceId, session);
    const status = session.error ? `Could not start Codex: ${escapeHtml(session.error)}` : terminalStatus(terminal);
    return turboStreamResponse(turboStream("update", statusId(workspaceId, id), status || (url.searchParams.has("disconnected") ? `Connection lost. ${retryButton()}` : "")), { headers: { "X-Codex-Ended": String(terminal.ended), "Cache-Control": "no-store" } });
  } }],
};
