import { buttonHtml } from "@atelier/design-system/button";
import { renderTranscriptionComposerControl, transcriptionComposerController } from "@atelier/transcription/server";
import { domId, escapeHtml, type AgentLaunchFooterContext, type WorkspaceAgentProvider } from "@atelier/shared";

/** Host-owned launch composer content. */
export interface AgentLaunchPresentation {
  attributesHtml: string;
  formAttributesHtml: string;
  bodyHtml: string;
  footerHtml: string;
  discardUrl: string;
}
const launchProviderFrameId = "launch_composer_provider";

export async function renderLaunchProvider(provider: WorkspaceAgentProvider, providers: readonly WorkspaceAgentProvider[], context: AgentLaunchFooterContext): Promise<string> {
  const selectionFormId = `${launchProviderFrameId}_selection`;
  return `<turbo-frame id="${launchProviderFrameId}">
    <form id="${selectionFormId}" method="get" action="/launch-composer/provider" data-turbo-frame="${launchProviderFrameId}" hidden></form>
    <input type="hidden" name="provider" value="${escapeHtml(provider.id)}" form="${escapeHtml(context.formId)}">
    <span data-controller="composer-selection-autosubmit" data-composer-selection-autosubmit-form-id-value="${selectionFormId}" data-action="change->composer-selection-autosubmit#submit">
      <select class="popup-select" name="provider" form="${selectionFormId}" aria-label="Agent provider" data-popup-placement="above">${providers.map((item) => `<option value="${escapeHtml(item.id)}"${item.id === provider.id ? " selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}</select>
    </span>
    ${await provider.launch.renderFooter(context)}
  </turbo-frame>`;
}

/** The host owns text and attachments; provider switches replace only the settings footer. */
export async function launchComposerContent(options: { draftId: string; provider: WorkspaceAgentProvider; providers: readonly WorkspaceAgentProvider[]; context: AgentLaunchFooterContext }): Promise<AgentLaunchPresentation> {
  const { draftId } = options;
  const rowId = domId("agent_draft_attach", draftId);
  const uploadUrl = `/agent-attachment-drafts/${encodeURIComponent(draftId)}/attachments?row=${rowId}`;
  const send = buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Create workspace" } });
  return {
    attributesHtml: `data-controller="composer-focus agent-attachments ${transcriptionComposerController}" data-action="mousedown->composer-focus#preserveInputFocus dragover->agent-attachments#dragOver dragleave->agent-attachments#dragLeave drop->agent-attachments#drop" data-agent-attachments-upload-url-value="${escapeHtml(uploadUrl)}"`,
    formAttributesHtml: 'data-action="submit->transcription-composer#submit keydown->submit-shortcut#keydown submit->submit-shortcut#submit turbo:submit-end->launch-composer-dialog#submitted turbo:submit-end->submit-shortcut#submitted"',
    bodyHtml: `<input type="hidden" name="attachmentDraft" value="${escapeHtml(draftId)}">
      <div class="agent-attach-row" id="${rowId}" data-agent-attachments-target="row"></div>
      <div class="composer-input-area"><textarea class="composer-input" name="text" rows="8" enterkeyhint="send" placeholder="Describe what you want the agent to do… (optional)" aria-label="Initial agent prompt" data-action="paste->agent-attachments#paste"></textarea>${renderTranscriptionComposerControl()}</div>
      <div class="composer-actions"><label class="launch-attach">Attach files<input type="file" multiple data-action="change->agent-attachments#choose"></label><span class="spacer"></span>${send}</div>
      <p role="status" data-agent-attachments-target="status" hidden></p>`,
    footerHtml: await renderLaunchProvider(options.provider, options.providers, options.context),
    discardUrl: `/agent-attachment-drafts/${encodeURIComponent(draftId)}/discard`,
  };
}

export function renderLaunchComposer(options: { action: string; formId: string; content: AgentLaunchPresentation }): string {
  const { content } = options;
  return `<div class="composer launch-composer" ${content.attributesHtml}>
    <div class="composer-surface">
      <form id="${escapeHtml(options.formId)}" method="post" action="${escapeHtml(options.action)}" data-turbo="true" ${content.formAttributesHtml}>
        ${content.bodyHtml}
      </form>
      <div class="composer-footer">${content.footerHtml}</div>
    </div>
  </div>`;
}
