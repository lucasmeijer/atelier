import { registerWorkspacePresenter, type WorkspacePresenterDeps } from "@atelier/agent/server";
import { domId, escapeHtml, turboStream, type WorkspaceCommandContribution, type WorkspaceModule, type WorkspaceTabContribution } from "@atelier/shared";
import { terminalIdFromTabKey, terminalTabKey } from "../shared.ts";
import { createTmuxPresenter } from "./agent-tool.ts";
import { renderTerminalPane } from "./render.ts";
import { createTerminalSocketHandler } from "./sockets.ts";
import { terminalStaticFiles } from "./static.ts";
import { attachWorkspaceTerminal, createWorkspaceTerminal, deleteWorkspaceTerminal, listTmuxSessions, listWorkspaceTerminals, type WorkspaceTerminal } from "./workspace-terminals.ts";
import { Type } from "typebox";

function renderWorkspaceTerminalTabs(workspaceId: string, terminals: WorkspaceTerminal[]): WorkspaceTabContribution[] {
  return terminals.map((terminal) => ({
    key: terminalTabKey(terminal.id),
    label: terminal.title,
    paneHtml: renderTerminalPane(workspaceId, terminal),
    workView: { reference: { type: "terminal", terminalId: terminal.id }, kind: "resource", availability: { phase: "live" } },
  }));
}

function parseTerminalReference(value: unknown): { type: "terminal"; terminalId: string } {
  const reference = value as { type?: unknown; terminalId?: unknown };
  if (reference?.type !== "terminal" || typeof reference.terminalId !== "string" || !reference.terminalId) throw new Error("terminalId is required");
  return { type: "terminal", terminalId: reference.terminalId };
}

const terminalWorkspaceCommands: WorkspaceCommandContribution[] = [
  {
    id: "terminal.create",
    label: "New Terminal",
    scope: "workspace",
    surfaces: { ui: { placement: "group-menu" }, shortcut: { defaultBinding: "Meta+Alt+KeyT" } },
  },
  {
    id: "terminal.attach",
    label: "Attach Terminal",
    description: "Open a terminal tab attached to an existing tmux session",
    scope: "workspace",
    surfaces: { ui: { placement: "group-menu" } },
  },
];

function relativeAge(timestamp: number): string {
  const seconds = Math.max(0, Math.round(Date.now() / 1000 - timestamp));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function attachDialogId(workspaceId: string): string {
  return domId("attach_terminal_dialog", workspaceId);
}

async function renderAttachDialog(workspaceId: string): Promise<string> {
  const [sessions, terminals] = await Promise.all([listTmuxSessions(workspaceId), listWorkspaceTerminals(workspaceId)]);
  const openCounts = new Map<string, number>();
  for (const terminal of terminals) openCounts.set(terminal.tmuxSession, (openCounts.get(terminal.tmuxSession) ?? 0) + 1);

  const rows = sessions.map((session) => {
    const openCount = openCounts.get(session.name) ?? 0;
    return `<label class="terminal-session-option">
      <input type="radio" name="session" value="${escapeHtml(session.name)}" required>
      <span class="terminal-session-main"><b>${escapeHtml(session.name)}</b><small><code>${escapeHtml(session.command)}</code> in <span title="${escapeHtml(session.cwd)}">${escapeHtml(session.cwd)}</span></small></span>
      <span class="terminal-session-meta"><span>${session.windows} ${session.windows === 1 ? "window" : "windows"}</span><span>${session.width}×${session.height}</span><span title="Created ${relativeAge(session.createdAt)}">active ${relativeAge(session.lastActivityAt)}</span>${session.attachedClients ? `<span>${session.attachedClients} tmux ${session.attachedClients === 1 ? "client" : "clients"}</span>` : ""}${openCount ? `<strong>${openCount} open ${openCount === 1 ? "terminal" : "terminals"}</strong>` : ""}${session.dead ? `<strong class="terminal-session-dead">exited</strong>` : ""}</span>
    </label>`;
  }).join("");

  return `<dialog id="${attachDialogId(workspaceId)}" class="modal terminal-attach-dialog" data-controller="modal" data-modal-auto-show-value="true">
    <form method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/terminals/attach" data-turbo="true">
      <header><h2>Attach terminal</h2><p>Choose an existing tmux session. Multiple terminal tabs can attach to the same session.</p></header>
      <div class="terminal-session-list">${rows || `<div class="terminal-session-empty">No tmux sessions are running yet.</div>`}</div>
      <div class="modal-actions"><button class="btn" type="button" data-action="modal#close">Cancel</button><button class="btn primary" type="submit"${rows ? "" : " disabled"}>Attach</button></div>
    </form>
  </dialog>`;
}

export const terminalWorkspaceModule: WorkspaceModule = {
  id: "terminal",
  workViews: [{
    type: "terminal",
    parseReference: parseTerminalReference,
    identity: (reference: { type: "terminal"; terminalId: string }) => reference.terminalId,
    close: async ({ workspaceId, reference }: { workspaceId: string; reference: { type: "terminal"; terminalId: string } }) => await deleteWorkspaceTerminal(workspaceId, reference.terminalId),
  }],
  staticFiles: terminalStaticFiles,
  initialize(context) {
    context.registerSocketHandler(createTerminalSocketHandler({
      setTabBusy: (workspaceId, tabKey, busy) => context.registry.setTabBusy(workspaceId, tabKey, busy),
    }));
    registerWorkspacePresenter("tmux", (workspaceId, options) => createTmuxPresenter(workspaceId, {
      events: options.events,
      getTabKeys: () => context.getTabKeys(workspaceId),
      layouts: context.layouts as WorkspacePresenterDeps["layouts"],
    }));
  },
  commands: [
    {
      id: "terminal.create",
      inputSchema: Type.Object({
        title: Type.Optional(Type.String()),
        command: Type.Optional(Type.String()),
        cwd: Type.Optional(Type.String()),
      }),
      async execute({ workspaceId, input }) {
        const options = input as { title?: string; command?: string; cwd?: string };
        const terminal = await createWorkspaceTerminal(workspaceId, options);
        return { createdTabKey: terminalTabKey(terminal.id) };
      },
    },
    {
      id: "terminal.attach",
      async execute({ workspaceId }) {
        const dialogId = attachDialogId(workspaceId);
        return { streamHtml: `${turboStream("remove", dialogId)}${turboStream("append", domId("workspace_groups", workspaceId), await renderAttachDialog(workspaceId))}` };
      },
    },
  ],
  routes: [{
    async handle(request, url, context) {
      const match = url.pathname.match(/^\/workspaces\/([^/]+)\/terminals\/attach$/);
      if (!match || request.method !== "POST") return undefined;
      const workspaceId = decodeURIComponent(match[1]!);
      const session = String((await request.formData()).get("session") ?? "");
      const terminal = await attachWorkspaceTerminal(workspaceId, session);
      return context.openTab(workspaceId, terminalTabKey(terminal.id));
    },
  }],
  tabs: [{
    owns: (tabKey) => terminalIdFromTabKey(tabKey) !== undefined,
    async close({ workspaceId, tabKey }) { await deleteWorkspaceTerminal(workspaceId, terminalIdFromTabKey(tabKey)!); },
  }],
  async attachToWorkspace({ workspaceId }) {
    const terminals = await listWorkspaceTerminals(workspaceId);
    return { tabs: renderWorkspaceTerminalTabs(workspaceId, terminals), commands: terminalWorkspaceCommands };
  },
};
