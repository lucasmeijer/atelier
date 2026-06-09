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

export interface TerminalWorkspaceTab {
  key: string;
  tabHtml: string;
  paneHtml: string;
  footerHtml: string;
}

export function terminalTabKey(title: string): string {
  return `terminal:${title}`;
}

export function renderTerminalTab(id: string, title: string, options: { active?: boolean } = {}): string {
  return `<span id="${domId("terminal_tab", id, title)}" class="tab ${options.active ? "active" : "muted"}" data-tab="${escapeHtml(terminalTabKey(title))}" data-terminal-title="${escapeHtml(title)}" data-action="click->workspace-tabs#activate" data-workspace-tabs-tab-param="${escapeHtml(terminalTabKey(title))}" role="button" tabindex="0">▣ ${escapeHtml(title)}</span>`;
}

export function renderInitializingTerminalTab(id: string, token: string): string {
  return `<span id="${domId("terminal_tab", id, token)}" class="tab closable active" data-tab="${escapeHtml(terminalTabKey(token))}" data-terminal-title="${escapeHtml(token)}" role="button" tabindex="0">▣ Initializing… <span class="status-spinner" aria-label="Initializing terminal"></span></span>`;
}

export function renderTerminalThemeOptions(): string {
  return [
    ["tokyo-night", "Tokyo Night"],
    ["dracula", "Dracula"],
    ["catppuccin-mocha", "Catppuccin Mocha"],
    ["nord", "Nord"],
  ].map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
}

export function renderTerminalPane(id: string, title: string, options: { autostart?: boolean; active?: boolean } = {}): string {
  return `<section id="${domId("terminal_pane", id, title)}" class="tab-pane ${options.active ? "active" : ""}" data-tab-pane="${escapeHtml(terminalTabKey(title))}">
    <div class="terminal-pane" data-controller="terminal-pane" data-terminal-pane-workspace-id-value="${escapeHtml(id)}" data-terminal-pane-title-value="${escapeHtml(title)}" data-terminal-pane-autostart-value="${options.autostart ? "true" : "false"}" data-terminal-title="${escapeHtml(title)}">
      <div class="terminal-bar"><span>${escapeHtml(title)} · tmux</span><label class="terminal-theme-picker">Theme <select data-controller="terminal-theme" data-terminal-theme-select data-action="change->terminal-theme#change">${renderTerminalThemeOptions()}</select></label></div>
      <div class="ghostty-terminal" tabindex="0"></div>
    </div>
  </section>`;
}

export function renderTerminalFooterAction(id: string, title: string, options: { active?: boolean } = {}): string {
  return `<section id="${domId("terminal_footer", id, title)}" class="tab-pane ${options.active ? "active" : ""}" data-tab-pane="${escapeHtml(terminalTabKey(title))}">
    <form method="post" action="/workspaces/${encodeURIComponent(id)}/terminals/${encodeURIComponent(title)}/delete"><button class="btn danger sm" type="submit">Delete terminal</button></form>
  </section>`;
}

export function renderInitializingTerminalPane(id: string, token: string): string {
  return `<section id="${domId("terminal_pane", id, token)}" class="tab-pane active" data-tab-pane="${escapeHtml(terminalTabKey(token))}"><div class="terminal-pane terminal-initializing"><div class="terminal-bar">Initializing terminal…</div><div class="terminal-loading"><span class="status-spinner" aria-label="Initializing terminal"></span><span>Starting tmux session…</span></div></div></section>`;
}

export function renderInitializingTerminalFooterAction(id: string, token: string): string {
  return `<section id="${domId("terminal_footer", id, token)}" class="tab-pane active" data-tab-pane="${escapeHtml(terminalTabKey(token))}"><span class="terminal-footer-muted">Terminal actions available when ready…</span></section>`;
}
