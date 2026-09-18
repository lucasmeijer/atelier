import { buttonHtml } from "@atelier/design-system/button";
import { observableTerminalStaticFiles } from "@atelier/observable-terminal/server";
import { escapeHtml, type WorkspaceModule } from "@atelier/shared";
import type { CliAgentAdapter } from "./adapter.ts";
import { createCliSessions } from "./sessions.ts";
import { cliSocketHandler } from "./sockets.ts";

export type { CliAgentAdapter } from "./adapter.ts";

function retryButton() { return buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Retry connection" }, attributesHtml: 'data-action="cli-terminal#retry"' }); }
function terminalStatus(terminal: { ended: boolean; exitCode?: number }): string {
  return terminal.ended ? `Session ended${terminal.exitCode ? ` (exit ${terminal.exitCode}). See terminal output for details.` : ""}` : "";
}

/** One adapter supplies CLI policy; this module owns the complete terminal-agent lifecycle. */
export function createCliAgentModule(adapter: CliAgentAdapter): WorkspaceModule {
  const sessions = createCliSessions(adapter);
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
            <div class="cli-terminal-status" role="status">${session.error ? failureStatus(session.error) : terminalStatus(terminal)}</div>
            <div class="cli-terminal-status" data-cli-terminal-target="connectionStatus" role="status" hidden>Connection lost. ${retryButton()}</div>
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
  };
}

export { createCliModelSettings, type CliModelSettings } from "./model-settings.ts";
export { cliLaunchScript } from "./launch-script.ts";
