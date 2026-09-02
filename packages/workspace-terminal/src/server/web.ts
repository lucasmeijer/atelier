import { registerWorkspacePresenter } from "@atelier/agent/server";
import type { JsonValue } from "@atelier/core";
import { actionItemHtml } from "@atelier/design-system/action-item";
import { buttonHtml } from "@atelier/design-system/button";
import { dialogHtml } from "@atelier/design-system/dialog";
import { Icons } from "@atelier/design-system/icons";
import { domId, escapeHtml, turboStream, type WorkspaceCommandContribution, type WorkspaceModule, type WorkspaceWorkViewPresentation, type WorkspaceWorkViewReference } from "@atelier/shared";
import { terminalViewKey } from "../shared.ts";
import { createTmuxPresenter } from "./agent-tool.ts";
import { renderTerminalPane } from "./render.ts";
import { createTerminalSocketHandler } from "./sockets.ts";
import { terminalStaticFiles } from "./static.ts";
import { attachWorkspaceTerminal, createWorkspaceTerminal, deleteWorkspaceTerminal, listTmuxSessions, listWorkspaceTerminals, type WorkspaceTerminal } from "./workspace-terminals.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

function terminalWorkViewPresentation(terminal: WorkspaceTerminal): WorkspaceWorkViewPresentation {
  return {
    sourceKey: terminalViewKey(terminal.id),
    label: terminal.title,
    reference: { type: "terminal", terminalId: terminal.id },
    kind: "resource",
    availability: { phase: "live" },
  };
}

const terminalWorkViewReferenceSchema = Type.Object({
  type: Type.Literal("terminal"),
  terminalId: Type.String({ minLength: 1 }),
});

type TerminalWorkViewReference = Static<typeof terminalWorkViewReferenceSchema> & WorkspaceWorkViewReference;

function parseTerminalReference(value: JsonValue): TerminalWorkViewReference {
  if (!Value.Check(terminalWorkViewReferenceSchema, value)) throw new Error("terminalId is required");
  return { type: "terminal", terminalId: value.terminalId };
}

const terminalWorkspaceCommands: WorkspaceCommandContribution[] = [
  {
    id: "terminal.create",
    label: "New Terminal",
    scope: "workspace",
    surfaces: { ui: { placement: "work-launcher", label: "New Terminal" }, shortcut: { defaultBinding: "Meta+Alt+KeyT" } },
  },
  {
    id: "terminal.attach",
    label: "Attach Terminal",
    description: "Open a Terminal view attached to an existing tmux session",
    scope: "workspace",
    surfaces: { ui: { placement: "work-launcher" } },
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
  const sessions = await listTmuxSessions(workspaceId);
  const rows = sessions.map((session, index) => actionItemHtml({
    kind: "single",
    element: {
      tag: "button",
      attributesHtml: `type="button" role="option" aria-selected="${index === 0}" data-action="terminal-session-picker#select focus->terminal-session-picker#select" data-terminal-session-picker-target="item" data-linear-navigation-target="item" data-terminal-session="${escapeHtml(session.name)}"`,
    },
    label: {
      kind: "html",
      html: `<span class="terminal-session-name">${escapeHtml(session.name)}</span><span class="terminal-session-separator">·</span><span class="terminal-session-process">${escapeHtml(session.command)}</span>`,
    },
    trailingHtml: `<span class="terminal-session-activity" title="Created ${relativeAge(session.createdAt)}">active ${relativeAge(session.lastActivityAt)}</span>`,
  })).join("");

  const formId = domId("attach_terminal_form", workspaceId);
  const bodyHtml = `<form id="${formId}" method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/terminals/attach" data-turbo="true" data-controller="terminal-session-picker action-items" data-action="turbo:submit-end->dialog#submitted">
    ${sessions[0] ? `<input type="hidden" name="session" value="${escapeHtml(sessions[0].name)}" data-terminal-session-picker-target="input">` : ""}
    <div class="terminal-session-list action-list" role="listbox" aria-label="Tmux sessions" data-controller="linear-navigation">${rows || `<div class="terminal-session-empty empty-state">No tmux sessions are running yet.</div>`}</div>
  </form>`;
  const cancelButton = buttonHtml({
    type: "submit",
    variant: "secondary",
    content: { kind: "caption", caption: "Cancel" },
  });
  const attachButton = buttonHtml({
    type: "submit",
    variant: "primary",
    content: { kind: "caption", caption: "Attach" },
    disabled: sessions.length === 0,
    attributesHtml: `form="${formId}"`,
  });
  const footerHtml = `<form method="dialog">${cancelButton}</form>${attachButton}`;
  return dialogHtml({
    element: {
      id: attachDialogId(workspaceId),
      attributesHtml: 'aria-label="Attach terminal" data-dialog-auto-show',
    },
    iconHtml: Icons.Terminal,
    titleCaption: "Attach terminal",
    bodyHtml,
    bodyLayout: "full-bleed",
    footerHtml,
    closeLabel: "Close attach terminal dialog",
  });
}

export const terminalWorkspaceModule: WorkspaceModule = {
  id: "terminal",
  workViews: [{
    type: "terminal",
    parseReference: parseTerminalReference,
    identity: (reference: { type: "terminal"; terminalId: string }) => reference.terminalId,
    render: async ({ workspaceId, reference }: { workspaceId: string; reference: TerminalWorkViewReference }) => {
      const terminal = (await listWorkspaceTerminals(workspaceId)).find((candidate) => candidate.id === reference.terminalId);
      if (!terminal) throw new Error(`Terminal Work view not found: ${reference.terminalId}`);
      return renderTerminalPane(workspaceId, terminal);
    },
    close: ({ workspaceId, reference }: { workspaceId: string; reference: { type: "terminal"; terminalId: string } }) => deleteWorkspaceTerminal(workspaceId, reference.terminalId),
  }],
  staticFiles: terminalStaticFiles,
  initialize(context) {
    context.registerSocketHandler(createTerminalSocketHandler({
      setViewBusy: (workspaceId, viewKey, busy) => context.registry.setViewBusy(workspaceId, viewKey, busy),
    }));
    registerWorkspacePresenter("tmux", (workspaceId, options) => createTmuxPresenter(workspaceId, {
      events: options.events,
      presentWorkView: (reference) => context.presentWorkView(workspaceId, reference),
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
        // SAFETY: The module boundary validates or constructs this value with the asserted domain shape.
        const options = input as { title?: string; command?: string; cwd?: string };
        const terminal = await createWorkspaceTerminal(workspaceId, options);
        return { createdWorkView: { type: "terminal", terminalId: terminal.id } };
      },
    },
    {
      id: "terminal.attach",
      async execute({ workspaceId }) {
        const dialogId = attachDialogId(workspaceId);
        return { streamHtml: `${turboStream("remove", dialogId)}${turboStream("append", "workspace_command_modal_host", await renderAttachDialog(workspaceId))}` };
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
      return context.openWorkView(workspaceId, { type: "terminal", terminalId: terminal.id });
    },
  }],
  async attachToWorkspace({ workspaceId }) {
    const terminals = await listWorkspaceTerminals(workspaceId);
    return { workViews: terminals.map(terminalWorkViewPresentation), commands: terminalWorkspaceCommands };
  },
};
