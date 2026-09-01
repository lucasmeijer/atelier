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
    })),
    ...skills.map((skill) => ({ kind: "skill" as const, trigger: `/skill:${skill.name}`, description: skill.description })),
  ];
}

export function renderSlashCommandCatalog(templates: readonly PromptTemplate[], skills: readonly Pick<Skill, "name" | "description">[]): string {
  const commands = slashCommands(templates, skills);
  const quickLaunches = templates.filter((template) => template.quickLaunch).map((template) => `<button class="button secondary agent-completion-option agent-quick-launch" type="button" data-completion-kind="quick-launch" data-command-trigger="${escapeHtml(template.trigger)}">${escapeHtml(template.trigger)}</button>`).join("");
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
        attributesHtml: `type="button" role="option" aria-selected="${index === 0 ? "true" : "false"}" data-completion-kind="${command.kind}" data-command-trigger="${escapeHtml(command.trigger)}"${command.trigger === "/tree" ? ` data-command-action="tree"` : ""}${template ? ` data-controller="atelier-fullscreen" data-atelier-fullscreen-mode-value="template" data-atelier-fullscreen-title-value="${escapeHtml(command.trigger)}"` : ""}`,
      },
    });
  }).join("")}</div>`;
  return `${quickLaunchCatalog}${slashCommandCatalog}`;
}
