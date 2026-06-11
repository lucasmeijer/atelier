import { describe, expect, test } from "bun:test";
import { parseWorkspaceAppHost } from "../src/server/proxy.ts";

describe("parseWorkspaceAppHost", () => {
  test("parses localhost app hosts", () => {
    expect(parseWorkspaceAppHost("vscode--abc123.localhost:3000")).toEqual({ appKey: "vscode", workspaceId: "abc123" });
    expect(parseWorkspaceAppHost("preview-5173--work_1.localhost")).toEqual({ appKey: "preview-5173", workspaceId: "work_1" });
  });

  test("ignores non app hosts", () => {
    expect(parseWorkspaceAppHost("localhost:3000")).toBeUndefined();
    expect(parseWorkspaceAppHost("vscode--abc123.example.com")).toBeUndefined();
    expect(parseWorkspaceAppHost("bad.localhost:3000")).toBeUndefined();
  });
});
