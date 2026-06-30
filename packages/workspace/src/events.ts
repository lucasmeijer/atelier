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
  issues: unknown[];
}

export interface WorkspaceUserActivityEvent {
  workspaceId: string;
}

export interface WorkspaceTitleChangedEvent {
  workspaceId: string;
  title: string;
}

export interface WorkspaceTabsChangedEvent {
  workspaceId: string;
}

export interface WorkspaceAgentTurnFinishedEvent {
  workspaceId: string;
  agentLabel: string;
}

export interface WorkspaceTabUnreadEvent {
  workspaceId: string;
  tabKey: string;
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
    workspace_tabs_changed: WorkspaceTabsChangedEvent;
    workspace_agent_turn_finished: WorkspaceAgentTurnFinishedEvent;
    workspace_tab_unread: WorkspaceTabUnreadEvent;
  }
}
