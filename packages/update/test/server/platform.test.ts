import { expect, test } from "bun:test";
import { fetchChannelImageMetadata } from "../../src/server/registry.ts";
import { replacementImageId } from "../../src/server/docker.ts";

for (const architecture of ["amd64", "arm64"]) {
  for (const indexed of [false, true]) {
    for (const imageArchitecture of ["amd64", "arm64"]) {
      test(`${architecture} update: ${indexed ? "index" : "single manifest"} with ${imageArchitecture} config`, async () => {
        const fetcher = async (input: URL | RequestInfo) => {
          const url = String(input);
          if (url.endsWith("/manifests/stable") && indexed) return Response.json({ manifests: [{ digest: "sha256:image", platform: { os: "linux", architecture } }] });
          if (url.includes("/manifests/")) return Response.json({ config: { digest: "sha256:config" } }, { headers: { "docker-content-digest": "sha256:image" } });
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
      ? Response.json({ config: { digest: "sha256:config" } })
      : Response.json(config), { os: "linux", architecture: "arm64" })).rejects.toThrow();
  });
}

for (const host of ["linux/arm64", "linux/amd64"]) {
  for (const image of ["linux/arm64", "linux/amd64", "windows/arm64"]) {
    test(`replacement preflight: ${image} on ${host}`, async () => {
      const calls: string[][] = [];
      const result = replacementImageId("atelier:stable", async (args) => {
        calls.push(args);
        return { code: 0, stderr: "", stdout: args[0] === "version" ? `${host}\n` : `${image} sha256:immutable\n` };
      });
      if (image === host) await expect(result).resolves.toBe("sha256:immutable");
      else await expect(result).rejects.toThrow(`update image is ${image}, expected ${host}`);
      expect(calls.map((call) => call[0])).toEqual(["version", "image"]);
    });
  }
}

test("replacement preflight propagates missing-image errors", async () => {
  await expect(replacementImageId("missing", async (args) => args[0] === "version"
    ? { code: 0, stdout: "linux/arm64", stderr: "" }
    : { code: 1, stdout: "", stderr: "No such image" })).rejects.toThrow("No such image");
});

test("self-update preserves owned snapshotter deployment", async () => {
  const { replacementCreateArgs } = await import("../../src/server/docker.ts");
  const args = replacementCreateArgs({
    Id: "server", Image: "old", Name: "/atelier",
    Config: { Cmd: ["bun", "run", "apps/web/src/server/main.ts"], Env: ["ATELIER_DOCKER_HOST_DATA_DIR=/srv/atelier"] },
    HostConfig: { Init: true, Privileged: true },
    Mounts: [{ Type: "bind", Source: "/srv/atelier/docker-runtime", Destination: "/srv/atelier/docker-runtime", RW: true }],
  }, "new");
  expect(args).toContain("--privileged");
  expect(args).toContain("type=bind,src=/srv/atelier/docker-runtime,dst=/srv/atelier/docker-runtime");
  expect(args.slice(-4)).toEqual(["new", "bun", "run", "apps/web/src/server/main.ts"]);
});

test("self-update preserves explicit nested startup", async () => {
  const { replacementCreateArgs } = await import("../../src/server/docker.ts");
  const args = replacementCreateArgs({
    Id: "server", Image: "old", Name: "/atelier",
    Config: { Cmd: ["--nested"] },
    HostConfig: { Init: true, Privileged: false },
    Mounts: [{ Type: "bind", Source: "/inherited/docker-runtime.json", Destination: "/.atelier/docker-runtime.json", RW: false }],
  }, "new");
  expect(args).not.toContain("--privileged");
  expect(args).toContain("type=bind,src=/inherited/docker-runtime.json,dst=/.atelier/docker-runtime.json,readonly");
  expect(args.slice(-2)).toEqual(["new", "--nested"]);
});
