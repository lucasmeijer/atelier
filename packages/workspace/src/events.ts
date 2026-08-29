import type { JsonObject } from "@atelier/core";
import type { WorkspaceCreationContext, WorkspaceDockerPlan, WorkspaceInitInstruction } from "./types.ts";

export interface WorkspaceCreatedEvent {
  workspaceId: string;
  init?: WorkspaceInitInstruction;
  context?: WorkspaceCreationContext;
}

export interface WorkspaceDeletedEvent {
  workspaceId: string;
}

export interface WorkspaceDeleteInspectEvent {
  workspaceId: string;
  issues: JsonObject[];
}

export interface WorkspaceUserActivityEvent {
  workspaceId: string;
}

export interface WorkspaceTitleChangedEvent {
  workspaceId: string;
  title: string;
}

export interface WorkspaceAgentTurnFinishedEvent {
  workspaceId: string;
  conversationId: string;
}

export interface WorkspaceAgentViewInvalidatedEvent {
  workspaceId: string;
  conversationId: string;
  exceptConnectionId?: string;
  /** Narrow authoritative mutation for retained visible panes. */
  html?: string;
}

export interface WorkspaceAgentPromptPreparingEvent {
  workspaceId: string;
  reviewCommentIds: string[];
  sections: string[];
}

export interface WorkspaceAgentPromptSubmittedEvent {
  workspaceId: string;
  reviewCommentIds: string[];
}

export interface WorkspaceViewUnreadEvent {
  workspaceId: string;
  viewKey: string;
  unread: boolean;
}

export interface WorkspaceSourcePrepareEvent {
  workspaceId: string;
  init?: WorkspaceInitInstruction;
  context?: WorkspaceCreationContext;
  workHostPath: string;
  workContainerPath: string;
}

export interface WorkspacePlanPrepareEvent extends WorkspaceSourcePrepareEvent {
  plan: WorkspaceDockerPlan;
}

declare module "@atelier/core" {
  interface AtelierEventMap {
    workspace_source_prepare: WorkspaceSourcePrepareEvent;
    workspace_plan_prepare: WorkspacePlanPrepareEvent;
    workspace_created: WorkspaceCreatedEvent;
    workspace_deleted: WorkspaceDeletedEvent;
    workspace_delete_inspect: WorkspaceDeleteInspectEvent;
    workspace_user_activity: WorkspaceUserActivityEvent;
    workspace_title_changed: WorkspaceTitleChangedEvent;
    workspace_agent_turn_finished: WorkspaceAgentTurnFinishedEvent;
    workspace_agent_view_invalidated: WorkspaceAgentViewInvalidatedEvent;
    workspace_agent_prompt_preparing: WorkspaceAgentPromptPreparingEvent;
    workspace_agent_prompt_submitted: WorkspaceAgentPromptSubmittedEvent;
    workspace_view_unread: WorkspaceViewUnreadEvent;
  }
}
