export type WorkspaceCreationContext = Record<string, unknown>;

export interface WorkspaceCreatedEvent {
  workspaceId: string;
  context?: WorkspaceCreationContext;
}

export interface WorkspaceUserActivityEvent {
  workspaceId: string;
}

export interface WorkspaceTitleChangedEvent {
  workspaceId: string;
  title: string;
}

export interface WorkspaceImageBuildEvent {
  workspaceId: string;
  image: string;
  modules: string[];
  output: string;
  error?: string;
}

export interface AtelierEventMap {
  workspace_created: WorkspaceCreatedEvent;
  workspace_user_activity: WorkspaceUserActivityEvent;
  workspace_title_changed: WorkspaceTitleChangedEvent;
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
