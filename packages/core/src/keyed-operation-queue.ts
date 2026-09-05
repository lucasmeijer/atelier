/** Serialize operations for each key while allowing different keys to run independently.
 * A rejected operation still rejects its caller, but does not block later operations.
 * Each factory call owns an independent queue and releases idle keys.
 */
export function createKeyedOperationQueue() {
  const queues = new Map<string, Promise<void>>();
  return async function run<Result>(key: string, operation: () => Promise<Result>): Promise<Result> {
    const previous = queues.get(key) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(() => undefined, () => undefined);
    queues.set(key, settled);
    void settled.then(() => {
      if (queues.get(key) === settled) queues.delete(key);
    });
    return await result;
  };
}
