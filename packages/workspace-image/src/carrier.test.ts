import { describe, expect, test } from "bun:test";
import { logicalWorkspaceBaseIdentity, parsePublishedWorkspaceCarriers, repositoryWorkspaceDockerfileHash, selectPublishedWorkspaceCarrier, workspaceCarrierKey, type ResolvedDockerImagePreload } from "./carrier.ts";

const preload: ResolvedDockerImagePreload = {
  requestedSpecs: ["ubuntu:24.04", "atelier-default-workspace"],
  refs: ["ubuntu:24.04", "ghcr.io/example/workspace:0123456789abcdef", "atelier-workspace:0123456789abcdef"],
  images: [
    { spec: "ubuntu:24.04", sourceRef: "ubuntu:24.04", imageId: "sha256:ubuntu", aliases: [] },
    { spec: "atelier-default-workspace", sourceRef: "ghcr.io/example/workspace:0123456789abcdef", imageId: "sha256:workspace", aliases: ["atelier-workspace:0123456789abcdef"] },
  ],
};

describe("workspace carrier identity", () => {
  test("is declaration-order independent and includes IDs, base, and format", () => {
    const reversed = { ...preload, images: [...preload.images].reverse() };
    expect(workspaceCarrierKey("base-a", "linux/amd64", preload)).toBe(workspaceCarrierKey("base-a", "linux/amd64", reversed));
    expect(workspaceCarrierKey("base-a", "linux/amd64", preload)).not.toBe(workspaceCarrierKey("base-b", "linux/amd64", preload));
    expect(workspaceCarrierKey("base-a", "linux/amd64", preload)).not.toBe(workspaceCarrierKey("base-a", "linux/amd64", { ...preload, images: [{ ...preload.images[0]!, imageId: "sha256:changed" }, preload.images[1]!] }));
    expect(workspaceCarrierKey("base-a", "linux/amd64", preload, 1)).not.toBe(workspaceCarrierKey("base-a", "linux/amd64", preload, 2));
  });

  test("logical identity never includes checkout paths", () => {
    const dockerfile = "FROM atelier-workspace\nRUN true\n";
    expect(logicalWorkspaceBaseIdentity("workspace:1", dockerfile)).toBe(`workspace:1@dockerfile-sha256:${repositoryWorkspaceDockerfileHash(dockerfile)}`);
    expect(logicalWorkspaceBaseIdentity("workspace:1", dockerfile)).not.toContain("/tmp/");
  });

  test("published metadata requires exact logical compatibility", () => {
    const dockerfile = "FROM atelier-workspace\nRUN true\n";
    const entry = {
      platform: "linux/amd64",
      storageDriver: "fuse-overlayfs" as const,
      sourceWorkspaceDockerfileHash: repositoryWorkspaceDockerfileHash(dockerfile),
      defaultWorkspaceImage: "workspace:1",
      preloadSpecs: ["ubuntu:24.04", "atelier-default-workspace"],
      image: "carrier:1",
      key: "abc",
    };
    const metadata = parsePublishedWorkspaceCarriers({ version: 1, carriers: [entry] });
    expect(selectPublishedWorkspaceCarrier(metadata, { platform: "linux/amd64", defaultWorkspaceImage: "workspace:1", dockerfileContents: dockerfile, preloadSpecs: [...entry.preloadSpecs].reverse() })?.image).toBe("carrier:1");
    expect(selectPublishedWorkspaceCarrier(metadata, { platform: "linux/arm64", defaultWorkspaceImage: "workspace:1", dockerfileContents: dockerfile, preloadSpecs: entry.preloadSpecs })).toBeUndefined();
    expect(selectPublishedWorkspaceCarrier(metadata, { platform: "linux/amd64", defaultWorkspaceImage: "workspace:2", dockerfileContents: dockerfile, preloadSpecs: entry.preloadSpecs })).toBeUndefined();
  });
});
