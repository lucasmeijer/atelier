import { describe, expect, test } from "bun:test";
import { AtelierCoreError } from "@atelier/core";
import { parseRepoWorkspaceManifest } from "@atelier/workspace";

function parse(value: unknown) { return parseRepoWorkspaceManifest(JSON.stringify(value)); }
function expectInvalid(value: unknown, text: string): void {
  try { parse(value); } catch (error) {
    expect(error).toBeInstanceOf(AtelierCoreError);
    expect((error as Error).message).toContain(text);
    return;
  }
  throw new Error("expected invalid manifest");
}

describe("workspace manifest config seeding", () => {
  test("accepts Pi and Atelier config destinations", () => {
    expect(parse({
      version: 1,
      seedPiConfig: { authJson: "/nested/auth.json", modelsJson: "/nested/models.json" },
      seedAtelierConfig: { projectsJson: "/nested/projects.json" },
    })).toEqual({
      version: 1,
      seedPiConfig: { authJson: "/nested/auth.json", modelsJson: "/nested/models.json" },
      seedAtelierConfig: { projectsJson: "/nested/projects.json" },
    });
  });

  test("rejects malformed Atelier config destinations", () => {
    expectInvalid({ version: 1, seedAtelierConfig: true }, "seedAtelierConfig must be an object");
    expectInvalid({ version: 1, seedAtelierConfig: { projectsJson: "" } }, "seedAtelierConfig.projectsJson must be a non-empty string");
  });
});

describe("workspace manifest Docker image preload", () => {
  test("is optional and accepts an empty array", () => {
    expect(parse({ version: 1 })).toEqual({ version: 1 });
    expect(parse({ version: 1, docker: { preloadImages: [] } })).toEqual({ version: 1, docker: { preloadImages: [] } });
  });

  test("accepts literal, magic, mixed, and duplicate specs", () => {
    expect(parse({ version: 1, docker: { privileged: true, preloadImages: ["default-atelier-workspace-image", "ubuntu:24.04", "ubuntu:24.04"] } }).docker?.preloadImages)
      .toEqual(["default-atelier-workspace-image", "ubuntu:24.04", "ubuntu:24.04"]);
  });

  test("rejects malformed preload values", () => {
    expectInvalid({ version: 1, docker: { privileged: true, preloadImages: "ubuntu:24.04" } }, "must be an array");
    expectInvalid({ version: 1, docker: { privileged: true, preloadImages: [1] } }, "non-empty strings");
    expectInvalid({ version: 1, docker: { privileged: true, preloadImages: ["  "] } }, "non-empty strings");
  });

  test("requires explicit nested Docker privilege", () => {
    expectInvalid({ version: 1, docker: { preloadImages: ["ubuntu:24.04"] } }, "requires docker.privileged");
  });

  test("rejects removed special-purpose fields", () => {
    expectInvalid({ version: 1, isAtelier: true }, "isAtelier is no longer supported");
    expectInvalid({ version: 1, privileged: true }, "privileged is no longer supported");
  });
});
