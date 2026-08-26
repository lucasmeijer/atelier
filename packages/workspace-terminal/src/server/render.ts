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
    `<button type="button" class="terminal-accessory-key" aria-label="${ariaLabel}"${key === "control" ? ' aria-pressed="false"' : ""} data-terminal-key="${key}" data-action="pointerdown->terminal-pane#preserveTerminalFocus click->terminal-pane#sendAccessoryKey">${label}</button>`
  ).join("");
  return `<div class="terminal-accessory-bar" role="toolbar" aria-label="Terminal keys">${buttons}</div>`;
}

export function renderTerminalPane(workspaceId: string, terminal: WorkspaceTerminal): string {
  return `<section id="${domId("terminal_pane", workspaceId, terminal.id)}" class="terminal-work-view" data-work-view-source="${escapeHtml(terminalViewKey(terminal.id))}">
    <div class="terminal-pane" data-controller="terminal-pane" data-terminal-pane-workspace-id-value="${escapeHtml(workspaceId)}" data-terminal-pane-id-value="${escapeHtml(terminal.id)}" data-terminal-id="${escapeHtml(terminal.id)}">
      <div class="observable-terminal-host" tabindex="0"></div>
      ${renderTerminalAccessoryBar()}
    </div>
  </section>`;
}
