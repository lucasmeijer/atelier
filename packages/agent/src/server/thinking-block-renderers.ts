import { escapeHtml } from "./html.ts";
import type { ModelRef } from "./model-state.ts";

type ThinkingBlockRenderer = (input: { contentId: string; text: string }) => string;

/** The default renderer: clamp long thoughts until the reader expands them. */
const renderTruncatedThinkingBlock: ThinkingBlockRenderer = ({ contentId, text }) =>
  `<div class="agent-thinking-text" data-controller="agent-thinking" data-action="click->agent-thinking#expand keydown->agent-thinking#keydown"><span id="${escapeHtml(contentId)}" data-agent-thinking-target="content">${escapeHtml(text.trimEnd())}</span><span data-agent-thinking-target="preview" hidden></span><button class="agent-thinking-more" type="button" data-agent-thinking-target="more" tabindex="-1" hidden>...(show more)</button></div>`;

/** A simple renderer that immediately displays the complete thought. */
const renderFullThinkingBlock: ThinkingBlockRenderer = ({ contentId, text }) =>
  `<div class="agent-thinking-text expanded"><span id="${escapeHtml(contentId)}">${escapeHtml(text.trimEnd())}</span></div>`;

interface ThinkingBlockRendererRule {
  matches(model: ModelRef): boolean;
  renderer: ThinkingBlockRenderer;
}

const rendererRules: readonly ThinkingBlockRendererRule[] = [
  {
    matches: ({ provider, id }) => provider === "openai-codex" && /^gpt-5\.(?:5|6)(?:$|[-.])/.test(id),
    renderer: renderFullThinkingBlock,
  },
];

/** Selects a model-specific renderer, falling back to the truncated renderer. */
export function thinkingBlockRendererFor(model?: ModelRef): ThinkingBlockRenderer {
  return (model && rendererRules.find((rule) => rule.matches(model))?.renderer) ?? renderTruncatedThinkingBlock;
}
