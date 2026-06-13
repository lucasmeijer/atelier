export interface PromptTemplate {
  /** Short command users type into the agent composer. */
  trigger: string;
  /** Prompt text sent to the agent when the trigger is submitted. */
  prompt: string;
  description: string;
}

export const atelierPromptTemplates: readonly PromptTemplate[] = [
  {
    trigger: "/land",
    description: "Commit, push, and discard this Atelier workspace.",
    prompt: "commit and push your work to origin/main.  when succesful, use the delete_current_workspace toolcall to discard this session and the associated atelier execution environment",
  },
];

const templatesByTrigger = new Map(atelierPromptTemplates.map((template) => [template.trigger, template]));

export function expandPromptTemplate(text: string): string {
  const template = templatesByTrigger.get(text.trim());
  return template ? template.prompt : text;
}
