import { existsSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceCreationContext } from "@atelier/workspace";
import { findProjectRecord, projectsFile, readProjectStore, writeProjectStore } from "./project.ts";

const atelierProjectDirectory = ".atelier";

export function projectPreparationPrompt(originalPrompt = ""): string {
  const request = originalPrompt.trim();
  return `Prepare this project for efficient use in Atelier's remote development environment.

First, learn how the project works: inspect its structure, documentation, development commands, tests, and existing agent instructions. Then verify that a fresh Atelier workspace can install dependencies, run the relevant checks, and start the development environment without relying on software or state from a developer's local machine.

Identify remote-environment assumptions such as required system packages, language runtimes, services, local secrets, environment variables, credentials, and platform-specific tooling. Add the minimal useful Atelier configuration under \`.atelier/\` where needed—for example \`.atelier/setup.sh\`, \`.atelier/Dockerfile\`, \`.atelier/workspace.json\`, or \`.atelier/AGENTS.md\`. Do not add secrets to the repository. Prefer reproducible setup, validate what you change, and document any remaining user action.

Summarize how the project works, what you verified, what you changed, and anything that still prevents it from being ready for future Atelier workspaces.${request ? `

After the project is prepared, continue with the user's original request:

${request}` : ""}`;
}

export async function neverOfferProjectPreparation(projectId: string, file = projectsFile()): Promise<void> {
  const store = await readProjectStore(file);
  findProjectRecord(store, projectId).neverOfferPreparation = true;
  await writeProjectStore(file, store);
}

export async function stageProjectPreparationPrompt(projectId: string, workHostPath: string, context: WorkspaceCreationContext, file = projectsFile()): Promise<boolean> {
  const project = findProjectRecord(await readProjectStore(file), projectId);
  if (existsSync(join(workHostPath, atelierProjectDirectory)) || project.neverOfferPreparation) return false;
  const agent = context.agent ?? {};
  context.agent = {
    ...agent,
    initialPrompt: projectPreparationPrompt(agent.initialPrompt),
    initialPromptMode: "suggestion",
  };
  return true;
}
