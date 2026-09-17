import type { JsonObject } from "@atelier/core";
import type { AgentLaunchFooterContext, AgentWorkspaceParameters, WorkspaceAgentInput } from "@atelier/shared";

/** Provider-specific policy; the shared module owns sessions and terminal presentation. */
export interface CliAgentAdapter {
  /** Stable slug: also owns <id>-agents.json, <id>-agents routes and tmux names. */
  id: string;
  label: string;
  iconHtml: string;
  requireSetup(): Promise<void>;
  settings: {
    renderFooter(context: AgentLaunchFooterContext): Promise<string>;
    prepare(parameters?: JsonObject): Promise<AgentWorkspaceParameters>;
  };
  /** Runs once for a newly claimed session, before attachments and terminal launch. */
  prepareWorkspace?(workspaceId: string): Promise<void>;
  /** Session-local configuration; returned environment is passed only to its terminal. */
  prepareSession?(workspaceId: string, sessionId: string): Promise<Record<string, string>>;
  /** Revoke session credentials on startup failure and close. */
  closeSession?(workspaceId: string, sessionId: string): Promise<void>;
  /** Bash script with the CLI-specific flags and initial prompt. */
  launchScript(input: WorkspaceAgentInput, imagePaths: string[], settings: AgentWorkspaceParameters): string;
}
