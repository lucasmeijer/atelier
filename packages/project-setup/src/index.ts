import { buttonHtml } from "@atelier/design-system/button";
import { formatProjectSpec, parseProjectSpec, type ProjectSummary } from "@atelier/projects";
import { escapeHtml, type AgentWorkspaceParameters } from "@atelier/shared";
import { projectSetupPrompt } from "./prompt.ts";
import { addProjectSecretToolName, addProjectEnvironmentVariableToolName, setProjectDockerfileToolName } from "./tool.ts";

interface ProjectSetupWorkspace {
  source: { type: "empty" };
  title: string;
  agent: AgentWorkspaceParameters;
}

export function projectSetupWorkspace(project: ProjectSummary): ProjectSetupWorkspace {
  return {
    source: { type: "empty" },
    title: `Set up ${project.name}`,
    agent: {
      initialPrompt: projectSetupPrompt(project),
      additionalTools: [addProjectSecretToolName, addProjectEnvironmentVariableToolName, setProjectDockerfileToolName].map((name) => ({ name, context: { projectId: project.id } })),
    },
  };
}

export function projectSetupFrame(gitUrl: string): string {
  const source = formatProjectSpec(parseProjectSpec(gitUrl));
  const accept = buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Let’s go!" }, attributesHtml: 'name="setup" value="true" autofocus data-turbo-submits-with="Starting setup…"' });
  const skip = buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "Skip this step" }, attributesHtml: 'name="setup" value="false" data-turbo-submits-with="Adding…"' });
  return `<turbo-frame id="project_editor_frame" class="project-editor-frame"><div class="project-editor-page project-editor-detail-page"><form class="project-editor-new-form project-setup-step" aria-label="Project setup" method="post" action="/projects" data-turbo="true">
    <input type="hidden" name="gitUrl" value="${escapeHtml(source)}">
    <div class="markdown"><p>An agent will help you configure your new project.</p></div>
    <footer><span class="project-setup-skip">${skip}</span>${accept}</footer>
  </form></div></turbo-frame>`;
}
