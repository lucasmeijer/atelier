import { randomUUID } from "node:crypto";
import { invalidArguments } from "@atelier/core";

export type PendingApproval<Details> = Details & { id: string; workspaceId: string };
type Waiting<Details, Result> = PendingApproval<Details> & {
  resolve(result: Result): void;
  reject(error: Error): void;
  submitting: boolean;
};

/** Owns the lifetime of a user decision, independent of the setting being approved. */
export function createApprovalRequests<Details, Result>(changed: (workspaceId: string) => void) {
  const pending = new Map<string, Waiting<Details, Result>>();
  function forWorkspace(workspaceId: string) {
    return [...pending.values()].find((request) => request.workspaceId === workspaceId);
  }
  function byId(id: string) {
    const request = pending.get(id);
    if (!request) throw invalidArguments("This request is no longer active. Ask the agent to request it again.");
    return request;
  }
  return {
    forWorkspace(workspaceId: string): PendingApproval<Details> | undefined { return forWorkspace(workspaceId); },
    byId(id: string): PendingApproval<Details> { return byId(id); },
    async wait(workspaceId: string, details: Details, signal?: AbortSignal): Promise<Result> {
      signal?.throwIfAborted();
      if (forWorkspace(workspaceId)) throw invalidArguments("Finish the current request before requesting another setting.");
      const id = randomUUID();
      const result = Promise.withResolvers<Result>();
      pending.set(id, { ...details, id, workspaceId, resolve: result.resolve, reject: result.reject, submitting: false });
      const abort = () => result.reject(new Error("Setting request cancelled. No user decision was received."));
      signal?.addEventListener("abort", abort, { once: true });
      try {
        changed(workspaceId);
        return await result.promise;
      } finally {
        signal?.removeEventListener("abort", abort);
        pending.delete(id);
        changed(workspaceId);
      }
    },
    async answer(id: string, save: (request: PendingApproval<Details>) => Promise<Result>): Promise<Result> {
      const request = byId(id);
      if (request.submitting) throw invalidArguments("This setting is already being saved.");
      request.submitting = true;
      try {
        const result = await save(request);
        request.resolve(result);
        return result;
      } finally {
        request.submitting = false;
      }
    },
    cancelWorkspace(workspaceId: string): void {
      forWorkspace(workspaceId)?.reject(new Error("The workspace was removed before the setting request was answered."));
    },
  };
}
