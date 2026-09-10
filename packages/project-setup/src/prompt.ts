import { formatProjectSpec, type ProjectSummary } from "@atelier/projects";

export const projectSetupGuidePath = "/opt/atelier/project-setup/configure-user-project.md";

export function projectSetupPrompt(project: ProjectSummary): string {
  return `Please help me setup my new project for ${formatProjectSpec(project)}

Instructions on how to do so you can find in ${projectSetupGuidePath}.`;
}
