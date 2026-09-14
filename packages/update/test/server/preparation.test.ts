import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectSelfUpdateRuntime, prepareUpdate, pullImageReference, type DockerImage, type PullProgress } from "../../src/server/docker.ts";

const app = `ghcr.io/lucasmeijer/atelier@sha256:${"a".repeat(64)}`;
const workspace = `ghcr.io/lucasmeijer/workspace@sha256:${"b".repeat(64)}`;
const appImage: DockerImage = { Id: "sha256:app", Config: { Labels: { "eagerly-preload": JSON.stringify([workspace, workspace]) } } };

test("prepares selected exact app and its declared workspace image before returning immutable ID", async () => {
  const calls: string[] = [];
  const progress: PullProgress[] = [];
  const result = await prepareUpdate(app, (event) => progress.push(event), {
    pull: async (reference, report) => { calls.push(`pull ${reference}`); report({ kind: "progress", percent: 40 }); },
    inspect: async (reference) => { calls.push(`inspect ${reference}`); return reference === app ? appImage : { Id: "sha256:workspace" }; },
  });
  expect(calls).toEqual([`pull ${app}`, `inspect ${app}`, `pull ${workspace}`, `inspect ${workspace}`]);
  expect(result).toEqual({ reference: app, imageId: "sha256:app" });
  expect(progress.map((event) => event.percent)).toEqual([20, 50, 70, 100]);
});
test("dependency preparation failure never reports completion and can retry the whole operation", async () => {
  let failure = true;
  const percentages: (number | undefined)[] = [];
  const deps = {
    pull: async (reference: string) => { if (reference === workspace && failure) throw new Error("registry unavailable"); },
    inspect: async () => appImage,
  };
  await expect(prepareUpdate(app, (event) => percentages.push(event.percent), deps)).rejects.toThrow("registry unavailable");
  expect(percentages).not.toContain(100);
  failure = false;
  expect((await prepareUpdate(app, () => {}, deps)).imageId).toBe("sha256:app");
});
test("malformed eagerly-preload labels fail before any dependency download", async () => {
  for (const value of ['{"image":"x"}', '[42]', '["--help"]', '["a b"]', 'not json']) {
    const pulls: string[] = [];
    await expect(prepareUpdate(app, () => {}, {
      pull: async (reference) => { pulls.push(reference); },
      inspect: async () => ({ Id: "sha256:app", Config: { Labels: { "eagerly-preload": value } } }),
    })).rejects.toThrow();
    expect(pulls).toEqual([app]);
  }
});
test("runtime detection only enables System's app container", async () => {
  for (const managed of [false, true]) {
    const runtime = await detectSelfUpdateRuntime(async (args) => ({ code: 0, stderr: "", stdout: JSON.stringify(args[0] === "inspect"
      ? [{ Image: "sha256:app", Config: { Labels: { "atelier.role": managed ? "app" : "workspace" } } }]
      : [{ Id: "sha256:app", RepoDigests: [app], Config: { Labels: { "org.opencontainers.image.revision": "revision" } } }]) }), async () => "container");
    if (managed) expect(runtime).toEqual({ currentRevision: "revision", currentDigest: app.split("@")[1] });
    else expect(runtime).toBeUndefined();
  }
});
test("Docker pull stream handles progress, exact references and embedded errors without uncaught exceptions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atelier-pull-"));
  const socket = join(directory, "docker.sock");
  let error = false;
  const server = createServer((request, response) => {
    expect(new URL(request.url!, "http://docker").searchParams.get("fromImage")).toBe(app);
    response.setHeader("content-type", "application/json");
    response.write(JSON.stringify({ id: "layer", status: "Downloading", progressDetail: { current: 25, total: 100 } }) + "\n");
    response.end(JSON.stringify(error ? { error: "image download denied" } : { id: "layer", status: "Pull complete" }));
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const events: PullProgress[] = [];
    await pullImageReference(app, (event) => events.push(event), socket);
    expect(events.map((event) => event.percent)).toEqual([25, 99, 100]);
    error = true;
    await expect(pullImageReference(app, () => {}, socket)).rejects.toThrow("image download denied");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
