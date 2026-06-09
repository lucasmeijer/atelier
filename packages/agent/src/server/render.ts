import type { WorkspaceAgentInfo } from "./session-store.ts";

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

export function agentTabKey(label: string): string {
  return `agent:${label}`;
}

export function renderAgentTab(workspaceId: string, agent: WorkspaceAgentInfo, options: { active?: boolean } = {}): string {
  const key = agentTabKey(agent.label);
  return `<span id="${domId("agent_tab", workspaceId, agent.label)}" class="tab ${options.active ? "active" : "muted"}" data-tab="${escapeHtml(key)}" data-agent-label="${escapeHtml(agent.label)}" data-action="click->workspace-tabs#activate" data-workspace-tabs-tab-param="${escapeHtml(key)}" role="button" tabindex="0">◈ ${escapeHtml(agent.label)}</span>`;
}

export function renderAgentPane(workspaceId: string, agent: WorkspaceAgentInfo, options: { active?: boolean; autostart?: boolean } = {}): string {
  const key = agentTabKey(agent.label);
  const transcriptId = agentTranscriptId(workspaceId, agent.label);
  return `<section id="${domId("agent_pane", workspaceId, agent.label)}" class="tab-pane ${options.active ? "active" : ""}" data-tab-pane="${escapeHtml(key)}">
    <div class="workspace-wide agent-pane" data-controller="agent-chat" data-agent-chat-workspace-id-value="${escapeHtml(workspaceId)}" data-agent-chat-label-value="${escapeHtml(agent.label)}" data-agent-chat-autostart-value="${options.autostart || options.active ? "true" : "false"}">
      <div id="${transcriptId}" class="chat agent-transcript" data-agent-chat-target="transcript">${renderAgentTranscript([])}</div>
      <form class="composer" data-action="submit->agent-chat#submit">
        <textarea data-agent-chat-target="input" placeholder="Reply to ${escapeHtml(agent.label)}…"></textarea>
        <div class="row2"><span class="dropdown">Atelier agent</span><span class="spacer"></span><button class="btn primary sm" data-agent-chat-target="submitButton" type="submit">Send</button></div>
      </form>
    </div>
  </section>`;
}

export function agentTranscriptId(workspaceId: string, label: string): string {
  return domId("agent_transcript", workspaceId, label);
}

export function agentTurnId(workspaceId: string, label: string, turnId: string): string {
  return domId("agent_turn", workspaceId, label, turnId);
}

export function agentTextId(workspaceId: string, label: string, turnId: string): string {
  return domId("agent_text", workspaceId, label, turnId);
}

export function agentActivityId(workspaceId: string, label: string, turnId: string): string {
  return domId("agent_activity", workspaceId, label, turnId);
}

export function agentActivitySummaryId(workspaceId: string, label: string, turnId: string): string {
  return domId("agent_activity_summary", workspaceId, label, turnId);
}

export function agentActivityEventsId(workspaceId: string, label: string, turnId: string): string {
  return domId("agent_activity_events", workspaceId, label, turnId);
}

export function renderAgentTranscript(turns: string[]): string {
  return turns.join("") || `<div class="msg agent agent-empty"><div class="bubble"><p>This agent operates in the workspace container with cwd <code>/repos</code>.</p></div></div>`;
}

export function renderTurnGroupShell(workspaceId: string, label: string, turnId: string, userText: string, assistantText = ""): string {
  return `<div id="${agentTurnId(workspaceId, label, turnId)}" class="turn-group">
    ${renderUserMessage(userText)}
    ${renderActivityFold(workspaceId, label, turnId)}
    ${renderAssistantMessageShell(workspaceId, label, turnId, assistantText)}
  </div>`;
}

export function renderUserMessage(text: string): string {
  return `<div class="msg user"><div class="bubble"><p>${escapeHtml(text)}</p></div></div>`;
}

export function renderAssistantMessageShell(workspaceId: string, label: string, turnId: string, text = ""): string {
  return `<div class="msg agent"><div class="bubble">${renderAssistantTextContainer(workspaceId, label, turnId, text)}</div></div>`;
}

export function renderAssistantTextContainer(workspaceId: string, label: string, turnId: string, text = ""): string {
  return `<div id="${agentTextId(workspaceId, label, turnId)}" class="agent-text">${escapeHtml(text)}</div>`;
}

export function renderActivityFold(workspaceId: string, label: string, turnId: string, summary = "internal activity"): string {
  return `<details id="${agentActivityId(workspaceId, label, turnId)}" class="activity-fold"><summary id="${agentActivitySummaryId(workspaceId, label, turnId)}">${renderActivitySummary(summary)}</summary><div id="${agentActivityEventsId(workspaceId, label, turnId)}" class="hidden-events"></div></details>`;
}

export function renderActivitySummary(summary: string): string {
  return `<span class="activity-dots"><i></i><i></i><i></i></span><span>${escapeHtml(summary)}</span>`;
}

export function renderThinkingEntry(id: string): string {
  return `<div class="msg thinking"><div class="bubble"><div id="${escapeHtml(id)}" class="agent-thinking-text"></div></div></div>`;
}

export function renderToolCallEntry(id: string, name: string, status = "running"): string {
  return `<div id="${escapeHtml(id)}" class="msg toolcall"><div class="bubble"><span>tool</span><code>${escapeHtml(name)}</code><span class="tool-result">${escapeHtml(status)}</span></div></div>`;
}

export function renderToolResultSummary(name: string, status: string): string {
  return `<div class="bubble"><span>tool</span><code>${escapeHtml(name)}</code><span class="tool-result">${escapeHtml(status)}</span></div>`;
}

export function renderNotice(level: "info" | "error", message: string): string {
  return `<div class="agent-notice ${escapeHtml(level)}">${escapeHtml(message)}</div>`;
}
