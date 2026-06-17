export type WorkspaceCreationContext = Record<string, unknown>;

export interface WorkspaceDockerMount {
  type: "bind" | "volume";
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


export interface AtelierEventMap {}

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
