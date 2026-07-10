import { mkdir, rmdir } from "node:fs/promises";
import { dirname } from "node:path";

export function createProcessFileLock(options: { lockDir(): string; label: string }): <T>(fn: () => Promise<T>) => Promise<T> {
  let processLock: Promise<void> = Promise.resolve();

  return async function withProcessFileLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = processLock;
    let releaseProcessLock!: () => void;
    processLock = new Promise<void>((resolve) => { releaseProcessLock = resolve; });
    await previous;

    let releaseFileLock: (() => Promise<void>) | undefined;
    try {
      releaseFileLock = await acquireFileLock(options.lockDir(), options.label);
      return await fn();
    } finally {
      await releaseFileLock?.();
      releaseProcessLock();
    }
  };
}

async function acquireFileLock(lockDir: string, label: string): Promise<() => Promise<void>> {
  await mkdir(dirname(lockDir), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      return async () => { await rmdir(lockDir); };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label} lock: ${lockDir}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
