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

export function renderSlashCommandMenu(templates: readonly PromptTemplate[], skills: readonly Pick<Skill, "name" | "description">[], query: string): string {
  const normalized = query.toLowerCase();
  const filtered = slashCommands(templates, skills)
    .filter((command) => command.trigger.slice(1).toLowerCase().includes(normalized))
    .sort((a, b) => {
      const aName = a.trigger.slice(1).toLowerCase();
      const bName = b.trigger.slice(1).toLowerCase();
      return Number(bName.startsWith(normalized)) - Number(aName.startsWith(normalized)) || aName.localeCompare(bName);
    })
    .slice(0, 12);
  if (filtered.length === 0) return `<div class="agent-completion-menu empty">No slash commands</div>`;
  return `<div class="agent-completion-menu" role="listbox" aria-label="Slash commands">${filtered.map((command, index) => {
    const template = command.prompt !== undefined;
    return `<button type="button" class="agent-completion-option agent-template-option${index === 0 ? " active" : ""}" role="option" aria-selected="${index === 0 ? "true" : "false"}" data-completion-kind="${command.kind}" data-command-trigger="${escapeHtml(command.trigger)}"${command.trigger === "/tree" ? ` data-command-action="tree"` : ""}${template ? ` data-controller="atelier-fullscreen" data-atelier-fullscreen-mode-value="template" data-atelier-fullscreen-title-value="${escapeHtml(command.trigger)}"` : ""}>
      <span class="agent-template-name">${escapeHtml(command.trigger)}</span><span class="agent-template-args">${escapeHtml(command.argumentHint ?? "")}</span><span class="agent-template-desc">${escapeHtml(command.description)}</span>${command.prompt !== undefined ? `<template data-atelier-fullscreen-target="content"><pre class="agent-template-preview">${escapeHtml(command.prompt)}</pre></template>` : ""}
    </button>`;
  }).join("")}</div>`;
}
