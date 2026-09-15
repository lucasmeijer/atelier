import { expect, test } from "bun:test";
import { nativeImageExists, reuseDefaultWorkspaceImage } from "./local-images.ts";

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

for (const host of ["linux/arm64", "linux/amd64"]) {
  for (const candidate of ["linux/arm64", "linux/amd64", undefined]) {
    test(`signature lookup: preloaded ${candidate} on ${host}`, async () => {
      const commands: string[][] = [];
      const tag = "atelier-workspace:0123456789abcdef";
      const reused = await reuseDefaultWorkspaceImage(tag, async args => {
        commands.push(args);
        if (args[0] === "version") return { exitCode: 0, stdout: host, stderr: "" };
        if (args[1] === "ls") {
          expect(args).toEqual(["image", "ls", "--all", "--quiet", "--no-trunc", "--filter", "label=com.atelier.workspace-image.signature=0123456789abcdef"]);
          return { exitCode: 0, stdout: candidate ? "sha256:preloaded\nsha256:preloaded\n" : "", stderr: "" };
        }
        if (args[1] === "inspect") {
          expect(args.at(-1)).toBe("sha256:preloaded");
          return { exitCode: 0, stdout: candidate!, stderr: "" };
        }
        expect(args).toEqual(["tag", "sha256:preloaded", tag]);
        return { exitCode: 0, stdout: "", stderr: "" };
      });
      expect(reused).toBe(candidate === host);
      expect(commands.filter(args => args[0] === "tag")).toHaveLength(candidate === host ? 1 : 0);
      expect(commands.filter(args => args[1] === "inspect")).toHaveLength(candidate ? 1 : 0);
    });
  }
}

test("signature lookup skips a foreign architecture to find the native image", async () => {
  const reused = await reuseDefaultWorkspaceImage("atelier-workspace:0123456789abcdef", async args => {
    const stdout = args[0] === "version" ? "linux/arm64"
      : args[1] === "ls" ? "sha256:foreign\nsha256:native\n"
      : args[1] === "inspect" ? (args.at(-1) === "sha256:foreign" ? "linux/amd64" : "linux/arm64") : "";
    if (args[0] === "tag") expect(args[1]).toBe("sha256:native");
    return { exitCode: 0, stdout, stderr: "" };
  });
  expect(reused).toBe(true);
});

for (const failing of ["version", "ls", "inspect", "tag"]) {
  test(`signature lookup surfaces Docker ${failing} failures`, async () => {
    await expect(reuseDefaultWorkspaceImage("atelier-workspace:0123456789abcdef", async args => {
      if (args[0] === failing || args[1] === failing) return { exitCode: 1, stdout: "", stderr: `${failing} failed` };
      return { exitCode: 0, stdout: args[1] === "ls" ? "sha256:preloaded" : "linux/arm64", stderr: "" };
    })).rejects.toThrow(`${failing} failed`);
  });
}

test("Docker platform lookup failure is not treated as a cache miss", async () => {
  await expect(nativeImageExists("workspace:hash", async () => ({ exitCode: 1, stdout: "", stderr: "Docker unavailable" }))).rejects.toThrow("Docker unavailable");
});
