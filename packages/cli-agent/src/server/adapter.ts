import type { JsonObject } from "@atelier/core";
import type { AgentLaunchFooterContext, AgentWorkspaceParameters, WorkspaceAgentInput } from "@atelier/shared";

/** Identity of the session being launched, so adapters can address their session-local files. */
export interface CliAgentSession {
  id: string;
  /** Script the CLI must run at each turn boundary, already authorized for this session. */
  turnSignalCommand: string;
}

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
  prepareSession?(workspaceId: string, session: CliAgentSession, mcp: { url: string; token: string }): Promise<Record<string, string>>;
  /** Bash script with the CLI-specific flags and initial prompt. */
  launchScript(input: WorkspaceAgentInput, imagePaths: string[], settings: AgentWorkspaceParameters, session: CliAgentSession): string;
}
