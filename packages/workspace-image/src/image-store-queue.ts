import type { AtelierEventBus } from "@atelier/core";

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

function elapsedDetail(label: string, elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000));
  return `${label} · ${seconds}s elapsed`;
}

export function workspaceImageStoreWaitReporter(options: { events?: AtelierEventBus; workspaceId?: string; parentId: string }): DockerImageStoreOperation["onWait"] {
  const { events, workspaceId } = options;
  if (!events || !workspaceId) return undefined;
  return async (state) => {
    await events.emit("workspace_provision_step", {
      workspaceId,
      id: "workspace.image-maintenance",
      label: "Wait for workspace image maintenance",
      parentId: options.parentId,
      status: state.status === "waiting" ? "running" : "done",
      detail: state.status === "waiting" ? elapsedDetail(state.owner, state.elapsedMs) : `Continued after ${Math.max(0, Math.round(state.elapsedMs / 1000))}s`,
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
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      const waits = queued > 0;
      queued += 1;
      const waitingStartedAt = now();
      let ready = false;
      let acquired = false;
      void previous.then(() => { ready = true; });

      try {
        if (waits && operation.onWait) {
          while (!ready) {
            await operation.onWait({ status: "waiting", owner: current?.label ?? "Another workspace image operation", elapsedMs: now() - waitingStartedAt });
            await Promise.race([previous, new Promise<void>((resolve) => setTimeout(resolve, updateIntervalMs))]);
          }
        }
        await previous;
        acquired = true;
        current = operation;
        if (waits && operation.onWait) await operation.onWait({ status: "acquired", owner: operation.label, elapsedMs: now() - waitingStartedAt });
        return await work();
      } finally {
        if (!acquired) await previous;
        if (current === operation) current = undefined;
        queued -= 1;
        release();
      }
    },
  };
}

export const dockerImageStoreQueue = createDockerImageStoreQueue();
