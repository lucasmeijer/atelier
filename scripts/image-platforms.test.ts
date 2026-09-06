import { expect, test } from "bun:test";
import { registryImageHasPlatforms } from "./image-platforms.ts";

for (const requested of ["arm64", "amd64"]) {
  for (const available of ["arm64", "amd64"]) {
    test(`single-manifest ${available} workspace image requested for ${requested}`, () => {
      expect(registryImageHasPlatforms("workspace:hash", [`linux/${requested}`], (args) => args.includes("--format")
        ? JSON.stringify({ os: "linux", architecture: available })
        : "MediaType: application/vnd.docker.distribution.manifest.v2+json")).toBe(requested === available);
    });
  }
}

test("multi-platform publishing requires every requested platform", () => {
  const requested = ["linux/amd64", "linux/arm64"];
  expect(registryImageHasPlatforms("workspace:hash", requested, () => "  Platform: linux/amd64\n  Platform: linux/arm64\n")).toBe(true);
  expect(registryImageHasPlatforms("workspace:hash", requested, () => "  Platform: linux/amd64\n")).toBe(false);
  expect(registryImageHasPlatforms("workspace:hash", requested, () => "MediaType: application/vnd.oci.image.manifest.v1+json")).toBe(false);
});

test("missing images and configs are not reused", () => {
  expect(registryImageHasPlatforms("missing", ["linux/arm64"], () => undefined)).toBe(false);
  expect(registryImageHasPlatforms("missing-config", ["linux/arm64"], (args) => args.includes("--format") ? "null" : "single manifest")).toBe(false);
});
