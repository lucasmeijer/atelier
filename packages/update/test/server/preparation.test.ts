import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectSelfUpdateRuntime, prepareUpdate, pullImageReference, type DockerImage, type PullProgress, type PullLayerProgress } from "../../src/server/docker.ts";

const app = `ghcr.io/lucasmeijer/atelier@sha256:${"a".repeat(64)}`;
const workspace = `ghcr.io/lucasmeijer/workspace@sha256:${"b".repeat(64)}`;
const appImage: DockerImage = { Id: "sha256:app" };

const layerA = `sha256:${"c".repeat(64)}`;
const layerB = `sha256:${"d".repeat(64)}`;
const resolve = async (reference: string) => ({ reference, dependencies: reference === app ? [workspace, workspace] : [], layers: reference === app ? [{ digest: layerA, size: 100 }] : [{ digest: layerA, size: 100 }, { digest: layerB, size: 300 }] });

test("discovers everything before pulling and weights unique layer bytes", async () => {
  const calls: string[] = [];
  const progress: PullProgress[] = [];
  const result = await prepareUpdate(app, (event) => progress.push(event), {
    resolve: async (reference) => { calls.push(`resolve ${reference}`); return resolve(reference); },
    pull: async (reference, report) => {
      calls.push(`pull ${reference}`);
      report({ id: (reference === app ? layerA : layerB).slice(7, 19), current: 100, complete: false });
    },
    inspect: async (reference) => { calls.push(`inspect ${reference}`); return reference === app ? appImage : { Id: "sha256:workspace" }; },
  });
  expect(calls).toEqual([`resolve ${app}`, `resolve ${workspace}`, `pull ${app}`, `pull ${workspace}`, `inspect ${app}`, `inspect ${workspace}`]);
  expect(result).toEqual({ reference: app, imageId: "sha256:app" });
  expect(progress.map((event) => event.percent)).toEqual([undefined, 0, 25, 25, 50, 99, 99, 100]);
});
test("dependency failure never reports completion and can retry", async () => {
  let failure = true;
  const percentages: (number | undefined)[] = [];
  const deps = {
    resolve,
    pull: async (reference: string) => { if (reference === workspace && failure) throw new Error("registry unavailable"); },
    inspect: async () => appImage,
  };
  await expect(prepareUpdate(app, (event) => percentages.push(event.percent), deps)).rejects.toThrow("registry unavailable");
  expect(percentages).not.toContain(100);
  failure = false;
  expect((await prepareUpdate(app, () => {}, deps)).imageId).toBe("sha256:app");
});
test("discovery failure prevents all downloads", async () => {
  const pulls: string[] = [];
  await expect(prepareUpdate(app, () => {}, {
    resolve: async (reference) => { if (reference === workspace) throw new Error("bad dependency"); return resolve(reference); },
    pull: async (reference) => { pulls.push(reference); },
  })).rejects.toThrow("bad dependency");
  expect(pulls).toEqual([]);
});
test("cached layers count once and extraction cannot regress progress", async () => {
  const percentages: number[] = [];
  await prepareUpdate(app, (event) => { if (event.percent !== undefined) percentages.push(event.percent); }, {
    resolve,
    pull: async (_reference, report) => {
      report({ id: layerA.slice(7, 19), complete: true });
      report({ id: layerA.slice(7, 19), current: 0, complete: false });
    },
    inspect: async () => appImage,
  });
  expect(percentages[1]).toBe(25);
  expect(percentages).toEqual([...percentages].sort((a, b) => a - b));
});
test("verification failure never reports ready", async () => {
  const percentages: (number | undefined)[] = [];
  await expect(prepareUpdate(app, (event) => percentages.push(event.percent), {
    resolve, pull: async () => {}, inspect: async () => { throw new Error("missing image"); },
  })).rejects.toThrow("missing image");
  expect(percentages).not.toContain(100);
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
    const events: PullLayerProgress[] = [];
    await pullImageReference(app, (event) => events.push(event), socket);
    expect(events).toEqual([
      { id: "layer", current: 25, complete: false },
      { id: "layer", current: undefined, complete: true },
    ]);
    error = true;
    await expect(pullImageReference(app, () => {}, socket)).rejects.toThrow("image download denied");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("deduplicates dependency cycles and restores mutable names only after verification", async () => {
  const alias = "ghcr.io/lucasmeijer/workspace:stable";
  const calls: string[] = [];
  const percentages: (number | undefined)[] = [];
  let tagFails = false;
  const deps = {
    resolve: async (reference: string) => {
      calls.push(`resolve ${reference}`);
      return { reference: reference === app ? app : workspace, layers: [], dependencies: reference === app ? [alias, workspace] : [app] };
    },
    pull: async (reference: string) => { calls.push(`pull ${reference}`); },
    inspect: async (reference: string) => { calls.push(`inspect ${reference}`); return appImage; },
    exec: async (args: string[]) => {
      calls.push(args.join(" "));
      return { code: tagFails ? 1 : 0, stdout: "", stderr: tagFails ? "tag failed" : "" };
    },
  };
  await prepareUpdate(app, () => {}, deps);
  expect(calls).toEqual([
    `resolve ${app}`, `resolve ${alias}`, `resolve ${workspace}`,
    `pull ${app}`, `pull ${workspace}`, `inspect ${app}`, `inspect ${workspace}`,
    `image tag ${workspace} ${alias}`,
  ]);
  tagFails = true;
  await expect(prepareUpdate(app, (event) => percentages.push(event.percent), deps)).rejects.toThrow("tag failed");
  expect(percentages).not.toContain(100);
});
