export interface AtelierEventMap {}

export type AtelierEventHandler<K extends keyof AtelierEventMap> = (event: AtelierEventMap[K]) => void | Promise<void>;

export interface AtelierEventBus {
  on<K extends keyof AtelierEventMap>(eventName: K, handler: AtelierEventHandler<K>): () => void;
  emit<K extends keyof AtelierEventMap>(eventName: K, event: AtelierEventMap[K]): Promise<void>;
}

export function createAtelierEventBus(): AtelierEventBus {
  const handlers = new Map<keyof AtelierEventMap, Set<AtelierEventHandler<any>>>();

  return {
    on(eventName, handler) {
      const eventHandlers = handlers.get(eventName) ?? new Set<AtelierEventHandler<typeof eventName>>();
      handlers.set(eventName, eventHandlers);
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },

    async emit(eventName, event) {
      const eventHandlers = handlers.get(eventName);
      if (!eventHandlers) return;
      for (const handler of eventHandlers) {
        await handler(event);
      }
    },
  };
}
