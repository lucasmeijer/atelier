import { activityButtonHtml } from "@atelier/design-system/activity-button";
import { buttonHtml } from "@atelier/design-system/button";
import { createPiModelRuntime, hasConnectedModelProvider, modelRefValue, parseModelRef, renderLaunchModelSettings, renderSharedComposerSelections, type ComposerModelOption } from "@atelier/llm/server";
import { agentAttachmentDraftId, listStagedAttachments, renderAttachmentChip, renderAttachmentPicker, type StagedAttachment } from "@atelier/prompt/server";
import { renderTranscriptionComposerControl, transcriptionComposerController } from "@atelier/transcription/server";
import { domId, escapeHtml } from "./html.ts";
import { readInitialPromptDraft } from "./initial-prompt-draft.ts";
import { configuredModelOptionViews, launchComposerThinkingSettings, selectAvailableConfiguredModel } from "./model-state.ts";
import { agentConversationKey, agentPath, ids, type AgentRenderContext } from "./render-context.ts";
import { renderAgentNotifications } from "./render-notification.ts";
import type { WorkspaceAgentConversationInfo } from "./session-store.ts";
import { formatCost, formatTokens } from "./transcript.ts";

export interface AgentStatsView {
  contextPercent: number | null;
  compactAvailable: boolean;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  descendantCost?: number;
  isSubagent?: boolean;
  modelName: string | undefined;
  thinkingLevel: string;
  thinkingLevels: string[];
  models: ComposerModelOption[];
  connectedProvider?: boolean;
}

export interface AgentPaneState {
  transcriptHtml: string;
  busy: boolean;
  stats: AgentStatsView;
}

const agentAttachmentDropAction = "dragover->agent-attachments#dragOver dragleave->agent-attachments#dragLeave drop->agent-attachments#drop";

function agentAttachmentDropAttrs(uploadUrl: string): string {
  return `data-agent-attachments-upload-url-value="${escapeHtml(uploadUrl)}" data-action="${agentAttachmentDropAction}"`;
}

export async function renderAgentPane(ctx: AgentRenderContext, agent: WorkspaceAgentConversationInfo, state: AgentPaneState, completionCatalogHtml = ""): Promise<string> {
  const key = agentConversationKey(agent.conversationId);
  const draftId = agentAttachmentDraftId(ctx.workspaceId, ctx.conversationId);
  const attachments = await listStagedAttachments(draftId);
  const initialPromptDraft = await readInitialPromptDraft(ctx.workspaceId, ctx.conversationId);
  const initialText = initialPromptDraft?.prompt;
  const attachRowId = ids.attachRow(ctx);
  const uploadUrl = `/agent-attachment-drafts/${encodeURIComponent(draftId)}/attachments?row=${encodeURIComponent(attachRowId)}`;
  return `<section id="${domId("agent_pane", ctx.workspaceId, agent.conversationId)}" data-turbo-permanent class="agent-conversation-pane" data-agent-conversation-source="${escapeHtml(key)}">
    <div class="agent-pane" id="${ids.pane(ctx)}"
      data-controller="agent-pane agent-attachments"
      data-agent-pane-workspace-id-value="${escapeHtml(ctx.workspaceId)}"
      data-agent-pane-conversation-id-value="${escapeHtml(ctx.conversationId)}"
      ${agentAttachmentDropAttrs(uploadUrl)}>
      <div class="agent-body-controls">${renderAgentNotifications(ctx)}</div>
      <div class="agent-transcript" tabindex="0" role="region" aria-label="Agent transcript" data-agent-pane-target="transcript">
        <div class="agent-transcript-surface"><div class="agent-transcript-content" id="${ids.transcript(ctx)}" data-agent-pane-target="transcriptContent">${state.transcriptHtml}</div></div>
      </div>
      ${renderAgentPaneComposer({
        ctx,
        action: agentPath(ctx, "/messages"),
        draftId,
        attachments,
        initialText,
        busy: state.busy,
        stats: state.stats,
        completionCatalogHtml,
      })}
    </div>
  </section>`;
}

export function renderAgentPanePromptInput(ctx: AgentRenderContext, initialText = ""): string {
  const placeholder = "Write your prompt here";
  return `<textarea id="${ids.input(ctx)}" class="composer-input" name="text" rows="2" enterkeyhint="send" placeholder="${escapeHtml(placeholder)}" aria-label="${escapeHtml(placeholder)}" data-agent-pane-target="input" data-agent-completions-target="input" data-action="paste->agent-attachments#paste input->agent-completions#input input->agent-pane#promptChanged">${escapeHtml(initialText)}</textarea>`;
}

interface AgentComposerRenderOptions {
  ctx: AgentRenderContext;
  action: string;
  draftId: string;
  attachments: readonly StagedAttachment[];
  initialText?: string;
  busy: boolean;
  stats: AgentStatsView;
  completionCatalogHtml: string;
}

function renderAgentCompletionCatalog(ctx: AgentRenderContext, catalog: string): string {
  return `<div id="${ids.completionCatalog(ctx)}" data-agent-completions-target="catalog" hidden>${catalog}</div>`;
}

function renderAgentPaneComposer(options: AgentComposerRenderOptions): string {
  const { ctx, draftId, stats } = options;
  const formId = `agent_pane_composer_${draftId}`;
  const actions = `<span class="composer-primary-action" id="${ids.actions(ctx)}">${renderPromptActions(ctx, options.busy)}</span>`;
  return `<div class="composer agent-pane-composer" data-controller="composer-focus agent-model-setup agent-completions ${transcriptionComposerController}" data-action="mousedown->composer-focus#preserveInputFocus" data-agent-completions-url-value="${escapeHtml(agentPath(ctx, "/completions"))}">
        <div class="agent-pane-composer-overlays">${renderTranscriptEndNavigation()}</div>
        <div class="composer-surface">
          <form id="${escapeHtml(formId)}" method="post" action="${escapeHtml(options.action)}" data-agent-pane-target="form" data-action="submit->agent-model-setup#guard keydown->agent-completions#keydown keydown->agent-pane#inputKeydown submit->transcription-composer#submit turbo:submit-end->agent-pane#submitted click->agent-pane#focusInput">
            <input type="hidden" name="attachmentDraft" value="${escapeHtml(draftId)}">
            <div class="agent-attach-row" id="${ids.attachRow(ctx)}" data-agent-attachments-target="row">${options.attachments.map((attachment) => renderAttachmentChip(attachment, draftId)).join("")}</div>
            <div class="composer-input-area">
              ${renderAgentPanePromptInput(ctx, options.initialText ?? "")}
              ${renderTranscriptionComposerControl()}
            </div>
            ${renderComposerActions(actions)}
          </form>
          <div class="agent-completion-menu-host" data-agent-completions-target="menu" hidden></div>
          ${renderAgentCompletionCatalog(ctx, options.completionCatalogHtml)}
          <form id="${ids.abortForm(ctx)}" method="post" action="${escapeHtml(agentPath(ctx, "/abort"))}" hidden></form>
          <div class="composer-footer" id="${ids.stats(ctx)}">${renderAgentPaneComposerFooter(ctx, stats)}</div>
        </div>
      </div>`;
}

export async function renderLaunchComposerSettings(options: { frameId: string; formId: string; url: string; selectedModel?: string; selectedThinkingLevel?: string }): Promise<string> {
  const models = await configuredModelOptionViews();
  const selected = selectAvailableConfiguredModel(models, options.selectedModel ? parseModelRef(options.selectedModel) : undefined);
  const selectedValue = selected ? modelRefValue(selected) : "";
  const { selected: selectedThinkingLevel, levels: thinkingLevels } = await launchComposerThinkingSettings(selected);
  return renderLaunchModelSettings({
    ...options, agentProvider: "builtin", selectedValue,
    models: models.map((model) => ({ ...model, selected: modelRefValue(model) === selectedValue })),
    thinkingLevels,
    selectedThinkingLevel: options.selectedThinkingLevel && thinkingLevels.includes(options.selectedThinkingLevel) ? options.selectedThinkingLevel : selectedThinkingLevel ?? "",
    connectedProvider: hasConnectedModelProvider(await createPiModelRuntime()),
  });
}

function renderTranscriptEndNavigation(): string {
  const button = buttonHtml({
    type: "button",
    variant: "secondary",
    content: {
      kind: "icon-only",
      iconHtml: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 16h12M10 4v9m-4-4 4 4 4-4"/></svg>',
      label: "Follow latest",
    },
    attributesHtml: 'data-popular-button data-action="agent-pane#scrollToTranscriptEnd"',
  });
  return `<div class="agent-transcript-navigation" data-agent-pane-target="transcriptEnd" hidden>${button}</div>`;
}

export function renderPromptActions(ctx: AgentRenderContext | undefined, busy: boolean): string {
  const initialLabel = busy ? "Deliver a steering note while the agent keeps working" : "Send prompt";
  const activeLabel = "Agent is working — click to stop";
  const state = busy ? "active" : "initial";
  const paneAttrs = ctx
    ? ` data-agent-pane-target="sendStop" data-agent-busy="${busy}"${busy ? ` data-agent-abort-form-id="${ids.abortForm(ctx)}"` : ""}`
    : "";
  const actionAttrs = busy && ctx ? `form="${ids.abortForm(ctx)}"` : "";
  return activityButtonHtml({
    variant: "primary",
    iconOnly: true,
    initialLabel,
    activeLabel,
    type: "submit",
    state,
    initialContent: { kind: "html", html: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15V5m-4 4 4-4 4 4"/></svg>' },
    activeContent: { kind: "html", html: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="6" width="8" height="8" rx="1.5" fill="currentColor" stroke="none"/></svg>' },
    attributesHtml: `data-popular-button ${actionAttrs}${paneAttrs}`,
  });
}

function renderComposerActions(sendHtml: string): string {
  return `<div class="composer-actions">
    ${renderAttachmentPicker()}
    <span class="spacer"></span>
    <span class="composer-send-action">${sendHtml}</span>
    <span class="composer-connect-action">${buttonHtml({ type: "button", variant: "primary", content: { kind: "caption", caption: "Connect to send" }, attributesHtml: 'data-action="agent-model-setup#open"' })}</span>
  </div><p role="status" data-agent-attachments-target="status" hidden></p>`;
}

export function renderAgentPaneComposerFooter(ctx: AgentRenderContext, stats: AgentStatsView): string {
  const percent = stats.contextPercent;
  const meter = percent === null
    ? ""
    : `<span class="agent-stat" title="Context window used"><span class="agent-ctx-meter"><i style="width:${Math.min(100, Math.max(0, percent)).toFixed(0)}%"></i></span><b>${percent.toFixed(0)}%</b></span>`;
  const models = stats.models.length > 0 ? stats.models : [{ provider: "", id: "", name: stats.modelName ?? "no model", selected: true, available: false }];
  const formPrefix = `${ids.stats(ctx)}_selection`;
  const modelFormId = `${formPrefix}_model`;
  const thinkingFormId = `${formPrefix}_thinking`;
  const selectionForms = `<form id="${modelFormId}" method="post" action="${escapeHtml(agentPath(ctx, "/model"))}" hidden></form>
${stats.thinkingLevels.length > 0 ? `<form id="${thinkingFormId}" method="post" action="${escapeHtml(agentPath(ctx, "/thinking"))}" hidden></form>` : ""}`;
  return `<span data-agent-compact-available="${stats.compactAvailable}" data-controller="usage-provider" data-usage-provider-provider-value="${escapeHtml(models.find((model) => model.selected)?.provider ?? "")}" hidden></span>
${meter}
<span class="agent-stat" title="Tokens up (input)">↑ <b>${formatTokens(stats.inputTokens)}</b></span>
<span class="agent-stat" title="Tokens down (output)">↓ <b>${formatTokens(stats.outputTokens)}</b></span>
<span class="agent-stat" title="${stats.isSubagent ? "This agent" : "Root agent"} cost${stats.descendantCost === undefined ? "" : " + all subagents and nested subagents combined"}. Updated at agent turn end."><b>${formatCost(stats.cost)}${stats.descendantCost === undefined ? "" : ` + ${formatCost(stats.descendantCost)}`}</b></span>
${selectionForms}
${renderSharedComposerSelections({
    modelFormId,
    thinkingFormId,
    models,
    thinkingLevels: stats.thinkingLevels,
    selectedThinkingLevel: stats.thinkingLevel,
    autosubmitThinking: true,
    connectedProvider: stats.connectedProvider,
  })}`;
}
