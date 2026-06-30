import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { parseContainerIdFromCgroup, parseContainerIdFromMountInfo, pullChannelImage, replacementCreateArgs, type DockerInspect, type SelfUpdateRuntime } from "../../src/server/docker.ts";
import { createUpdateRouteHandler, UpdateManager } from "../../src/server/index.ts";
import { parseWwwAuthenticate, selectManifestFromIndex, fetchChannelImageMetadata } from "../../src/server/registry.ts";
import { fetchReleaseNotes, releaseNoteFilenames, renderMarkdown } from "../../src/server/release-notes.ts";

describe("self container parsing", () => {
  test("parses cgroup v1 docker ids", () => {
    const id = "a".repeat(64);
    expect(parseContainerIdFromCgroup(`12:cpu:/docker/${id}\n`)).toBe(id);
  });

  test("parses cgroup v2 docker scope ids", () => {
    const id = "b".repeat(64);
    expect(parseContainerIdFromCgroup(`0::/system.slice/docker-${id}.scope\n`)).toBe(id);
  });

  test("returns undefined outside a container", () => {
    expect(parseContainerIdFromCgroup("0::/user.slice/user-501.slice/session.scope\n")).toBeUndefined();
  });

  test("parses container id from mountinfo when cgroup v2 is namespaced", () => {
    const id = "c".repeat(64);
    expect(parseContainerIdFromMountInfo(`451 439 8:1 /var/lib/docker/containers/${id}/hostname /etc/hostname rw,relatime - ext4 /dev/sda1 rw\n`)).toBe(id);
  });
});

function runtime(currentRevision = "old"): SelfUpdateRuntime {
  return {
    containerId: "container-id",
    imageId: "sha256:old-image",
    releaseChannel: "stable",
    currentRevision,
    currentDigest: "sha256:old-digest",
    container: { Id: "container-id", Image: "sha256:old-image", Config: { Image: "ghcr.io/lucasmeijer/atelier:stable", Labels: { "com.atelier.type": "server" } } },
  };
}

function context() {
  const sidebar: string[] = [];
  return {
    sidebar,
    ctx: {
      events: {},
      registry: { setTabBusy: () => {}, setTabUnread: () => {} },
      workspaceRowContributions: { set: () => {} },
      globalSidebarContributions: { set: (_id: string, html?: string) => sidebar.push(html ?? "") },
      layouts: {},
      getTabKeys: async () => [],
      deleteCurrentWorkspace: async () => ({ deleted: false, blocked: false }),
      createWorkspaceFromAgent: async () => ({ id: "workspace-id", url: "/workspaces/workspace-id", phase: "starting" as const }),
      registerSocketHandler: () => {},
      registerWorkspaceAppHandler: () => {},
      registerProvisioningHook: () => {},
      onWorkspaceRemoved: () => {},
    },
  };
}

function noInterval(): typeof setInterval {
  return (() => ({ unref() {} })) as unknown as typeof setInterval;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("registry helpers", () => {
  test("parses bearer auth challenge", () => {
    expect(parseWwwAuthenticate('Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:lucasmeijer/atelier:pull"')).toEqual({
      realm: "https://ghcr.io/token",
      service: "ghcr.io",
      scope: "repository:lucasmeijer/atelier:pull",
    });
  });

  test("fetches config labels through public GHCR token auth flow", async () => {
    const calls: string[] = [];
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/manifests/stable") && calls.filter((call) => call === url).length === 1) {
        return new Response("", { status: 401, headers: { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:lucasmeijer/atelier:pull"' } });
      }
      if (url.startsWith("https://ghcr.io/token")) return Response.json({ token: "token" });
      if (url.endsWith("/manifests/stable")) return Response.json({ config: { digest: "sha256:config" } }, { headers: { "docker-content-digest": "sha256:manifest" } });
      if (url.endsWith("/blobs/sha256:config")) return Response.json({ config: { Labels: { "org.opencontainers.image.revision": "new" } } });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    await expect(fetchChannelImageMetadata("stable", fetcher)).resolves.toEqual({ digest: "sha256:manifest", platformDigest: undefined, revision: "new" });
  });

  test("selects current linux platform manifest", () => {
    expect(selectManifestFromIndex({ manifests: [
      { digest: "sha256:arm", platform: { os: "linux", architecture: "arm64" } },
      { digest: "sha256:amd", platform: { os: "linux", architecture: "amd64" } },
    ] }, { os: "linux", architecture: "amd64" })).toBe("sha256:amd");
  });
});

describe("release notes", () => {
  test("includes only added markdown release notes in filename order", () => {
    expect(releaseNoteFilenames([
      { filename: "release_notes/assets/demo.mp4", status: "added" },
      { filename: "release_notes/002.md", status: "modified" },
      { filename: "release_notes/003.md", status: "added" },
      { filename: "release_notes/001.md", status: "added" },
      { filename: "docs/release_notes/000.md", status: "added" },
    ])).toEqual(["release_notes/001.md", "release_notes/003.md"]);
  });

  test("fetches added release notes from compare API and raw GitHub", async () => {
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("/compare/old...new")) return Response.json({ files: [
        { filename: "release_notes/002.md", status: "added" },
        { filename: "release_notes/assets/demo.mp4", status: "added" },
        { filename: "release_notes/001.md", status: "added" },
        { filename: "release_notes/changed.md", status: "modified" },
      ] });
      if (url.endsWith("/release_notes/001.md")) return new Response("# One");
      if (url.endsWith("/release_notes/002.md")) return new Response("# Two");
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const html = await fetchReleaseNotes("old", "new", fetcher);
    expect(html.indexOf("<h1>One</h1>")).toBeLessThan(html.indexOf("<h1>Two</h1>"));
    expect(html).not.toContain("changed");
  });

  test("renders safe markdown and rewrites relative video media", () => {
    const html = renderMarkdown(`# Hello\n\n<script>x</script>\n\n- one\n- ![Demo](./assets/demo.mp4)\n\n[site](https://example.com)`, "release_notes/001.md", "abc123");
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).toContain("<ul><li>one</li><li><video controls playsinline src=\"https://raw.githubusercontent.com/lucasmeijer/atelier/abc123/release_notes/assets/demo.mp4\"");
    expect(html).toContain('<a href="https://example.com"');
  });
});

describe("update state machine", () => {
  test("idle -> available -> pulling -> ready", async () => {
    const { ctx, sidebar } = context();
    const manager = new UpdateManager({
      detectRuntime: async () => runtime("old"),
      fetchMetadata: async () => ({ digest: "sha256:new", revision: "new" }),
      pullImage: async (_channel, onProgress) => { onProgress({ kind: "progress", percent: 43 }); },
      setInterval: noInterval(),
    });
    await manager.initialize(ctx);
    expect(manager.snapshot().state).toBe("available");
    await manager.startPull();
    expect(manager.snapshot().state).toBe("ready_to_restart");
    expect(manager.snapshot().percent).toBe(100);
    expect(sidebar.join("\n")).toContain("Restart to update");
  });

  test("pull failure -> failed -> retry succeeds", async () => {
    const { ctx } = context();
    let fail = true;
    const manager = new UpdateManager({
      detectRuntime: async () => runtime("old"),
      fetchMetadata: async () => ({ digest: "sha256:new", revision: "new" }),
      pullImage: async () => { if (fail) throw new Error("network down"); },
      setInterval: noInterval(),
    });
    await manager.initialize(ctx);
    await manager.startPull();
    expect(manager.snapshot().state).toBe("failed");
    expect(manager.snapshot().error).toBe("network down");
    fail = false;
    await manager.startPull();
    expect(manager.snapshot().state).toBe("ready_to_restart");
  });

  test("concurrent pull requests attach to the same task", async () => {
    const { ctx } = context();
    const gate = deferred();
    let pulls = 0;
    const manager = new UpdateManager({
      detectRuntime: async () => runtime("old"),
      fetchMetadata: async () => ({ digest: "sha256:new", revision: "new" }),
      pullImage: async () => { pulls += 1; await gate.promise; },
      setInterval: noInterval(),
    });
    await manager.initialize(ctx);
    const first = manager.startPull();
    const second = manager.startPull();
    gate.resolve();
    await Promise.all([first, second]);
    expect(pulls).toBe(1);
  });

  test("ready state auto-pulls a newer stable digest", async () => {
    const { ctx } = context();
    const metadata = [{ digest: "sha256:new1", revision: "new1" }, { digest: "sha256:new2", revision: "new2" }];
    let pulls = 0;
    const manager = new UpdateManager({
      detectRuntime: async () => runtime("old"),
      fetchMetadata: async () => metadata.shift()!,
      pullImage: async () => { pulls += 1; },
      setInterval: noInterval(),
    });
    await manager.initialize(ctx);
    await manager.startPull();
    await manager.checkNow();
    expect(pulls).toBe(2);
    expect(manager.snapshot().state).toBe("ready_to_restart");
  });

  test("switching release channels invalidates status and persists the selected target", async () => {
    const previousDataDir = process.env.ATELIER_DATA_DIR;
    const dataDir = await mkdtemp(join(tmpdir(), "atelier-update-test-"));
    process.env.ATELIER_DATA_DIR = dataDir;
    try {
      const { ctx } = context();
      const channels: string[] = [];
      const manager = new UpdateManager({
        detectRuntime: async () => runtime("old"),
        fetchMetadata: async (channel) => {
          channels.push(channel);
          return channel === "stable" ? { digest: "sha256:old-digest", revision: "old" } : { digest: "sha256:new", revision: "new" };
        },
        setInterval: noInterval(),
      });
      await manager.initialize(ctx);
      expect(manager.snapshot()).toMatchObject({ state: "idle", releaseChannel: "stable" });
      await manager.setReleaseChannel("latest");
      expect(channels).toEqual(["stable", "latest"]);
      expect(manager.snapshot()).toMatchObject({ state: "available", releaseChannel: "latest" });
      expect(await readFile(join(dataDir, "update.json"), "utf8")).toContain('"releaseChannel": "latest"');
    } finally {
      if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
      else process.env.ATELIER_DATA_DIR = previousDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("restart launches updater once and redirects to port 81 with theme", async () => {
    const { ctx } = context();
    const dockerCalls: string[][] = [];
    const manager = new UpdateManager({
      detectRuntime: async () => runtime("old"),
      fetchMetadata: async () => ({ digest: "sha256:new", revision: "new" }),
      pullImage: async () => {},
      docker: async (args) => { dockerCalls.push(args); return { stdout: "updater", stderr: "", code: 0 }; },
      waitForUpdater: async (url) => { expect(url).toBe("http://atelier.test:81/up"); },
      setInterval: noInterval(),
    });
    await manager.initialize(ctx);
    await manager.startPull();
    const response = await manager.launchUpdater(new URL("http://atelier.test/update/restart?theme=dracula"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://atelier.test:81/?theme=dracula");
    expect(dockerCalls[0]).toContain("atelier-update-helper");
    expect(dockerCalls[0]).toContain("--release-channel");
    expect(dockerCalls[0]).toContain("stable");
    await expect(manager.launchUpdater(new URL("http://atelier.test/update/restart"))).rejects.toThrow("Restart is already in progress");
  });
});

describe("update routes", () => {
  test("renders what-new and restart modal turbo streams", async () => {
    const { ctx } = context();
    const manager = new UpdateManager({
      detectRuntime: async () => runtime("old"),
      fetchMetadata: async () => ({ digest: "sha256:new", revision: "new" }),
      fetchNotes: async () => "<section>notes</section>",
      setInterval: noInterval(),
    });
    await manager.initialize(ctx);
    const route = createUpdateRouteHandler(manager);
    const whatsNew = await route(new Request("http://test/update/whats-new"), new URL("http://test/update/whats-new"));
    const whatsNewText = await whatsNew!.text();
    expect(whatsNewText).toContain("Changes since your current version");
    expect(whatsNewText).toContain("Preparing what’s new…");
    expect(whatsNewText).toContain("src=\"/update/whats-new/notes\"");
    expect(whatsNewText).not.toContain("<section>notes</section>");
    const notes = await route(new Request("http://test/update/whats-new/notes"), new URL("http://test/update/whats-new/notes"));
    expect(await notes!.text()).toContain("<section>notes</section>");
    const restart = await route(new Request("http://test/update/restart-confirm"), new URL("http://test/update/restart-confirm"));
    const text = await restart!.text();
    expect(text).toContain("Restart Atelier to finish updating?");
    expect(text).toContain("Active agent sessions and terminal connections will be interrupted");
    expect(text).not.toContain("<section>notes</section>");
  });

  test("start route kicks off pulling against the shared manager", async () => {
    const { ctx } = context();
    let pulled = false;
    const manager = new UpdateManager({
      detectRuntime: async () => runtime("old"),
      fetchMetadata: async () => ({ digest: "sha256:new", revision: "new" }),
      pullImage: async () => { pulled = true; },
      setInterval: noInterval(),
    });
    await manager.initialize(ctx);
    const route = createUpdateRouteHandler(manager);
    const response = await route(new Request("http://test/update/start", { method: "POST" }), new URL("http://test/update/start"));
    expect(response!.headers.get("content-type")).toContain("text/vnd.turbo-stream.html");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pulled).toBe(true);
    expect(manager.snapshot().state).toBe("ready_to_restart");
  });

  test("check-now route refreshes update status", async () => {
    const { ctx } = context();
    const metadata = [{ digest: "sha256:old-digest", revision: "old" }, { digest: "sha256:new", revision: "new" }];
    const manager = new UpdateManager({
      detectRuntime: async () => runtime("old"),
      fetchMetadata: async () => metadata.shift()!,
      setInterval: noInterval(),
    });
    await manager.initialize(ctx);
    expect(manager.snapshot().state).toBe("idle");
    const route = createUpdateRouteHandler(manager);
    const response = await route(new Request("http://test/update/check-now", { method: "POST" }), new URL("http://test/update/check-now"));
    expect(response!.headers.get("content-type")).toContain("text/vnd.turbo-stream.html");
    expect(await response!.text()).toContain("Update available");
    expect(manager.snapshot().state).toBe("available");
  });

  test("state endpoint and SSE expose shared update state", async () => {
    const { ctx } = context();
    const manager = new UpdateManager({
      detectRuntime: async () => runtime("old"),
      fetchMetadata: async () => ({ digest: "sha256:new", revision: "new" }),
      setInterval: noInterval(),
    });
    await manager.initialize(ctx);
    const route = createUpdateRouteHandler(manager);
    const state = await route(new Request("http://test/update/state"), new URL("http://test/update/state"));
    expect(await state!.json()).toMatchObject({ state: "available", selfUpdatable: true });
    const sse = await route(new Request("http://test/update/events"), new URL("http://test/update/events"));
    expect(sse!.headers.get("content-type")).toContain("text/event-stream");
    const reader = sse!.body!.getReader();
    const chunk = await reader.read();
    await reader.cancel();
    expect(new TextDecoder().decode(chunk.value)).toContain('"state":"available"');
  });
});

describe("docker pull progress", () => {
  test("parses streaming Docker JSON layer progress", async () => {
    const events: Array<{ percent?: number }> = [];
    const lines = `stable: Pulling from lucasmeijer/atelier\n${[
      { id: "a", status: "Downloading", progressDetail: { current: 25, total: 100 } },
      { id: "b", status: "Downloading", progressDetail: { current: 50, total: 100 } },
      { id: "a", status: "Download complete", progressDetail: { current: 100, total: 100 } },
    ].map((line) => `${JSON.stringify(line)}\n`).join("")}`;
    await pullChannelImage("stable", (progress) => events.push(progress), () => ({
      stdout: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(lines)); controller.close(); } }),
      stderr: new ReadableStream({ start(controller) { controller.close(); } }),
      exited: Promise.resolve(0),
    } as unknown as ReturnType<typeof Bun.spawn>));
    expect(events.some((event) => event.percent === 25)).toBe(true);
    expect(events.at(-1)?.percent).toBe(100);
  });
});

describe("docker replacement config", () => {
  test("preserves env labels mounts network restart init and swaps image", () => {
    const inspect: DockerInspect = {
      Id: "container",
      Name: "/atelier",
      Image: "sha256:old",
      Config: { Env: ["A=B"], Labels: { "com.atelier.type": "server" }, Cmd: ["bun", "run", "apps/web/src/server/main.ts"] },
      HostConfig: { NetworkMode: "host", RestartPolicy: { Name: "unless-stopped" }, Init: true },
      Mounts: [{ Type: "bind", Source: "/host", Destination: "/data", RW: true }],
    };
    const args = replacementCreateArgs(inspect);
    expect(args).toContain("--env");
    expect(args).toContain("A=B");
    expect(args).toContain("--label");
    expect(args).toContain("com.atelier.type=server");
    expect(args).toContain("--network");
    expect(args).toContain("host");
    expect(args).toContain("--init");
    expect(args).toContain("--restart");
    expect(args).toContain("unless-stopped");
    expect(args).toContain("type=bind,src=/host,dst=/data");
    expect(args).toContain("ghcr.io/lucasmeijer/atelier:stable");
  });
});
