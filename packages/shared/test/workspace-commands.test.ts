import { describe, expect, test } from "bun:test";
import { parseSerializedWorkspaceCommands } from "../src/workspace-commands.ts";

describe("parseSerializedWorkspaceCommands", () => {
  test("parses command metadata", () => {
    expect(parseSerializedWorkspaceCommands(JSON.stringify([{
      id: "agent.create",
      label: "New agent",
      scope: "workspace",
      binding: "Meta+N",
    }]))).toEqual([{
      id: "agent.create",
      label: "New agent",
      scope: "workspace",
      binding: "Meta+N",
    }]);
  });

  test("rejects metadata outside the workspace command protocol", () => {
    expect(() => parseSerializedWorkspaceCommands(JSON.stringify([{
      id: "agent.create",
      label: "New agent",
      scope: "somewhere",
    }]))).toThrow("Invalid serialized workspace commands");
  });
});
