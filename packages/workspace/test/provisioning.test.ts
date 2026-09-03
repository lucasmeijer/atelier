import { describe, expect, test } from "bun:test";
import { createAtelierEventBus } from "@atelier/core";
import type { WorkspaceServerProvisioningHook } from "@atelier/shared";
import { runWorkspaceProvisioningHooks, workspaceSetupProvisioningHook } from "@atelier/workspace";

describe("workspace provisioning hooks", () => {
  test("waits for confirmation before continuing after a recoverable hook fails", async () => {
    const events = createAtelierEventBus();
    const observed: Array<{ id: string; status?: string; error?: string; awaitingContinue?: boolean }> = [];
    const ran: string[] = [];
    let continueProvisioning!: () => void;
    events.on("workspace_provision_step", (event) => { observed.push(event); });
    const hooks: WorkspaceServerProvisioningHook[] = [
      {
        id: "recoverable",
        label: "Recoverable step",
        onFailure: "await-continue",
        run() {
          throw new Error("project dependency setup failed");
        },
      },
      {
        id: "next",
        label: "Next step",
        run() {
          ran.push("next");
        },
      },
    ];

    const provisioning = runWorkspaceProvisioningHooks(hooks, {
      workspaceId: "workspace-1",
      events,
      waitForContinue: async () => await new Promise<void>((resolve) => { continueProvisioning = resolve; }),
    });
    while (!observed.some((event) => event.awaitingContinue)) await Bun.sleep(1);

    expect(ran).toEqual([]);
    expect(observed).toContainEqual(expect.objectContaining({ id: "recoverable", status: "failed", error: "project dependency setup failed", awaitingContinue: true }));

    continueProvisioning();
    await provisioning;

    expect(ran).toEqual(["next"]);
    expect(observed).toContainEqual(expect.objectContaining({ id: "recoverable", status: "failed", awaitingContinue: false }));
    expect(observed).toContainEqual(expect.objectContaining({ id: "next", status: "done" }));
  });

  test("aborts provisioning after a required hook fails", async () => {
    const ran: string[] = [];
    const hooks: WorkspaceServerProvisioningHook[] = [
      { id: "required", label: "Required step", run() { throw new Error("required failure"); } },
      { id: "next", label: "Next step", run() { ran.push("next"); } },
    ];

    await expect(runWorkspaceProvisioningHooks(hooks, { workspaceId: "workspace-1" })).rejects.toThrow("required failure");
    expect(ran).toEqual([]);
  });

  test("requires confirmation when repository setup fails", () => {
    expect(workspaceSetupProvisioningHook.onFailure).toBe("await-continue");
  });
});
