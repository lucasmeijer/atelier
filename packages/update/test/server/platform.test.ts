import { expect, test } from "bun:test";
import { fetchChannelImageMetadata } from "../../src/server/registry.ts";

for (const architecture of ["amd64", "arm64"]) {
  for (const indexed of [false, true]) {
    for (const imageArchitecture of ["amd64", "arm64"]) {
      test(`${architecture} update: ${indexed ? "index" : "single manifest"} with ${imageArchitecture} config`, async () => {
        const fetcher = async (input: URL | RequestInfo) => {
          const url = String(input);
          if (url.endsWith("/manifests/stable") && indexed) return Response.json({ manifests: [{ digest: "sha256:image", platform: { os: "linux", architecture } }] });
          if (url.includes("/manifests/")) return Response.json({ config: { digest: "sha256:config" }, layers: [] }, { headers: { "docker-content-digest": "sha256:image" } });
          if (url.endsWith("/blobs/sha256:config")) return Response.json({ os: "linux", architecture: imageArchitecture, config: { Labels: { "org.opencontainers.image.revision": "new" } } });
          throw new Error(`unexpected fetch ${url}`);
        };
        const result = fetchChannelImageMetadata("stable", fetcher, { os: "linux", architecture });
        if (architecture === imageArchitecture) expect((await result).revision).toBe("new");
        else await expect(result).rejects.toThrow(`update image is linux/${imageArchitecture}, expected linux/${architecture}`);
      });
    }
  }
}

for (const config of [{}, { os: "linux" }, { os: "linux", architecture: 42 }, { os: "windows", architecture: "arm64" }]) {
  test(`rejects incompatible or missing config platform: ${JSON.stringify(config)}`, async () => {
    await expect(fetchChannelImageMetadata("stable", async (input) => String(input).includes("/manifests/")
      ? Response.json({ config: { digest: "sha256:config" }, layers: [] })
      : Response.json(config), { os: "linux", architecture: "arm64" })).rejects.toThrow();
  });
}
