import { activityButtonHtml } from "@atelier/design-system/activity-button";
import { actionItemHtml } from "@atelier/design-system/action-item";
import { buttonHtml } from "@atelier/design-system/button";
import { popupMenuHtml } from "@atelier/design-system/popup";
import { renderTranscriptionComposerControl, transcriptionComposerController } from "@atelier/transcription/server";
import { providerBrandIconHtml } from "@atelier/shared";
import { domId, escapeHtml } from "./html.ts";
import { launchComposerThinkingLevel, launchComposerThinkingLevels, configuredModelOptionViews, modelRefValue, resolveNewWorkspaceAgentModel, type ModelRef } from "./model-state.ts";
import type { WorkspaceAgentConversationInfo } from "./session-store.ts";
import { agentAttachmentDraftId, listStagedAttachments, type StagedAttachment } from "./attachment-drafts.ts";
import { readInitialPromptDraft } from "./initial-prompt-draft.ts";
import { formatCost, formatTokens } from "./transcript.ts";
import { agentConversationKey, agentPath, ids, type AgentRenderContext } from "./render-context.ts";
import { renderAttachmentChip } from "./render-attachments.ts";

interface AgentModelOption {
  provider: string;
  id: string;
  name: string;
  selected: boolean;
  available?: boolean;
  unavailableReason?: string;
}

export interface AgentStatsView {
  contextPercent: number | null;
  compactAvailable: boolean;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  modelName: string | undefined;
  thinkingLevel: string;
  thinkingLevels: string[];
  models: AgentModelOption[];
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

export async function renderAgentPane(ctx: AgentRenderContext, agent: WorkspaceAgentConversationInfo, state: AgentPaneState): Promise<string> {
  return await renderAgentPaneFrame(ctx, agent, state);
}

async function renderAgentPaneFrame(ctx: AgentRenderContext, agent: WorkspaceAgentConversationInfo, state: AgentPaneState): Promise<string> {
  const key = agentConversationKey(agent.conversationId);
  const draftId = agentAttachmentDraftId(ctx.workspaceId, ctx.conversationId);
  const attachments = await listStagedAttachments(draftId);
  const initialPromptDraft = await readInitialPromptDraft(ctx.workspaceId, ctx.conversationId);
  const initialText = initialPromptDraft?.prompt;
  const attachRowId = ids.attachRow(ctx);
  const uploadUrl = `/agent-attachment-drafts/${encodeURIComponent(draftId)}/attachments?row=${encodeURIComponent(attachRowId)}`;
  return `<section id="${domId("agent_pane", ctx.workspaceId, agent.conversationId)}" class="agent-conversation-pane" data-agent-conversation-source="${escapeHtml(key)}">
    <div class="agent-pane" id="${ids.pane(ctx)}"
      data-controller="agent-pane agent-attachments"
      data-agent-pane-workspace-id-value="${escapeHtml(ctx.workspaceId)}"
      data-agent-pane-conversation-id-value="${escapeHtml(ctx.conversationId)}"
      ${agentAttachmentDropAttrs(uploadUrl)}>
      <div class="agent-transcript" id="${ids.transcript(ctx)}" data-agent-pane-target="transcript">${state.transcriptHtml}</div>
      ${await renderAgentPaneComposer({
        ctx,
        action: agentPath(ctx, "/messages"),
        draftId,
        attachments,
        placeholder: "Write your prompt here",
        initialText,
        formTarget: true,
        includePaneActions: true,
        busy: state.busy,
        stats: state.stats,
        dropTarget: false,
      })}
    </div>
  </section>`;
}

export function renderAgentPanePromptInput(ctx: AgentRenderContext, initialText = ""): string {
  const placeholder = "Write your prompt here";
  return `<textarea id="${ids.input(ctx)}" class="composer-input" name="text" rows="2" enterkeyhint="send" placeholder="${escapeHtml(placeholder)}" aria-label="${escapeHtml(placeholder)}" data-agent-pane-target="input" data-agent-completions-target="input" data-action="input->agent-completions#input input->agent-pane#promptChanged">${escapeHtml(initialText)}</textarea>`;
}

interface SharedComposerRenderOptions {
  kind: "agent-pane" | "launch";
  ctx?: AgentRenderContext;
  action: string;
  draftId: string;
  attachments?: readonly StagedAttachment[];
  placeholder: string;
  initialText?: string;
  inputId?: string;
  formTarget?: boolean;
  includePaneActions?: boolean;
  busy?: boolean;
  stats?: AgentStatsView;
  formId?: string;
  rows?: number;
  formActions?: string;
  formTurbo?: boolean;
  launchComposerSettings?: { frameId: string; url: string };
  dropTarget?: boolean;
}

export async function renderAgentPaneComposer(options: Omit<SharedComposerRenderOptions, "kind">): Promise<string> {
  return await renderSharedComposer({ ...options, kind: "agent-pane" });
}

export async function renderLaunchComposer(options: Omit<SharedComposerRenderOptions, "kind">): Promise<string> {
  return await renderSharedComposer({ ...options, kind: "launch" });
}

async function renderSharedComposer(options: SharedComposerRenderOptions): Promise<string> {
  const draftId = options.draftId;
  const attachRowId = options.ctx ? ids.attachRow(options.ctx) : ids.draftAttachRow(draftId);
  const uploadUrl = `/agent-attachment-drafts/${encodeURIComponent(draftId)}/attachments?row=${encodeURIComponent(attachRowId)}`;
  const actionAttrs = ["submit->transcription-composer#submit", "turbo:submit-end->agent-pane#submitted", "click->agent-pane#focusInput"];
  const targetAttrs = options.formTarget ? ` data-agent-pane-target="form"` : "";
  const completionsEnabled = Boolean(options.ctx);
  const inputTarget = [
    options.formTarget ? `data-agent-pane-target="input"` : "",
    completionsEnabled ? `data-agent-completions-target="input"` : "",
  ].filter(Boolean).join(" ");
  const inputActionsList = [
    ...(completionsEnabled ? ["input->agent-completions#input"] : []),
    ...(options.formTarget ? ["input->agent-pane#promptChanged"] : []),
  ];
  const inputActions = inputActionsList.length ? ` data-action="${inputActionsList.join(" ")}"` : "";
  const formActions = options.formTarget
    ? ["keydown->agent-completions#keydown", "keydown->agent-pane#inputKeydown", ...actionAttrs].join(" ")
    : ["submit->transcription-composer#submit", options.formActions].filter(Boolean).join(" ");
  const actions = options.includePaneActions && options.ctx
    ? `<span id="${ids.actions(options.ctx)}">${renderPromptActions(options.ctx, Boolean(options.busy))}</span>`
    : renderPromptActionButton(false);
  const formId = options.formId ?? `agent_pane_composer_${draftId}`;
  const footer = options.stats && options.ctx
    ? `<div class="composer-footer" id="${ids.stats(options.ctx)}">${renderAgentPaneComposerFooter(options.ctx, options.stats)}</div>`
    : `<div class="composer-footer">${await renderLaunchComposerSettings({ ...options.launchComposerSettings!, formId })}</div>`;
  const turboAttr = options.formTurbo === undefined ? "" : ` data-turbo="${options.formTurbo ? "true" : "false"}"`;
  const dropTarget = options.dropTarget ?? true;
  const promptControllers = [dropTarget ? "agent-attachments" : "", completionsEnabled ? "agent-completions" : "", transcriptionComposerController].filter(Boolean).join(" ");
  const promptAttrs = [
    `data-controller="${promptControllers}"`,
    dropTarget ? agentAttachmentDropAttrs(uploadUrl) : "",
    options.ctx ? `data-agent-completions-url-value="${escapeHtml(agentPath(options.ctx, "/completions"))}"` : "",
  ].filter(Boolean).join(" ");
  const composerOverlays = options.includePaneActions && options.ctx ? renderTranscriptNavigation() : "";
  const completionMenu = completionsEnabled ? `<div class="agent-completion-menu-host" data-agent-completions-target="menu" hidden></div>` : "";
  const textarea = options.ctx && options.formTarget
    ? renderAgentPanePromptInput(options.ctx, options.initialText ?? "")
    : `<textarea${options.inputId ? ` id="${escapeHtml(options.inputId)}"` : ""} class="composer-input" name="text" rows="${options.rows ?? 2}" enterkeyhint="send" placeholder="${escapeHtml(options.placeholder)}" aria-label="${escapeHtml(options.placeholder)}"${inputTarget ? ` ${inputTarget}` : ""}${inputActions}>${escapeHtml(options.initialText ?? "")}</textarea>`;
  return `<div class="composer ${options.kind === "agent-pane" ? "agent-pane-composer" : "launch-composer"}"${promptAttrs ? ` ${promptAttrs}` : ""}>
        ${composerOverlays ? `<div class="agent-pane-composer-overlays">${composerOverlays}</div>` : ""}
        <div class="composer-surface">
          <form id="${escapeHtml(formId)}" method="post" action="${escapeHtml(options.action)}"${turboAttr}${targetAttrs} data-action="${escapeHtml(formActions)}">
            <input type="hidden" name="attachmentDraft" value="${escapeHtml(draftId)}">
            <div class="agent-attach-row" id="${attachRowId}" data-agent-attachments-target="row">${(options.attachments ?? []).map((attachment) => renderAttachmentChip(attachment, draftId)).join("")}</div>
            <div class="composer-input-area">
              ${textarea}
              ${renderTranscriptionComposerControl()}
            </div>
            <div class="composer-actions">
              <span class="spacer"></span>
              ${actions}
            </div>
          </form>
          ${completionMenu}
          ${options.includePaneActions && options.ctx ? `<form id="${ids.abortForm(options.ctx)}" method="post" action="${escapeHtml(agentPath(options.ctx, "/abort"))}" hidden></form>` : ""}
          ${footer}
        </div>
      </div>`;
}

async function launchComposerModels(selectedModel?: string): Promise<AgentModelOption[]> {
  const selected = await resolveNewWorkspaceAgentModel(selectedModel);
  const models = await configuredModelOptionViews(selected);
  return models.map((model, index) => ({ ...model, selected: selected ? model.selected : index === 0 }));
}

async function launchComposerSettingsState(selectedModel?: string): Promise<{ selected: ModelRef | undefined; selectedThinkingLevel: string | undefined; thinkingLevels: string[] }> {
  const selected = await resolveNewWorkspaceAgentModel(selectedModel);
  return {
    selected,
    selectedThinkingLevel: await launchComposerThinkingLevel(selected),
    thinkingLevels: await launchComposerThinkingLevels(selected),
  };
}

interface SharedComposerSelectionsOptions {
  modelFormId: string;
  thinkingFormId: string;
  models: AgentModelOption[];
  thinkingLevels: string[];
  selectedThinkingLevel: string;
  autosubmitThinking?: boolean;
}

function modelLabelHtml(model: Pick<AgentModelOption, "provider" | "name">): string {
  return `${providerBrandIconHtml(model.provider, model.name, "brand-icon agent-model-provider-icon")}<span>${escapeHtml(model.name)}</span>`;
}

function renderModelSelection(formId: string, models: AgentModelOption[]): string {
  const selected = models.find((model) => model.selected) ?? models[0];
  const hasAvailableModel = models.some((model) => model.available !== false);
  const menuId = `${formId}_popup`;
  const setupAction = 'data-controller="agent-model-setup" data-action="click->agent-model-setup#open"';
  const triggerContent = hasAvailableModel && selected ? modelLabelHtml(selected) : "Configure models";
  const directSetup = hasAvailableModel ? "" : ` ${setupAction}`;
  const trigger = `<button class="composer-selection-button agent-model-button" type="button" data-popup-menu-trigger title="Model" aria-label="Model${selected ? `: ${escapeHtml(selected.name)}` : ""}" aria-haspopup="menu" aria-expanded="false" aria-controls="${escapeHtml(menuId)}" popovertarget="${escapeHtml(menuId)}"${directSetup}>${triggerContent}</button>`;
  const configure = actionItemHtml({ kind: "single", label: { kind: "text", text: "Configure models" }, element: { tag: "button", attributesHtml: `type="button" role="menuitem" ${setupAction}` } });
  const modelItems = models.map((model) => {
    const description = model.unavailableReason && model.unavailableReason !== "Provider disconnected"
      ? `<span class="popup-menu__description">${escapeHtml(model.unavailableReason)}</span>`
      : "";
    return actionItemHtml({
      kind: "single",
      label: { kind: "html", html: `${modelLabelHtml(model)}${description}`, className: "agent-model-option-label" },
      element: { tag: "button", attributesHtml: `type="submit" name="model" value="${escapeHtml(`${model.provider}::${model.id}`)}" form="${escapeHtml(formId)}" role="menuitemradio" aria-checked="${model.selected}"${model.available === false ? " disabled" : ""}` },
    });
  }).join("");
  const menu = popupMenuHtml({ id: menuId, label: "Model", placement: "above", contentHtml: `${configure}<hr class="popup-menu__separator">${modelItems}` });
  return `<span class="composer-selection-field popup-menu-anchor">${trigger}${menu}</span>`;
}

function renderSharedComposerSelections(options: SharedComposerSelectionsOptions): string {
  const autosubmit = options.autosubmitThinking
    ? ` data-controller="composer-selection-autosubmit" data-composer-selection-autosubmit-form-id-value="${escapeHtml(options.thinkingFormId)}" data-action="change->composer-selection-autosubmit#submit"`
    : "";
  const thinkingSelection = options.thinkingLevels.length > 0
    ? `<span class="composer-selection-field"${autosubmit}><select class="composer-selection popup-select" data-popup-placement="above" name="level" form="${escapeHtml(options.thinkingFormId)}" title="Thinking level">${options.thinkingLevels.map((level) => `<option value="${escapeHtml(level)}"${level === options.selectedThinkingLevel ? " selected" : ""}>${escapeHtml(level)}</option>`).join("")}</select></span>`
    : "";
  return `<span class="composer-selections">
${renderModelSelection(options.modelFormId, options.models)}
${thinkingSelection}
</span>`;
}

export async function renderLaunchComposerSettings(options: { frameId: string; formId: string; url: string; selectedModel?: string }): Promise<string> {
  const { selected, selectedThinkingLevel, thinkingLevels } = await launchComposerSettingsState(options.selectedModel);
  const selectedValue = selected ? modelRefValue(selected) : "";
  const modelFormId = `${options.frameId}_model_form`;
  return `<turbo-frame id="${escapeHtml(options.frameId)}"><form id="${escapeHtml(modelFormId)}" method="get" action="${escapeHtml(options.url)}" data-turbo-frame="${escapeHtml(options.frameId)}" hidden></form>
<input type="hidden" name="model" value="${escapeHtml(selectedValue)}" form="${escapeHtml(options.formId)}">
${renderSharedComposerSelections({
    modelFormId,
    thinkingFormId: options.formId,
    models: await launchComposerModels(selectedValue || undefined),
    thinkingLevels,
    selectedThinkingLevel: selectedThinkingLevel ?? "",
  })}</turbo-frame>`;
}

function renderTranscriptNavigation(): string {
  const button = buttonHtml({
    type: "button",
    variant: "secondary",
    content: {
      kind: "icon-only",
      iconHtml: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 16h12M10 4v9m-4-4 4 4 4-4"/></svg>',
      label: "Jump to beginning of latest message",
    },
    disabled: true,
    attributesHtml: 'data-agent-pane-target="transcriptNav" data-action="agent-pane#jumpToLatestMessage" aria-hidden="true"',
  });
  return `<div class="agent-transcript-navs">${button}</div>`;
}

function renderPromptActionButton(busy: boolean, ctx?: AgentRenderContext): string {
  const initialLabel = busy ? "Deliver a steering note while the agent keeps working" : "Send prompt";
  const activeLabel = "Agent is working — click to stop";
  const state = busy ? "active" : "initial";
  const paneAttrs = ctx
    ? ` data-agent-pane-target="sendStop" data-agent-busy="${busy}"${busy ? ` data-agent-abort-form-id="${ids.abortForm(ctx)}"` : ""}`
    : "";
  const actionAttrs = busy && ctx
    ? `form="${ids.abortForm(ctx)}"`
    : `name="mode" value="${busy ? "steer" : "send"}"`;
  return activityButtonHtml({
    variant: "primary",
    iconOnly: true,
    initialLabel,
    activeLabel,
    type: "submit",
    state,
    initialContent: { kind: "html", html: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15V5m-4 4 4-4 4 4"/></svg>' },
    activeContent: { kind: "html", html: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="6" width="8" height="8" rx="1.5" fill="currentColor" stroke="none"/></svg>' },
    attributesHtml: `${actionAttrs}${paneAttrs}`,
  });
}

export function renderPromptActions(ctx: AgentRenderContext, busy: boolean): string {
  return renderPromptActionButton(busy, ctx);
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
  return `<span data-agent-compact-available="${stats.compactAvailable}" hidden></span>
${meter}
<span class="agent-stat" title="Tokens up (input)">↑ <b>${formatTokens(stats.inputTokens)}</b></span>
<span class="agent-stat" title="Tokens down (output)">↓ <b>${formatTokens(stats.outputTokens)}</b></span>
<span class="agent-stat" title="Session cost"><b>${formatCost(stats.cost)}</b></span>
${selectionForms}
${renderSharedComposerSelections({
    modelFormId,
    thinkingFormId,
    models,
    thinkingLevels: stats.thinkingLevels,
    selectedThinkingLevel: stats.thinkingLevel,
    autosubmitThinking: true,
  })}`;
}
