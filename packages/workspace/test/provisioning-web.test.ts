import { describe, expect, test } from "bun:test";
import { createWorkspaceProvisioningStore } from "../src/server/provisioning-web";

describe("workspace provisioning presentation", () => {
  test("renders seeded steps as a design-system status list", () => {
    const store = createWorkspaceProvisioningStore({
      onChange() {},
      seedSteps: [{ id: "workspace.setup", label: "Run project setup" }],
    });

    store.seed("workspace-1");
    const html = store.render("workspace-1");

    expect(html).not.toContain("Preparing workspace</h2>");
    expect(html).not.toContain("Workspace setup is running.");
    expect(html).toContain('role="checkbox" aria-checked="false"');
    expect(html).toContain('<span class="status-list__marker"></span>');
    expect(html).toContain("Create workspace directory");
    expect(html).toContain("Run project setup");
    expect(html).toContain("Run workspace startup integrations");
  });

  test("places conditional image preparation steps before container startup", () => {
    const store = createWorkspaceProvisioningStore({ onChange() {}, seedSteps: [] });
    store.seed("workspace-1");
    store.apply({ workspaceId: "workspace-1", id: "workspace.docker-images", label: "Resolve nested Docker images", status: "done" });
    store.apply({ workspaceId: "workspace-1", id: "workspace.image-carrier", label: "Prepare preloaded workspace image", status: "running" });

    const html = store.render("workspace-1");

    expect(html.indexOf("Resolve nested Docker images")).toBeLessThan(html.indexOf("Prepare preloaded workspace image"));
    expect(html.indexOf("Prepare preloaded workspace image")).toBeLessThan(html.indexOf("Start workspace container"));
  });

  test("renders running, complete, failed, and terminal states semantically", () => {
    const store = createWorkspaceProvisioningStore({ onChange() {}, seedSteps: [] });
    store.apply({ workspaceId: "workspace-1", id: "done", label: "Done", status: "done", output: "Finished output", terminal: { kind: "host-tmux", session: "finished-session" } });
    store.apply({ workspaceId: "workspace-1", id: "running", label: "Running", status: "running", terminal: { kind: "host-tmux", session: "setup-session" } });
    store.apply({ workspaceId: "workspace-1", id: "failed", label: "Failed", status: "failed", error: "Nope" });

    const html = store.render("workspace-1");

    expect(html).toContain('role="checkbox" aria-checked="true"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('data-status="failed"');
    expect(html).toContain('data-provision-terminal-session-value="setup-session"');
    expect(html).not.toContain("finished-session");
    expect(html).toContain("View output");
    expect(html).toContain('aria-label="Failed"');
  });

  test("shows running output directly instead of hiding it behind a disclosure", () => {
    const store = createWorkspaceProvisioningStore({ onChange() {}, seedSteps: [] });
    store.apply({ workspaceId: "workspace-1", id: "workspace.image-carrier", label: "Prepare preloaded workspace image", status: "running", output: "Loading nested Docker images…\n" });

    const html = store.render("workspace-1");

    expect(html).toContain("Loading nested Docker images…");
    expect(html).not.toContain("View output");
  });
});
