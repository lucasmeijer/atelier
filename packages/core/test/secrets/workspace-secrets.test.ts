import { afterEach, describe, expect, test } from "bun:test";
import { createWorkspaceSecretContext, forgetWorkspaceSecretContext, getWorkspaceSecretContext } from "../../src/secrets/workspace-secrets.ts";

describe("workspace secrets", () => {
  afterEach(() => {
    delete process.env.GH_TOKEN;
    forgetWorkspaceSecretContext("test-workspace");
  });

  test("uses deterministic placeholders for workspace env secrets", async () => {
    process.env.GH_TOKEN = "real-secret";
    const context = await createWorkspaceSecretContext("test-workspace");

    expect(context.env.GH_TOKEN).toBe("ATELIER_INJECT_GH_TOKEN");
    expect(context.secrets).toContainEqual({
      name: "GH_TOKEN",
      placeholder: "ATELIER_INJECT_GH_TOKEN",
      hosts: ["github.com", "api.github.com"],
    });
  });

  test("rebuilds context on demand after in-memory state is forgotten", async () => {
    process.env.GH_TOKEN = "real-secret";
    forgetWorkspaceSecretContext("test-workspace");

    const context = await getWorkspaceSecretContext("test-workspace");

    expect(context?.env.GH_TOKEN).toBe("ATELIER_INJECT_GH_TOKEN");
  });
});
