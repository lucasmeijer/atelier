import { actionItemHtml } from "@atelier/design-system/action-item";
import { autocompleteHtml } from "@atelier/design-system/autocomplete";
import { buttonHtml } from "@atelier/design-system/button";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { escapeHtml } from "./html.ts";
import type { PromptTemplate } from "./prompt-templates.ts";

interface SlashCommand {
  kind: "prompt-template" | "skill" | "application-command";
  trigger: string;
  description: string;
  argumentHint?: string;
  prompt?: string;
  hotkey?: string;
}

function slashCommands(templates: readonly PromptTemplate[], skills: readonly Pick<Skill, "name" | "description">[]): SlashCommand[] {
  return [
    { kind: "application-command" as const, trigger: "/tree", description: "Coming soon." },
    ...templates.filter((template) => template.trigger !== "/tree").map((template) => ({
      kind: "prompt-template" as const,
      trigger: template.trigger,
      description: template.description,
      argumentHint: template.argumentHint,
      prompt: template.prompt,
      hotkey: template.hotkey,
    })),
    ...skills.map((skill) => ({ kind: "skill" as const, trigger: `/skill:${skill.name}`, description: skill.description })),
  ];
}

export function renderSlashCommandCatalog(templates: readonly PromptTemplate[], skills: readonly Pick<Skill, "name" | "description">[]): string {
  const commands = slashCommands(templates, skills);
  const quickLaunches = templates.filter((template) => template.quickLaunch).map((template) => {
    const hotkey = template.hotkey;
    const hotkeyData = hotkey ? ` data-prompt-template-hotkey="${escapeHtml(hotkey)}" data-agent-quick-launch-shortcut="⌘⌥${escapeHtml(hotkey.toUpperCase())}" aria-keyshortcuts="Meta+Alt+${escapeHtml(hotkey.toUpperCase())}"` : "";
    return buttonHtml({
      type: "button",
      variant: "secondary",
      content: { kind: "caption", caption: template.trigger },
      attributesHtml: `data-agent-completion-option data-agent-quick-launch data-completion-kind="quick-launch" data-command-trigger="${escapeHtml(template.trigger)}"${hotkeyData}`,
    });
  }).join("");
  const quickLaunchCatalog = quickLaunches ? `<div class="agent-quick-launches" role="group" aria-label="Quick launch">${quickLaunches}</div>` : "";
  const slashCommandCatalog = autocompleteHtml({ kind: "results", label: "Slash commands", contentHtml: commands.map((command, index) => {
    const template = command.prompt !== undefined;
    return actionItemHtml({
      kind: "single",
      label: { kind: "text", text: `${command.trigger}${command.argumentHint ? ` ${command.argumentHint}` : ""} — ${command.description}` },
      trailingHtml: command.prompt === undefined ? "" : `<template data-atelier-fullscreen-target="content"><pre class="agent-template-preview">${escapeHtml(command.prompt)}</pre></template>`,
      element: {
        tag: "button",

        attributesHtml: `type="button" role="option" aria-selected="${index === 0 ? "true" : "false"}" data-completion-kind="${command.kind}" data-command-trigger="${escapeHtml(command.trigger)}"${command.hotkey ? ` data-prompt-template-hotkey="${escapeHtml(command.hotkey)}"` : ""}${command.trigger === "/tree" ? ` data-command-action="notice" data-command-message="/tree feature is coming soon!"` : ""}${template ? ` data-controller="atelier-fullscreen" data-atelier-fullscreen-mode-value="template" data-atelier-fullscreen-title-value="${escapeHtml(command.trigger)}"` : ""}`,
      },
    });
  }).join("") });
  return `${quickLaunchCatalog}${slashCommandCatalog}`;
}
