export type WorkspaceCreationContext = Record<string, unknown>;

export interface WorkspaceCreatedEvent {
  workspaceId: string;
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

export interface WorkspaceImageBuildEvent {
  workspaceId: string;
  image: string;
  modules: string[];
  output: string;
  error?: string;
}

export interface WorkspaceDockerMount {
  type: "bind";
  source: string;
  target: string;
  readonly?: boolean;
}

export interface WorkspaceDockerPlan {
  image?: string;
  labels: Record<string, string>;
  env: Record<string, string>;
  mounts: WorkspaceDockerMount[];
  publishes: number[];
  extraArgs: string[];
  initScripts: string[];
  cleanup: Array<() => Promise<void> | void>;
}


export interface WorkspaceSourcePrepareEvent {
  workspaceId: string;
  context?: WorkspaceCreationContext;
  workHostPath: string;
  workContainerPath: string;
}

export interface WorkspacePlanPrepareEvent extends WorkspaceSourcePrepareEvent {
  plan: WorkspaceDockerPlan;
}

export interface AtelierEventMap {
  workspace_source_prepare: WorkspaceSourcePrepareEvent;
  workspace_plan_prepare: WorkspacePlanPrepareEvent;
  workspace_created: WorkspaceCreatedEvent;
  workspace_deleted: WorkspaceDeletedEvent;
  workspace_delete_inspect: WorkspaceDeleteInspectEvent;
  workspace_user_activity: WorkspaceUserActivityEvent;
  workspace_title_changed: WorkspaceTitleChangedEvent;
  workspace_tabs_changed: WorkspaceTabsChangedEvent;
  workspace_agent_turn_finished: WorkspaceAgentTurnFinishedEvent;
  workspace_image_build_started: WorkspaceImageBuildEvent;
  workspace_image_build_output: WorkspaceImageBuildEvent;
  workspace_image_build_finished: WorkspaceImageBuildEvent;
}

export interface AtelierEventContext {
  eventName: keyof AtelierEventMap;
}

export type AtelierEventHandler<K extends keyof AtelierEventMap> = (
  event: AtelierEventMap[K],
  context: AtelierEventContext & { eventName: K },
) => void | Promise<void>;

export interface AtelierEventBus {
  on<K extends keyof AtelierEventMap>(eventName: K, handler: AtelierEventHandler<K>): () => void;
  emit<K extends keyof AtelierEventMap>(eventName: K, event: AtelierEventMap[K]): Promise<void>;
}

export function createAtelierEventBus(): AtelierEventBus {
  const handlers = new Map<keyof AtelierEventMap, Set<AtelierEventHandler<any>>>();

  return {
    on(eventName, handler) {
      let eventHandlers = handlers.get(eventName);
      if (!eventHandlers) {
        eventHandlers = new Set();
        handlers.set(eventName, eventHandlers);
      }
      eventHandlers.add(handler);
      return () => eventHandlers?.delete(handler);
    },

    async emit(eventName, event) {
      const eventHandlers = handlers.get(eventName);
      if (!eventHandlers) return;
      const context = { eventName } as AtelierEventContext & { eventName: typeof eventName };
      for (const handler of eventHandlers) {
        await handler(event, context);
      }
    },
  };
}
