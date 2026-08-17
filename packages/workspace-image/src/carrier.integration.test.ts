import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireDocker, runDocker } from "@atelier/core";
import { buildWorkspaceImageCarrier, nativeLinuxDockerPlatform } from "./carrier.ts";
import { nestedDockerDaemonInitScript, resolveDockerImagePreload } from "./index.ts";

setDefaultTimeout(15 * 60_000);
// Deliberately opt-in: this builds a nested-Docker base and a carrier.
const carrierIntegrationTest = process.env.ATELIER_RUN_CARRIER_INTEGRATION === "1" ? test : test.skip;

test("nested Docker serializes registry uploads", () => {
  expect(nestedDockerDaemonInitScript()).toContain("--max-concurrent-uploads=1");
});

carrierIntegrationTest("native Linux carriers are reusable and give workspaces isolated writable stores", async () => {
  const platform = await nativeLinuxDockerPlatform();
  if (!platform) throw new Error("ATELIER_RUN_CARRIER_INTEGRATION requires a native Linux Docker Engine");
  const directory = await mkdtemp(join(tmpdir(), "atelier-carrier-test-"));
  const base = `atelier-carrier-test-base:${crypto.randomUUID().slice(0, 8)}`;
  const containers = [`atelier-carrier-test-a-${crypto.randomUUID().slice(0, 8)}`, `atelier-carrier-test-b-${crypto.randomUUID().slice(0, 8)}`];
  let carrierImage: string | undefined;
  try {
    await writeFile(join(directory, "Dockerfile"), `FROM ubuntu:26.04\nARG DEBIAN_FRONTEND=noninteractive\nRUN apt-get update && apt-get install -y --no-install-recommends docker.io fuse-overlayfs ca-certificates && rm -rf /var/lib/apt/lists/*\nRUN mkdir -p /.atelier /var/lib/docker\n`);
    await requireDocker(["build", "--tag", base, directory]);
    const resolution = { image: base, defaultImage: base };
    const preload = await resolveDockerImagePreload({ specs: ["ubuntu:24.04"], workspaceResolution: resolution });
    const first = await buildWorkspaceImageCarrier({ baseImage: base, baseIdentity: base, platform, preload });
    carrierImage = first.image;
    const second = await buildWorkspaceImageCarrier({ baseImage: base, baseIdentity: base, platform, preload });
    expect(second.image).toBe(first.image);
    expect(second.kind).toBe("local hit");

    for (const container of containers) {
      await requireDocker(["run", "--detach", "--name", container, "--privileged", first.image, "sh", "-lc", "sleep infinity"]);
      await requireDocker(["exec", container, "sh", "-lc", nestedDockerDaemonInitScript()]);
      await requireDocker(["exec", container, "docker", "image", "inspect", "ubuntu:24.04"]);
      await requireDocker(["exec", container, "docker", "run", "--rm", "--entrypoint", "/bin/true", "ubuntu:24.04"]);
    }
    await requireDocker(["exec", containers[0]!, "docker", "pull", "alpine:3.22"]);
    const absent = await runDocker(["exec", containers[1]!, "docker", "image", "inspect", "alpine:3.22"]);
    expect(absent.exitCode).not.toBe(0);
  } finally {
    await runDocker(["rm", "-f", ...containers]);
    if (carrierImage) await runDocker(["image", "rm", "-f", carrierImage]);
    await runDocker(["image", "rm", "-f", base]);
    await rm(directory, { recursive: true, force: true });
  }
});
