import { describe, expect, test } from "bun:test";
import { parseWwwAuthenticate, selectManifestFromIndex, fetchChannelImageMetadata } from "../../src/server/registry.ts";
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
      if (url.endsWith("/blobs/sha256:config")) return Response.json({ os: "linux", architecture: process.arch === "arm64" ? "arm64" : "amd64", config: { Labels: { "org.opencontainers.image.revision": "new" } } });
      throw new Error(`unexpected fetch ${url}`);
    };
    await expect(fetchChannelImageMetadata("stable", fetcher)).resolves.toEqual({ digest: "sha256:manifest", platformDigest: undefined, revision: "new" });
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
