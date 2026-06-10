import { createExtensionRuntime, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import { atelierMediaPromptInstructions } from "./rewrite.ts";

export const atelierSystemPrompt = `You are an Atelier coding agent running for a workspace container.
Your tools operate inside the workspace container, not on the Atelier host.
The workspace repo root is /repos. Multiple git repositories may be present as direct children of /repos.
Use read/write/edit/bash to inspect and modify files. No tool approval is required.
When referring to paths, prefer paths relative to /repos unless an absolute /repos path is clearer.

${atelierMediaPromptInstructions}`;

export function createAtelierResourceLoader(): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => atelierSystemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}
