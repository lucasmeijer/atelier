import { buttonHtml } from "@atelier/design-system/button";
import { observableTerminalStaticFiles } from "@atelier/observable-terminal/server";
import { domId, escapeHtml, turboStream, turboStreamResponse, type WorkspaceModule } from "@atelier/shared";
import type { CliAgentAdapter } from "./adapter.ts";
import { createCliSessions } from "./sessions.ts";
import { cliSocketHandler } from "./sockets.ts";

export type { CliAgentAdapter } from "./adapter.ts";

function retryButton() { return buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Retry connection" }, attributesHtml: 'data-action="cli-terminal#retry"' }); }
function terminalStatus(terminal: { starting?: boolean; ended: boolean; exitCode?: number }): string {
  if (terminal.starting) return "Starting session…";
  return terminal.ended ? `Session ended${terminal.exitCode ? ` (exit ${terminal.exitCode}). See terminal output for details.` : ""}` : "";
}

/** One adapter supplies CLI policy; this module owns the complete terminal-agent lifecycle. */
export function createCliAgentModule(adapter: CliAgentAdapter): WorkspaceModule {
  const sessions = createCliSessions(adapter);
  function statusId(workspaceId: string, id: string) { return domId(`${adapter.id}_status`, workspaceId, id); }
  function failureStatus(error: string) { return `Could not start ${escapeHtml(adapter.label)}: ${escapeHtml(error)}`; }
  return {
    id: `${adapter.id}-agent`,
    staticFiles: {
      ...observableTerminalStaticFiles,
      "/cli-agent.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
    },
    initialize(context) { context.registerSocketHandler(cliSocketHandler(adapter.id, sessions)); },
    agentProvider: {
      id: adapter.id, label: adapter.label, iconHtml: adapter.iconHtml,
      async create({ workspaceId }) {
        await adapter.requireSetup();
        return sessions.create(workspaceId, await adapter.settings.prepare());
      },
      tabs: {
        async list({ workspaceId }) { return sessions.list(workspaceId).map(({ id, title }) => ({ id, title })); },
        async render({ workspaceId, conversationId }) {
          const session = await sessions.ready(workspaceId, conversationId);
          const terminal = await sessions.terminalState(workspaceId, session);
          const url = `/workspaces/${encodeURIComponent(workspaceId)}/${adapter.id}-agents/${encodeURIComponent(conversationId)}`;
          return `<section class="cli-agent-body" data-controller="cli-terminal" data-cli-terminal-url-value="${escapeHtml(url)}" data-action="atelier:workspace-pane-visible@window->cli-terminal#refresh atelier:theme-change@document->cli-terminal#theme">
            <div id="${statusId(workspaceId, conversationId)}" class="cli-terminal-status" role="status">${session.error ? failureStatus(session.error) : terminalStatus(terminal)}</div>
            ${terminal.exists ? '<div class="observable-terminal-host" data-cli-terminal-target="terminal" tabindex="0"></div>' : ""}
          </section>`;
        },
        close: ({ workspaceId, conversationId }) => sessions.close(workspaceId, conversationId),
      },
      launch: {
        renderFooter: adapter.settings.renderFooter,
        async prepare(parameters) { await adapter.requireSetup(); return { agent: await adapter.settings.prepare(parameters) }; },
        async submit(form) {
          await adapter.requireSetup();
          const settings = await adapter.settings.prepare({ model: String(form.get("model") ?? ""), thinkingLevel: String(form.get("level") ?? "") });
          return { async prepare() { return { agent: settings }; } };
        },
        prepareWorkspace: (workspaceId, context) => sessions.prepareWorkspace(workspaceId, context?.agent),
      },
    },
    routes: [{ async handle(request, url) {
      const match = url.pathname.match(/^\/workspaces\/([^/]+)\/([^/]+)\/([^/]+)\/status$/);
      if (!match || match[2] !== `${adapter.id}-agents` || request.method !== "GET") return undefined;
      const workspaceId = decodeURIComponent(match[1]!);
      const id = decodeURIComponent(match[3]!);
      const session = sessions.get(workspaceId, id);
      const terminal = await sessions.terminalState(workspaceId, session);
      const status = session.error ? failureStatus(session.error) : terminalStatus(terminal);
      return turboStreamResponse(turboStream("update", statusId(workspaceId, id), status || (url.searchParams.has("disconnected") ? `Connection lost. ${retryButton()}` : "")), { headers: { "X-CLI-Agent-Ended": String(terminal.ended), "Cache-Control": "no-store" } });
    } }],
  };
}

export { createCliModelSettings, type CliModelSettings } from "./model-settings.ts";
export { cliLaunchScript } from "./launch-script.ts";
