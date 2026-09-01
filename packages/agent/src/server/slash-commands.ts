import { actionItemHtml } from "@atelier/design-system/action-item";
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
    { kind: "application-command" as const, trigger: "/tree", description: "Inspect and navigate the agent session tree." },
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
    const hotkeyData = hotkey ? ` data-prompt-template-hotkey="${escapeHtml(hotkey)}" aria-keyshortcuts="Meta+Alt+${escapeHtml(hotkey.toUpperCase())}"` : "";
    const shortcut = hotkey ? `<kbd class="agent-quick-launch-shortcut" aria-hidden="true">⌘⌥${escapeHtml(hotkey.toUpperCase())}</kbd>` : "";
    return `<button class="button secondary agent-completion-option agent-quick-launch" type="button" aria-label="${escapeHtml(template.trigger)}" data-completion-kind="quick-launch" data-command-trigger="${escapeHtml(template.trigger)}"${hotkeyData}><span>${escapeHtml(template.trigger)}</span>${shortcut}</button>`;
  }).join("");
  const quickLaunchCatalog = quickLaunches ? `<div class="agent-quick-launches" role="group" aria-label="Quick launch">${quickLaunches}</div>` : "";
  const slashCommandCatalog = `<div class="popup-menu autocomplete-menu action-list" role="listbox" aria-label="Slash commands">${commands.map((command, index) => {
    const template = command.prompt !== undefined;
    return actionItemHtml({
      kind: "single",
      label: { kind: "text", text: `${command.trigger}${command.argumentHint ? ` ${command.argumentHint}` : ""} — ${command.description}` },
      trailingHtml: command.prompt === undefined ? "" : `<template data-atelier-fullscreen-target="content"><pre class="agent-template-preview">${escapeHtml(command.prompt)}</pre></template>`,
      element: {
        tag: "button",
        className: `agent-completion-option${index === 0 ? " active" : ""}`,
        attributesHtml: `type="button" role="option" aria-selected="${index === 0 ? "true" : "false"}" data-completion-kind="${command.kind}" data-command-trigger="${escapeHtml(command.trigger)}"${command.hotkey ? ` data-prompt-template-hotkey="${escapeHtml(command.hotkey)}"` : ""}${command.trigger === "/tree" ? ` data-command-action="tree"` : ""}${template ? ` data-controller="atelier-fullscreen" data-atelier-fullscreen-mode-value="template" data-atelier-fullscreen-title-value="${escapeHtml(command.trigger)}"` : ""}`,
      },
    });
  }).join("")}</div>`;
  return `${quickLaunchCatalog}${slashCommandCatalog}`;
}
