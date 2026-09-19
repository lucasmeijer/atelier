import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtelierEventBus } from "@atelier/core";
import type { WorkspaceDockerPlan } from "@atelier/workspace";
import { registerWorkspaceProxyEvents } from "../src/egress/egress-proxy.ts";

test("workspace certificate defaults support modern Yarn without disabling TLS verification", async () => {
  const previousDataDir = process.env.ATELIER_DATA_DIR;
  const directory = await mkdtemp(join(tmpdir(), "atelier-proxy-env-"));
  process.env.ATELIER_DATA_DIR = directory;
  const plan: WorkspaceDockerPlan = { labels: {}, env: {}, mounts: [], preloadImages: [], extraArgs: [], initScripts: [], containerFiles: [], cleanup: [] };
  try {
    const events = createAtelierEventBus();
    registerWorkspaceProxyEvents(events);
    await events.emit("workspace_plan_prepare", { workspaceId: "certificate-defaults", workHostPath: "/tmp/work", workContainerPath: "/work", plan });

    expect(plan.env).not.toHaveProperty("YARN_CA_FILE");
    expect(plan.env.NODE_EXTRA_CA_CERTS).toBe("/run/atelier-mitm-ca.crt");
    expect(plan.mounts).toContainEqual({ type: "bind", source: join(process.env.ATELIER_DOCKER_HOST_DATA_DIR ?? directory, "proxy-ca", "atelier-mitm-ca.pem"), target: plan.env.NODE_EXTRA_CA_CERTS, readonly: true });
    expect(plan.initScripts).toContain("cat /run/atelier-mitm-ca.crt >> /etc/ssl/certs/ca-certificates.crt");
    expect(plan.env.NPM_CONFIG_CAFILE).toBe("/etc/ssl/certs/ca-certificates.crt");
    expect(plan.env).not.toHaveProperty("NODE_TLS_REJECT_UNAUTHORIZED");
    expect(plan.env).not.toHaveProperty("YARN_ENABLE_STRICT_SSL");
  } finally {
    for (const cleanup of plan.cleanup) await cleanup();
    if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
    else process.env.ATELIER_DATA_DIR = previousDataDir;
    await rm(directory, { recursive: true, force: true });
  }
});
