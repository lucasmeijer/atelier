import { commandSignal, waitForCommand, type AtelierEventBus } from "@atelier/core";

export interface DockerImageStoreWaitState {
  elapsedMs: number;
  owner: string;
  status: "waiting" | "acquired";
}

export interface DockerImageStoreOperation {
  label: string;
  onWait?: (state: DockerImageStoreWaitState) => Promise<void>;
}

export interface DockerImageStoreQueue {
  run<T>(operation: DockerImageStoreOperation, work: () => Promise<T>): Promise<T>;
}

export function workspaceImageStoreWaitReporter(options: { events?: AtelierEventBus; workspaceId?: string }): DockerImageStoreOperation["onWait"] {
  const { events, workspaceId } = options;
  if (!events || !workspaceId) return undefined;
  return async (state) => {
    const seconds = Math.max(0, Math.round(state.elapsedMs / 1000));
    await events.emit("workspace_provision_progress", {
      workspaceId,
      detail: state.status === "waiting" ? `Waiting for ${state.owner} · ${seconds}s elapsed` : `Continued after ${seconds}s`,
    });
  };
}

export function createDockerImageStoreQueue(options: { updateIntervalMs?: number; now?: () => number } = {}): DockerImageStoreQueue {
  const updateIntervalMs = options.updateIntervalMs ?? 1_000;
  const now = options.now ?? Date.now;
  let tail = Promise.resolve();
  let queued = 0;
  let current: DockerImageStoreOperation | undefined;

  return {
    async run<T>(operation: DockerImageStoreOperation, work: () => Promise<T>): Promise<T> {
      const previous = tail;
      const finished = Promise.withResolvers<void>();
      // A cancelled waiter can return immediately without letting the next turn
      // overtake its predecessor.
      tail = previous.then(() => finished.promise);
      const waits = queued > 0;
      queued += 1;
      const waitingStartedAt = now();
      let ready = false;
      void previous.then(() => { ready = true; });

      try {
        if (waits && operation.onWait) {
          while (!ready) {
            await operation.onWait({ status: "waiting", owner: current?.label ?? "Another workspace image operation", elapsedMs: now() - waitingStartedAt });
            await waitForCommand(Promise.race([previous, new Promise<void>((resolve) => setTimeout(resolve, updateIntervalMs))]));
          }
        }
        await waitForCommand(previous);
        current = operation;
        if (waits && operation.onWait) await operation.onWait({ status: "acquired", owner: operation.label, elapsedMs: now() - waitingStartedAt });
        commandSignal()?.throwIfAborted();
        return await work();
      } finally {
        if (current === operation) current = undefined;
        queued -= 1;
        finished.resolve();
      }
    },
  };
}

export const dockerImageStoreQueue = createDockerImageStoreQueue();
