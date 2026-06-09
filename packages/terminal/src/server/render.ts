export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function domId(...parts: string[]): string {
  return parts.join("_").replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function terminalTabKey(title: string): string {
  return `terminal:${title}`;
}

export function renderTerminalPane(id: string, title: string, options: { autostart?: boolean; active?: boolean } = {}): string {
  return `<section id="${domId("terminal_pane", id, title)}" class="tab-pane terminal-tab-pane ${options.active ? "active" : ""}" data-tab-pane="${escapeHtml(terminalTabKey(title))}">
    <div class="terminal-pane" data-controller="terminal-pane" data-terminal-pane-workspace-id-value="${escapeHtml(id)}" data-terminal-pane-title-value="${escapeHtml(title)}" data-terminal-pane-autostart-value="${options.autostart ? "true" : "false"}" data-terminal-title="${escapeHtml(title)}">
      <div class="xterm-terminal" tabindex="0"></div>
    </div>
  </section>`;
}

