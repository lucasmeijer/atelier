import { describe, expect, test } from "bun:test";
import { parseDockerVolumePaths, parseWorkspaceCarrierMetadata, workspaceCarrierKey, workspaceCarrierMatches, type ResolvedDockerImagePreload } from "./carrier.ts";

const preload: ResolvedDockerImagePreload = {
  refs: ["ubuntu:24.04", "ghcr.io/example/workspace:0123456789abcdef", "atelier-workspace:0123456789abcdef"],
  images: [
    { spec: "ubuntu:24.04", sourceRef: "ubuntu:24.04", imageId: "sha256:ubuntu", aliases: [] },
    { spec: "default-atelier-workspace-image", sourceRef: "ghcr.io/example/workspace:0123456789abcdef", imageId: "sha256:workspace", aliases: ["atelier-workspace:0123456789abcdef"] },
  ],
};

describe("Docker volume paths", () => {
  test("parses Docker inspect output at the command boundary", () => {
    expect(parseDockerVolumePaths('{"/data":{},"/var/lib/docker":{}}')).toEqual(new Set(["/data", "/var/lib/docker"]));
    expect(parseDockerVolumePaths("null")).toEqual(new Set());
  });

  test("rejects non-object Docker inspect output", () => {
    expect(() => parseDockerVolumePaths("[]")).toThrow("Docker image volumes must be an object or null");
  });
});

describe("workspace carrier identity", () => {
  test("is declaration-order independent and includes IDs, base, and format", () => {
    const reversed = { ...preload, images: [...preload.images].reverse() };
    expect(workspaceCarrierKey("base-a", "linux/amd64", preload)).toBe(workspaceCarrierKey("base-a", "linux/amd64", reversed));
    expect(workspaceCarrierKey("base-a", "linux/amd64", preload)).not.toBe(workspaceCarrierKey("base-b", "linux/amd64", preload));
    expect(workspaceCarrierKey("base-a", "linux/amd64", preload)).not.toBe(workspaceCarrierKey("base-a", "linux/amd64", { ...preload, images: [{ ...preload.images[0]!, imageId: "sha256:changed" }, preload.images[1]!] }));
    expect(workspaceCarrierKey("base-a", "linux/amd64", preload, 1)).not.toBe(workspaceCarrierKey("base-a", "linux/amd64", preload, 2));
  });

  test("rejects carrier labels that are not strings at the Docker boundary", () => {
    expect(() => parseWorkspaceCarrierMetadata(JSON.stringify({
      "com.atelier.workspace-carrier.version": 1,
    }))).toThrow("invalid workspace carrier metadata");
  });

  test("recognizes a compatible carrier independently of preload declaration order", () => {
    const metadata = parseWorkspaceCarrierMetadata(JSON.stringify({
      "com.atelier.workspace-carrier.version": "1",
      "com.atelier.workspace-carrier.key": "carrier-key",
      "com.atelier.workspace-carrier.base-image": "sha256:base",
      "com.atelier.workspace-carrier.storage-driver": "fuse-overlayfs",
      "com.atelier.workspace-carrier.platform": "linux/amd64",
      "com.atelier.workspace-carrier.preload": JSON.stringify([
        { ref: "ghcr.io/example/workspace:0123456789abcdef", id: "sha256:workspace", aliases: ["atelier-workspace:0123456789abcdef"] },
        { ref: "ubuntu:24.04", id: "sha256:ubuntu", aliases: [] },
      ]),
    }));
    expect(metadata).toBeDefined();
    expect(workspaceCarrierMatches(metadata!, "linux/amd64", { ...preload, images: [...preload.images].reverse() })).toBe(true);
    expect(workspaceCarrierMatches(metadata!, "linux/arm64", preload)).toBe(false);
  });
});
