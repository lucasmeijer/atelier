import { listPromptTemplates } from "./prompt-templates.ts";
import { loadWorkspaceSkills } from "./skills.ts";
import { renderSlashCommandCatalog } from "./slash-commands.ts";

export async function renderWorkspaceCompletionCatalog(workspaceId: string): Promise<string> {
  const [templates, { skills }] = await Promise.all([listPromptTemplates(workspaceId), loadWorkspaceSkills(workspaceId)]);
  return renderSlashCommandCatalog(templates, skills);
}
