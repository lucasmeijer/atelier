import { describe, expect, test } from "bun:test";
import { parseWwwAuthenticate, selectManifestFromIndex, fetchChannelImageMetadata, resolveImage } from "../../src/server/registry.ts";
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
      if (url.endsWith("/manifests/stable")) return Response.json({ config: { digest: "sha256:config" }, layers: [] }, { headers: { "docker-content-digest": "sha256:manifest" } });
      if (url.endsWith("/blobs/sha256:config")) return Response.json({ os: "linux", architecture: process.arch === "arm64" ? "arm64" : "amd64", config: { Labels: { "org.opencontainers.image.revision": "new" } } });
      throw new Error(`unexpected fetch ${url}`);
    };
    await expect(fetchChannelImageMetadata("stable", fetcher)).resolves.toEqual({ digest: "sha256:manifest", revision: "new" });
  });

  test("accepts null optional config label fields", async () => {
    for (const config of [null, { Labels: null }]) {
      const fetcher = async (input: URL | RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/manifests/stable")) return Response.json({ config: { digest: "sha256:config" }, layers: [] }, { headers: { "docker-content-digest": "sha256:manifest" } });
        if (url.endsWith("/blobs/sha256:config")) return Response.json({ os: "linux", architecture: process.arch === "arm64" ? "arm64" : "amd64", config });
        throw new Error(`unexpected fetch ${url}`);
      };
      await expect(fetchChannelImageMetadata("stable", fetcher)).resolves.toEqual({
        digest: "sha256:manifest",
        revision: undefined,
      });
    }
  });

  test("selects and fetches an image manifest from a registry index", async () => {
    const architecture = process.arch === "arm64" ? "arm64" : "amd64";
    const fetcher = async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/manifests/stable")) return Response.json({ manifests: [{ digest: "sha256:platform", platform: { os: "linux", architecture } }] });
      if (url.endsWith("/manifests/sha256:platform")) return Response.json({ config: { digest: "sha256:config" }, layers: [] });
      if (url.endsWith("/blobs/sha256:config")) return Response.json({ os: "linux", architecture: process.arch === "arm64" ? "arm64" : "amd64", config: { Labels: { "org.opencontainers.image.revision": "indexed" } } });
      throw new Error(`unexpected fetch ${url}`);
    };

    await expect(fetchChannelImageMetadata("stable", fetcher)).resolves.toEqual({
      digest: "sha256:platform",
      revision: "indexed",
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
      if (url.endsWith("/manifests/stable")) return Response.json({ config: { digest: "sha256:config" }, layers: [] });
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

test("resolves complete platform download metadata before pulling layers", async () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const layer = { digest: `sha256:${"b".repeat(64)}`, size: 1234 };
  const calls: string[] = [];
  const image = await resolveImage("ghcr.io/example/app:stable", async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/manifests/stable")) return Response.json({ manifests: [{ digest, platform: { os: "linux", architecture: "arm64" } }] });
    if (url.endsWith(`/manifests/${digest}`)) return Response.json({ config: { digest: "sha256:config" }, layers: [layer] });
    return Response.json({ os: "linux", architecture: "arm64", config: { Labels: { "eagerly-preload": '["ubuntu:24.04"]' } } });
  }, { os: "linux", architecture: "arm64" });
  expect(image).toEqual({ reference: `ghcr.io/example/app@${digest}`, layers: [layer], dependencies: ["ubuntu:24.04"] });
  expect(calls).toHaveLength(3);
});

test("download metadata rejects invalid dependencies and malformed layers", async () => {
  for (const label of ['{"image":"x"}', '[42]', '["--help"]', '["a b"]', 'not json']) {
    await expect(resolveImage("ubuntu", async (input) => String(input).includes("/manifests/")
      ? Response.json({ config: { digest: "sha256:config" }, layers: [] }, { headers: { "docker-content-digest": `sha256:${"a".repeat(64)}` } })
      : Response.json({ os: "linux", architecture: "amd64", config: { Labels: { "eagerly-preload": label } } }), { os: "linux", architecture: "amd64" })).rejects.toThrow();
  }
  await expect(resolveImage("ubuntu", async () => Response.json({ config: { digest: "sha256:config" }, layers: [{ digest: "bad", size: -1 }] }, { headers: { "docker-content-digest": `sha256:${"a".repeat(64)}` } }))).rejects.toThrow();
});

test("tag plus digest references use the repository path and preserve the pinned index", async () => {
  const index = `sha256:${"a".repeat(64)}`;
  const platformDigest = `sha256:${"b".repeat(64)}`;
  const calls: string[] = [];
  const result = await resolveImage(`ghcr.io/example/workspace:release@${index}`, async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith(`/manifests/${index}`)) return Response.json({ manifests: [{ digest: platformDigest, platform: { os: "linux", architecture: "amd64" } }] });
    if (url.endsWith(`/manifests/${platformDigest}`)) return Response.json({ config: { digest: "sha256:config" }, layers: [] });
    return Response.json({ os: "linux", architecture: "amd64" });
  }, { os: "linux", architecture: "amd64" });
  expect(calls[0]).toBe(`https://ghcr.io/v2/example/workspace/manifests/${index}`);
  expect(result.reference).toBe(`ghcr.io/example/workspace@${index}`);
});
