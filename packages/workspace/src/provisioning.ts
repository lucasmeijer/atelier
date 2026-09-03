import type { AtelierEventBus } from "@atelier/core";
import type { WorkspaceCreationContext, WorkspaceServerProvisioningHook } from "@atelier/shared";

export type WorkspaceProvisionStepStatus = "pending" | "running" | "done" | "failed";

export interface WorkspaceProvisionTerminal {
  kind: "host-tmux";
  session: string;
}

export interface WorkspaceProvisionStepEvent {
  workspaceId: string;
  id: string;
  label?: string;
  status?: WorkspaceProvisionStepStatus;
  parentId?: string;
  detail?: string;
  output?: string;
  terminal?: WorkspaceProvisionTerminal;
  error?: string;
  awaitingContinue?: boolean;
}

declare module "@atelier/core" {
  interface AtelierEventMap {
    workspace_provision_step: WorkspaceProvisionStepEvent;
  }
}

export interface RunWorkspaceProvisioningHooksOptions {
  workspaceId: string;
  creationContext?: WorkspaceCreationContext;
  events?: AtelierEventBus;
  waitForContinue?(stepId: string): Promise<void>;
}

export async function runWorkspaceProvisioningHooks(hooks: WorkspaceServerProvisioningHook[], options: RunWorkspaceProvisioningHooksOptions): Promise<void> {
  for (const hook of hooks) {
    const event = { workspaceId: options.workspaceId, id: hook.id, label: hook.label, parentId: hook.parentId };
    await options.events?.emit("workspace_provision_step", { ...event, status: "running" });
    try {
      await hook.run({ workspaceId: options.workspaceId, creationContext: options.creationContext, events: options.events });
      await options.events?.emit("workspace_provision_step", { ...event, status: "done" });
    } catch (error) {
      const waitForContinue = hook.onFailure === "await-continue" ? options.waitForContinue : undefined;
      const continuation = waitForContinue?.(hook.id);
      await options.events?.emit("workspace_provision_step", {
        ...event,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        awaitingContinue: continuation !== undefined,
      });
      if (!continuation) throw error;
      await continuation;
      await options.events?.emit("workspace_provision_step", { ...event, status: "failed", detail: "Continuing despite this failure", awaitingContinue: false });
    }
  }
}
