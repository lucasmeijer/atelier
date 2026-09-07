import { buttonHtml } from "@atelier/design-system/button";
import { domId, escapeHtml } from "@atelier/shared";
import { terminalViewKey } from "../shared.ts";
import type { WorkspaceTerminal } from "./workspace-terminals.ts";

const terminalAccessoryButtons = [
  { key: "control", label: "Ctrl", ariaLabel: "Control modifier" },
  { key: "escape", label: "Esc", ariaLabel: "Escape" },
  { key: "left", label: "←", ariaLabel: "Left arrow" },
  { key: "up", label: "↑", ariaLabel: "Up arrow" },
  { key: "down", label: "↓", ariaLabel: "Down arrow" },
  { key: "right", label: "→", ariaLabel: "Right arrow" },
] as const;

function renderTerminalAccessoryBar(): string {
  const buttons = terminalAccessoryButtons.map(({ key, label, ariaLabel }) =>
    buttonHtml({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: escapeHtml(label), label: ariaLabel }, attributesHtml: `${key === "control" ? 'aria-pressed="false" ' : ""}data-terminal-key="${key}" data-action="pointerdown->terminal-pane#preserveTerminalFocus click->terminal-pane#sendAccessoryKey"` })
  ).join("");
  return `<div class="terminal-accessory-bar" role="toolbar" aria-label="Terminal keys">${buttons}</div>`;
}

export function renderTerminalPane(workspaceId: string, terminal: WorkspaceTerminal): string {
  return `<section id="${domId("terminal_pane", workspaceId, terminal.id)}" class="terminal-work-view" data-work-view-source="${escapeHtml(terminalViewKey(terminal.id))}">
    <div class="terminal-pane" data-controller="terminal-pane" data-terminal-pane-workspace-id-value="${escapeHtml(workspaceId)}" data-terminal-pane-id-value="${escapeHtml(terminal.id)}" data-terminal-id="${escapeHtml(terminal.id)}">
      <div class="observable-terminal-host" tabindex="0">
        <div class="terminal-loading" role="status" aria-label="Loading terminal"><span class="activity-spinner" aria-hidden="true"></span></div>
      </div>
      ${renderTerminalAccessoryBar()}
    </div>
  </section>`;
}
