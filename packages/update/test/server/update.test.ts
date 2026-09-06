import { describe, expect, test } from "bun:test";
import { createAtelierEventBus } from "@atelier/core";
import { dockerContainerInspect, dockerImageInspect, parseContainerIdFromCgroup, parseContainerIdFromMountInfo, parseDockerPullEventLine, replacementCreateArgs, serverHealthUrlFromInspect, type DockerInspect, type SelfUpdateRuntime } from "../../src/server/docker.ts";
import { createUpdateRouteHandler, renderSidebarRow, UpdateManager } from "../../src/server/index.ts";
import { parseWwwAuthenticate, selectManifestFromIndex, fetchChannelImageMetadata } from "../../src/server/registry.ts";

describe("self container parsing", () => {
  test("preserves container config needed to detect a managed install", async () => {
    const inspect = await dockerContainerInspect("container-id", async () => ({
      stdout: JSON.stringify([{
        Id: "container-id",
        Image: "sha256:image-id",
        Config: {
          Image: "ghcr.io/lucasmeijer/atelier:latest",
          Labels: { "com.atelier.type": "server" },
        },
      }]),
      stderr: "",
      code: 0,
    }));

    expect(inspect.Config).toEqual({
      Image: "ghcr.io/lucasmeijer/atelier:latest",
      Labels: { "com.atelier.type": "server" },
    });
  });

  test("rejects malformed Docker inspect output", async () => {
    await expect(dockerContainerInspect("container-id", async () => ({
      stdout: JSON.stringify([{ Id: 42, Image: "sha256:image-id" }]),
      stderr: "",
      code: 0,
    }))).rejects.toThrow();
  });

  test("accepts image inspect output without container-only fields", async () => {
    const inspect = await dockerImageInspect("sha256:image-id", async () => ({
      stdout: JSON.stringify([{
        Id: "sha256:image-id",
        RepoDigests: ["ghcr.io/lucasmeijer/atelier@sha256:digest"],
        Config: { Labels: null },
      }]),
      stderr: "",
      code: 0,
    }));

    expect(inspect.RepoDigests).toEqual(["ghcr.io/lucasmeijer/atelier@sha256:digest"]);
  });

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

function runtime(currentRevision = "old", selfUpdateCompatibility?: string): SelfUpdateRuntime {
  return {
    containerId: "container-id",
    imageId: "sha256:old-image",
    releaseChannel: "stable",
    currentRevision,
    selfUpdateCompatibility,
    currentDigest: "sha256:old-digest",
    container: { Id: "container-id", Image: "sha256:old-image", Config: { Image: "ghcr.io/lucasmeijer/atelier:stable", Labels: { "com.atelier.type": "server" } } },
  };
}

function context() {
  const sidebar: string[] = [];
  const broadcasts: string[] = [];
  return {
    sidebar,
    broadcasts,
    ctx: {
      events: createAtelierEventBus(),
      registry: { setViewBusy: () => {}, markViewAttention: () => undefined },
      globalSidebarContributions: { set: (_id: string, html?: string, options?: { broadcastHtml?: string }) => {
        sidebar.push(html ?? "");
        broadcasts.push(options?.broadcastHtml ?? "");
      } },
      presentWorkView: async () => {},
      broadcastWorkspace: () => {},
      deleteCurrentWorkspace: async () => ({ deleted: false, blocked: false }),
      registerSocketHandler: () => {},
      registerWorkspaceAppResolver: () => {},
      registerProvisioningHook: () => {},
      onWorkspaceRemoved: () => {},
    },
  };
}

function noInterval() {
  return () => ({ unref() {} });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
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
    const fetcher = async (input: URL | RequestInfo) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/manifests/stable") && calls.filter((call) => call === url).length === 1) {
        return new Response("", { status: 401, headers: { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:lucasmeijer/atelier:pull"' } });
      }
      if (url.startsWith("https://ghcr.io/token")) return Response.json({ token: "token" });
      if (url.endsWith("/manifests/stable")) return Response.json({ config: { digest: "sha256:config" } }, { headers: { "docker-content-digest": "sha256:manifest" } });
      if (url.endsWith("/blobs/sha256:config")) return Response.json({ os: "linux", architecture: process.arch === "arm64" ? "arm64" : "amd64", config: { Labels: { "org.opencontainers.image.revision": "new", "com.atelier.self-update-compatibility": "contract-v1" } } });
      throw new Error(`unexpected fetch ${url}`);
    };
    await expect(fetchChannelImageMetadata("stable", fetcher)).resolves.toEqual({ digest: "sha256:manifest", platformDigest: undefined, revision: "new", selfUpdateCompatibility: "contract-v1" });
  });

  test("accepts null optional config label fields", async () => {
    for (const config of [null, { Labels: null }]) {
      const fetcher = async (input: URL | RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/manifests/stable")) return Response.json({ config: { digest: "sha256:config" } }, { headers: { "docker-content-digest": "sha256:manifest" } });
        if (url.endsWith("/blobs/sha256:config")) return Response.json({ os: "linux", architecture: process.arch === "arm64" ? "arm64" : "amd64", config });
        throw new Error(`unexpected fetch ${url}`);
      };
      await expect(fetchChannelImageMetadata("stable", fetcher)).resolves.toEqual({
        digest: "sha256:manifest",
        platformDigest: undefined,
        revision: undefined,
        selfUpdateCompatibility: undefined,
      });
    }
  });

  test("selects and fetches an image manifest from a registry index", async () => {
    const architecture = process.arch === "arm64" ? "arm64" : "amd64";
    const fetcher = async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/manifests/stable")) return Response.json({ manifests: [{ digest: "sha256:platform", platform: { os: "linux", architecture } }] });
      if (url.endsWith("/manifests/sha256:platform")) return Response.json({ config: { digest: "sha256:config" } });
      if (url.endsWith("/blobs/sha256:config")) return Response.json({ os: "linux", architecture: process.arch === "arm64" ? "arm64" : "amd64", config: { Labels: { "org.opencontainers.image.revision": "indexed" } } });
      throw new Error(`unexpected fetch ${url}`);
    };

    await expect(fetchChannelImageMetadata("stable", fetcher)).resolves.toEqual({
      digest: "sha256:platform",
      platformDigest: "sha256:platform",
      revision: "indexed",
      selfUpdateCompatibility: undefined,
    });
  });

  test("rejects malformed registry token responses", async () => {
    const fetcher = async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/manifests/stable")) return new Response("", { status: 401, headers: { "www-authenticate": 'Bearer realm="https://ghcr.io/token"' } });
      if (url === "https://ghcr.io/token") return Response.json({ token: 42 });
      throw new Error(`unexpected fetch ${url}`);
    };

    await expect(fetchChannelImageMetadata("stable", fetcher)).rejects.toThrow();
  });

  test("rejects malformed registry manifests and config labels", async () => {
    const malformedManifest = async () => Response.json({ config: { digest: 42 } });
    await expect(fetchChannelImageMetadata("stable", malformedManifest)).rejects.toThrow();

    const malformedIndex = async () => Response.json({
      manifests: [{ digest: 42, platform: { os: "linux", architecture: "amd64" } }],
    });
    await expect(fetchChannelImageMetadata("stable", malformedIndex)).rejects.toThrow();

    const malformedConfig = async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/manifests/stable")) return Response.json({ config: { digest: "sha256:config" } });
      if (url.endsWith("/blobs/sha256:config")) return Response.json({ os: "linux", architecture: process.arch === "arm64" ? "arm64" : "amd64", config: { Labels: { revision: 42 } } });
      throw new Error(`unexpected fetch ${url}`);
    };
    await expect(fetchChannelImageMetadata("stable", malformedConfig)).rejects.toThrow();
  });

  test("selects current linux platform manifest", () => {
    expect(selectManifestFromIndex({ manifests: [
      { digest: "sha256:arm", platform: { os: "linux", architecture: "arm64" } },
      { digest: "sha256:amd", platform: { os: "linux", architecture: "amd64" } },
    ] }, { os: "linux", architecture: "amd64" })).toBe("sha256:amd");
  });
});

describe("update state machine", () => {
  test("keeps Check now available in Settings while hiding the unmanaged Workspace contribution", async () => {
    const { ctx, sidebar, broadcasts } = context();
    const manager = new UpdateManager({ detectRuntime: async () => undefined, setInterval: noInterval() });
    await manager.initialize(ctx);
    expect(sidebar.at(-1)).toBe("");
    expect(broadcasts.at(-1)).toContain("<h2>Updates</h2>");
    expect(broadcasts.at(-1)).toContain(">Check now</span>");
  });

  test("checking and current settings use the same compact check button", async () => {
    const { ctx, sidebar, broadcasts } = context();
    const gate = deferred<{ digest: string; revision: string }>();
    let checks = 0;
    const manager = new UpdateManager({
      detectRuntime: async () => runtime("old"),
      fetchMetadata: async () => checks++ === 0 ? { digest: "sha256:old-digest", revision: "old" } : await gate.promise,
      setInterval: noInterval(),
    });
    await manager.initialize(ctx);
    expect(broadcasts.at(-1)).toContain(">Check now</span>");
    const checking = manager.checkNow();
    expect(broadcasts.at(-1)).toContain('class="button secondary progress-button"');
    expect(broadcasts.at(-1)).toContain('data-progress-kind="indeterminate"');
    expect(broadcasts.at(-1)).toContain('data-progress-content="in-progress">Checking…');
    expect(sidebar.at(-1)).toBe("");
    gate.resolve({ digest: "sha256:new", revision: "new" });
    await checking;
  });

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

  test("compatibility mismatch requires rerunning the installer", async () => {
    const { ctx, sidebar } = context();
    const manager = new UpdateManager({
      detectRuntime: async () => runtime("old", "contract-v1"),
      fetchMetadata: async () => ({ digest: "sha256:new", revision: "new", selfUpdateCompatibility: "contract-v2" }),
      pullImage: async () => { throw new Error("should not pull"); },
      setInterval: noInterval(),
    });
    await manager.initialize(ctx);
    expect(manager.snapshot()).toMatchObject({ state: "incompatible", compatibilityMismatch: true });
    expect(sidebar.join("\n")).toContain("Download Update");
    await expect(manager.startPull()).rejects.toThrow("installer");
    const response = await createUpdateRouteHandler(manager)(new Request("http://atelier.test/update/start", { method: "POST" }), new URL("http://atelier.test/update/start"));
    expect(await response!.text()).toContain("curl -fsSL https://lucasmeijer.com/get-atelier | sudo bash");
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
    const { ctx, sidebar, broadcasts } = context();
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
    expect(manager.snapshot().state).toBe("pulling");
    expect(sidebar.at(-1)).toContain('class="button primary progress-button"');
    expect(sidebar.at(-1)).toContain('data-progress-state="in-progress"');
    expect(sidebar.at(-1)).toContain('style="--button-progress:1"');
    expect(sidebar.at(-1)).not.toContain("update-sidebar-progress");
    expect(broadcasts.at(-1)).toContain('target="settings-sec-update" method="morph"');
    expect(broadcasts.at(-1)).toContain('data-progress-state="in-progress"');
    gate.resolve();
    await Promise.all([first, second]);
    expect(pulls).toBe(1);
  });

  test("a newer digest discovered after downloading becomes available for an explicit download", async () => {
    const { ctx, sidebar } = context();
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
    expect(pulls).toBe(1);
    expect(manager.snapshot()).toMatchObject({ state: "available", target: { digest: "sha256:new2" } });
    expect(sidebar.at(-1)).toContain("Download Update");
  });

  test("pulls a newer digest discovered while the previous digest is downloading", async () => {
    const { ctx } = context();
    const firstPull = deferred();
    const metadata = [{ digest: "sha256:new1", revision: "new1" }, { digest: "sha256:new2", revision: "new2" }];
    let pulls = 0;
    const manager = new UpdateManager({
      detectRuntime: async () => runtime("old"),
      fetchMetadata: async () => metadata.shift()!,
      pullImage: async () => {
        pulls += 1;
        if (pulls === 1) await firstPull.promise;
      },
      setInterval: noInterval(),
    });
    await manager.initialize(ctx);
    const pulling = manager.startPull();
    await manager.checkNow();
    firstPull.resolve();
    await pulling;
    expect(pulls).toBe(2);
    expect(manager.snapshot()).toMatchObject({ state: "ready_to_restart", target: { digest: "sha256:new2" } });
  });

  test("restart launches updater once and redirects to https port 81 with theme", async () => {
    const { ctx } = context();
    const dockerCalls: string[][] = [];
    const manager = new UpdateManager({
      detectRuntime: async () => runtime("old"),
      fetchMetadata: async () => ({ digest: "sha256:new", revision: "new" }),
      pullImage: async () => {},
      docker: async (args) => { dockerCalls.push(args); return { stdout: "updater", stderr: "", code: 0 }; },
      checkUpdaterPortAvailable: async () => {},
      waitForUpdater: async (url) => { expect(url).toBe("https://atelier.test:81/up"); },
      setInterval: noInterval(),
    });
    await manager.initialize(ctx);
    await manager.startPull();
    const response = await manager.launchUpdater(new URL("http://atelier.test/update/restart?theme=dracula"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://atelier.test:81/?theme=dracula");
    expect(dockerCalls[0]).toEqual(["ps", "-aq", "--filter", "name=^/atelier-updater-"]);
    const runCall = dockerCalls.find((call) => call.includes("atelier-update-helper"));
    expect(runCall).toBeDefined();
    expect(runCall!).toContain("--release-channel");
    expect(runCall!).toContain("stable");
    await expect(manager.launchUpdater(new URL("http://atelier.test/update/restart"))).rejects.toThrow("Restart is already in progress");
  });

  test("restart reports a blocked updater port before starting the helper", async () => {
    const { ctx } = context();
    const dockerCalls: string[][] = [];
    const manager = new UpdateManager({
      detectRuntime: async () => runtime("old"),
      fetchMetadata: async () => ({ digest: "sha256:new", revision: "new" }),
      pullImage: async () => {},
      docker: async (args) => { dockerCalls.push(args); return { stdout: "", stderr: "", code: 0 }; },
      checkUpdaterPortAvailable: async () => { throw new Error("Update helper port 81 is already in use. Stop the process using port 81 and retry the update."); },
      setInterval: noInterval(),
    });
    await manager.initialize(ctx);
    await manager.startPull();
    await expect(manager.launchUpdater(new URL("http://atelier.test/update/restart"))).rejects.toThrow("Update helper port 81 is already in use");
    expect(dockerCalls).toEqual([["ps", "-aq", "--filter", "name=^/atelier-updater-"]]);
    expect(manager.snapshot()).toMatchObject({ state: "ready_to_restart", error: "Update helper port 81 is already in use. Stop the process using port 81 and retry the update." });
  });
});

describe("update routes", () => {
  test("acknowledges an explicit check when the development runtime cannot self-update", async () => {
    const { ctx } = context();
    const manager = new UpdateManager({ detectRuntime: async () => undefined, setInterval: noInterval() });
    await manager.initialize(ctx);
    const route = createUpdateRouteHandler(manager);
    const response = await route(new Request("http://test/update/check-now", { method: "POST" }), new URL("http://test/update/check-now"));
    expect(await response!.text()).toContain('data-transient-feedback-state-value="feedback"');
  });

  test("renders a Workspace pane message and control only while an update needs action", () => {
    const snapshot = { selfUpdatable: true, releaseChannel: "stable" as const, compatibilityMismatch: false };
    expect(renderSidebarRow({ ...snapshot, state: "idle" })).toBe("");
    expect(renderSidebarRow({ ...snapshot, state: "checking" })).toBe("");
    const available = renderSidebarRow({ ...snapshot, state: "available" });
    expect(available).toContain("<p>There's a new version of Atelier!</p>");
    expect(available).toContain(">Download Update</span>");
    const restart = renderSidebarRow({ ...snapshot, state: "ready_to_restart" });
    expect(restart).toContain('data-controller="transient-feedback" data-transient-feedback-state-value="initial"');
    expect(restart).toContain('method="post" action="/update/restart?surface=sidebar"');
    expect(restart).toContain('class="destructive-confirmation"');
  });

  test("restart route returns a turbo redirect target after launching the helper", async () => {
    const { ctx } = context();
    const manager = new UpdateManager({
      detectRuntime: async () => runtime("old"),
      fetchMetadata: async () => ({ digest: "sha256:new", revision: "new" }),
      pullImage: async () => {},
      docker: async () => ({ stdout: "updater", stderr: "", code: 0 }),
      checkUpdaterPortAvailable: async () => {},
      waitForUpdater: async () => {},
      setInterval: noInterval(),
    });
    await manager.initialize(ctx);
    await manager.startPull();
    const route = createUpdateRouteHandler(manager);
    const response = await route(new Request("http://atelier.test/update/restart?surface=settings&theme=nord", { method: "POST", headers: { Accept: "text/vnd.turbo-stream.html" } }), new URL("http://atelier.test/update/restart?surface=settings&theme=nord"));
    expect(response!.headers.get("content-type")).toContain("text/vnd.turbo-stream.html");
    expect(response!.headers.get("location")).toBe("https://atelier.test:81/?theme=nord");
  });

  test("restart route replaces the clicked control with transient inline feedback", async () => {
    const { ctx } = context();
    const manager = new UpdateManager({
      detectRuntime: async () => runtime("old"),
      fetchMetadata: async () => ({ digest: "sha256:new", revision: "new" }),
      pullImage: async () => {},
      docker: async () => ({ stdout: "", stderr: "", code: 0 }),
      checkUpdaterPortAvailable: async () => { throw new Error("Update helper port 81 is already in use on 127.0.0.1. Stop the process using 127.0.0.1:81 and retry the update."); },
      setInterval: noInterval(),
    });
    await manager.initialize(ctx);
    await manager.startPull();
    const route = createUpdateRouteHandler(manager);
    const response = await route(new Request("http://test/update/restart?surface=settings", { method: "POST", headers: { Accept: "text/vnd.turbo-stream.html" } }), new URL("http://test/update/restart?surface=settings"));
    const text = await response!.text();
    expect(response!.headers.get("content-type")).toContain("text/vnd.turbo-stream.html");
    expect(text).toContain('action="replace" target="update_restart_feedback_settings"');
    expect(text).toContain('data-transient-feedback-state-value="feedback"');
    expect(text).toContain('data-transient-feedback-content="feedback" role="status"');
    expect(text).toContain("Could not restart Atelier");
    expect(text).toContain("127.0.0.1:81");
    expect(text).toContain('action="/update/restart?surface=settings"');
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

  test("check-now route briefly renders a transient current result after the canonical broadcast", async () => {
    const { ctx, broadcasts } = context();
    const manager = new UpdateManager({
      detectRuntime: async () => runtime("old"),
      fetchMetadata: async () => ({ digest: "sha256:old-digest", revision: "old" }),
      setInterval: noInterval(),
    });
    await manager.initialize(ctx);
    const route = createUpdateRouteHandler(manager);
    const response = await route(new Request("http://test/update/check-now", { method: "POST" }), new URL("http://test/update/check-now"));
    const html = await response!.text();
    expect(html).toContain('data-controller="transient-feedback" data-transient-feedback-state-value="feedback"');
    expect(html).toContain('data-transient-feedback-content="initial" hidden><form method="post" action="/update/check-now"');
    expect(broadcasts.at(-1)).toContain('data-transient-feedback-state-value="feedback"');
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
    const html = await response!.text();
    expect(html).toContain(">Download Update</span>");
    expect(html).not.toContain("Update available");
    expect(html).not.toContain("Update channel");
    expect(manager.snapshot().state).toBe("available");
  });

});

describe("Docker pull event parsing", () => {
  test("parses streamed layer progress", () => {
    expect(parseDockerPullEventLine(JSON.stringify({
      id: "layer-id",
      status: "Downloading",
      progressDetail: { current: 40, total: 100 },
    }))).toEqual({
      id: "layer-id",
      status: "Downloading",
      progressDetail: { current: 40, total: 100 },
    });
  });

  test("rejects malformed progress fields", () => {
    expect(() => parseDockerPullEventLine(JSON.stringify({
      id: "layer-id",
      progressDetail: { current: "40", total: 100 },
    }))).toThrow();
  });
});

describe("update helper health URL", () => {
  test("checks the actual bound host when the server is not listening on localhost", () => {
    const inspect: DockerInspect = { Id: "container", Image: "sha256:old", Config: { Env: ["HOST=100.81.122.77", "PORT=80"] } };
    expect(serverHealthUrlFromInspect(inspect, "http://agent-test/").toString()).toBe("http://100.81.122.77/up");
  });

  test("falls back to the browser return URL for wildcard binds", () => {
    const inspect: DockerInspect = { Id: "container", Image: "sha256:old", Config: { Env: ["HOST=0.0.0.0", "PORT=80"] } };
    expect(serverHealthUrlFromInspect(inspect, "http://agent-test/").toString()).toBe("http://agent-test/up");
  });
});

describe("docker replacement config", () => {
  test("preserves env labels mounts network restart init and swaps image", () => {
    const inspect: DockerInspect = {
      Id: "container",
      Name: "/atelier",
      Image: "sha256:old",
      Config: {
        Env: ["A=B", "ATELIER_COMMIT_ID=old", "ATELIER_COMMIT_DESCRIPTION=old build"],
        Labels: { "com.atelier.type": "server", "com.atelier.workspace-cgroup-parent": "atelier-workspaces.slice", "org.opencontainers.image.revision": "old" },
        Cmd: ["bun", "run", "apps/web/src/server/main.ts"],
      },
      HostConfig: { NetworkMode: "host", RestartPolicy: { Name: "unless-stopped" }, Init: true, CpuShares: 2048, MemoryReservation: 1_073_741_824, OomScoreAdj: -500 },
      Mounts: [{ Type: "bind", Source: "/host", Destination: "/data", RW: true }],
    };
    const args = replacementCreateArgs(inspect);
    expect(args).toContain("--env");
    expect(args).toContain("A=B");
    expect(args).not.toContain("ATELIER_COMMIT_ID=old");
    expect(args).not.toContain("ATELIER_COMMIT_DESCRIPTION=old build");
    expect(args).toContain("--label");
    expect(args).toContain("com.atelier.type=server");
    expect(args).toContain("com.atelier.workspace-cgroup-parent=atelier-workspaces.slice");
    expect(args).not.toContain("org.opencontainers.image.revision=old");
    expect(args).toContain("--network");
    expect(args).toContain("host");
    expect(args).toContain("--init");
    expect(args).toContain("--restart");
    expect(args).toContain("unless-stopped");
    expect(args).toContain("--cpu-shares");
    expect(args).toContain("2048");
    expect(args).toContain("--memory-reservation");
    expect(args).toContain("1073741824");
    expect(args).toContain("--oom-score-adj");
    expect(args).toContain("-500");
    expect(args).toContain("type=bind,src=/host,dst=/data");
    expect(args).toContain("ghcr.io/lucasmeijer/atelier:stable");
  });
});
