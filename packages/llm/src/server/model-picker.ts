import { actionItemHtml } from "@atelier/design-system/action-item";
import { buttonHtml } from "@atelier/design-system/button";
import { popupHtml } from "@atelier/design-system/popup";
import { escapeHtml, providerBrandIconHtml } from "@atelier/shared";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { createPiModelRuntime } from "./pi-config-models.ts";
import type { ModelRef } from "./model-reference.ts";

export interface ComposerModelOption {
  provider: string;
  id: string;
  name: string;
  selected: boolean;
  available?: boolean;
  unavailableReason?: string;
}

interface SharedComposerSelectionsOptions {
  modelFormId: string;
  thinkingFormId: string;
  models: ComposerModelOption[];
  thinkingLevels: string[];
  selectedThinkingLevel: string;
  autosubmitThinking?: boolean;
  connectedProvider?: boolean;
}

function renderModelSelection(formId: string, models: ComposerModelOption[], connectedProvider = false): string {
  const selected = models.find((model) => model.selected) ?? models[0];
  const hasAvailableModel = models.some((model) => model.available !== false);
  const menuId = `${formId}_popup`;
  const setupAction = 'data-controller="agent-model-setup" data-action="click->agent-model-setup#open"';
  const configure = actionItemHtml({ kind: "single", label: { kind: "text", text: "Configure models" }, element: { tag: "button", attributesHtml: `type="button" role="menuitem" ${setupAction}` } });
  const modelItems = models.map((model) => {
    return actionItemHtml({
      kind: "single",
      label: { kind: "text", text: model.name },
      description: model.unavailableReason,
      leadingHtml: providerBrandIconHtml(model.provider, model.name),
      element: { tag: "button", attributesHtml: `type="submit" name="model" value="${escapeHtml(`${model.provider}::${model.id}`)}" form="${escapeHtml(formId)}" role="menuitemradio" aria-checked="${model.selected}"${model.available === false ? " disabled" : ""}` },
    });
  }).join("");
  if (!hasAvailableModel) return buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: connectedProvider ? "Choose models" : "Connect a model" }, attributesHtml: setupAction });
  return popupHtml({ id: menuId, label: "Model", placement: "above",
    trigger: { variant: "secondary", content: { kind: "caption", caption: selected?.name ?? "Model" } },
    contentHtml: `${configure}<hr class="popup-menu__separator">${modelItems}`,
  });
}

export function renderSharedComposerSelections(options: SharedComposerSelectionsOptions): string {
  const autosubmit = options.autosubmitThinking
    ? ` data-controller="composer-selection-autosubmit" data-composer-selection-autosubmit-form-id-value="${escapeHtml(options.thinkingFormId)}" data-action="change->composer-selection-autosubmit#submit"`
    : "";
  const thinkingSelection = options.thinkingLevels.length > 0
    ? `<span class="composer-selection-field"${autosubmit}><select class="composer-selection popup-select" data-popup-placement="above" name="level" form="${escapeHtml(options.thinkingFormId)}" title="Thinking level">${options.thinkingLevels.map((level) => `<option value="${escapeHtml(level)}"${level === options.selectedThinkingLevel ? " selected" : ""}>${escapeHtml(level)}</option>`).join("")}</select></span>`
    : "";
  const ready = options.models.some((model) => model.selected && model.available !== false);
  return `<span class="composer-selections" data-model-ready="${ready}">
${renderModelSelection(options.modelFormId, options.models, options.connectedProvider)}
${ready ? thinkingSelection : ""}
</span>`;
}

export function renderLaunchModelSettings(options: {
  frameId: string; formId: string; url: string; agentProvider: string; selectedValue: string;
  models: ComposerModelOption[]; thinkingLevels: string[]; selectedThinkingLevel: string; connectedProvider: boolean;
}): string {
  const modelFormId = `${options.frameId}_model_form`;
  return `<turbo-frame id="${escapeHtml(options.frameId)}" class="launch-model-settings" data-agent-provider="${escapeHtml(options.agentProvider)}">
<form id="${escapeHtml(modelFormId)}" method="get" action="${escapeHtml(options.url)}" data-turbo-frame="${escapeHtml(options.frameId)}" hidden></form>
<input type="hidden" name="provider" value="${escapeHtml(options.agentProvider)}" form="${escapeHtml(modelFormId)}">
<input type="hidden" name="model" value="${escapeHtml(options.selectedValue)}" form="${escapeHtml(options.formId)}">
${renderSharedComposerSelections({ ...options, modelFormId, thinkingFormId: options.formId })}</turbo-frame>`;
}

export async function modelThinkingLevels(ref: ModelRef) {
  const model = (await createPiModelRuntime()).getModel(ref.provider, ref.id);
  return model ? getSupportedThinkingLevels(model) : [];
}
