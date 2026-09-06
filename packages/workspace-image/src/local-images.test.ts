import { expect, test } from "bun:test";
import { nativeImageExists } from "./local-images.ts";

for (const host of ["linux/arm64", "linux/amd64"]) {
  for (const image of ["linux/arm64", "linux/amd64", undefined]) {
    test(`cached workspace image ${image} on ${host}`, async () => {
      const matches = await nativeImageExists("workspace:hash", async (args) => {
        if (args[0] === "version") return { exitCode: 0, stdout: `${host}\n`, stderr: "" };
        expect(args).toEqual(["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", "workspace:hash"]);
        return { exitCode: image ? 0 : 1, stdout: image ? `${image}\n` : "", stderr: "" };
      });
      expect(matches).toBe(host === image);
    });
  }
}

test("Docker platform lookup failure is not treated as a cache miss", async () => {
  await expect(nativeImageExists("workspace:hash", async () => ({ exitCode: 1, stdout: "", stderr: "Docker unavailable" }))).rejects.toThrow("Docker unavailable");
});
