import { domId, escapeHtml } from "@atelier/shared";
import { terminalViewKey } from "../shared.ts";
import type { WorkspaceTerminal } from "./workspace-terminals.ts";

export function renderTerminalPane(workspaceId: string, terminal: WorkspaceTerminal): string {
  return `<section id="${domId("terminal_pane", workspaceId, terminal.id)}" class="terminal-work-view" data-work-view-source="${escapeHtml(terminalViewKey(terminal.id))}">
    <div class="terminal-pane" data-controller="terminal-pane" data-terminal-pane-workspace-id-value="${escapeHtml(workspaceId)}" data-terminal-pane-id-value="${escapeHtml(terminal.id)}" data-terminal-id="${escapeHtml(terminal.id)}">
      <div class="observable-terminal-host" tabindex="0"></div>
    </div>
  </section>`;
}
