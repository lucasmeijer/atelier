import { domId, escapeHtml } from "@atelier/shared";
import { terminalTabKey as workspaceTerminalTabKey } from "../shared.ts";

export function terminalTabKey(title: string): string {
  return workspaceTerminalTabKey(title);
}

export function renderTerminalPane(id: string, title: string, options: { autostart?: boolean; visible?: boolean } = {}): string {
  return `<section id="${domId("terminal_pane", id, title)}" class="tab-pane terminal-tab-pane ${options.visible ? "visible" : ""}" data-tab-pane="${escapeHtml(terminalTabKey(title))}">
    <div class="terminal-pane" data-controller="terminal-pane" data-terminal-pane-workspace-id-value="${escapeHtml(id)}" data-terminal-pane-title-value="${escapeHtml(title)}" data-terminal-pane-autostart-value="${options.autostart ? "true" : "false"}" data-terminal-title="${escapeHtml(title)}">
      <div class="observable-terminal-host" tabindex="0"></div>
    </div>
  </section>`;
}

