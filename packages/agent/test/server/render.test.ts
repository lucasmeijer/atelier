import { describe, expect, test } from "bun:test";
import { formatReadRange, renderRunningToolCard, renderStreamingToolItem, renderToolCard, toolArgsSummary, type AgentRenderContext } from "../../src/server/render.ts";
import type { ToolView } from "../../src/server/transcript.ts";

const ctx: AgentRenderContext = { workspaceId: "ws", label: "agent" };

function tool(overrides: Partial<ToolView>): ToolView {
  return { callId: "call", name: "read", args: {}, status: "ok", ...overrides };
}

describe("tool rendering", () => {
  test("read summary includes requested line range", () => {
    expect(formatReadRange({ path: "a.ts" })).toBe("");
    expect(toolArgsSummary(tool({ name: "read", args: { path: "a.ts" } }))).toBe("a.ts");
    expect(toolArgsSummary(tool({ name: "read", args: { path: "a.ts", offset: 40, limit: 80 } }))).toBe("a.ts:40-119");
    expect(toolArgsSummary(tool({ name: "read", args: { path: "a.ts", offset: 40 } }))).toBe("a.ts:40");
    expect(toolArgsSummary(tool({ name: "read", args: { path: "a.ts", limit: 20 } }))).toBe("a.ts:1-20");
  });

  test("write renders content preview as code, not JSON newlines", () => {
    const html = renderToolCard(ctx, tool({ name: "write", args: { path: "a.ts", content: "const x = 1;\n<script>" }, resultText: "Successfully wrote 27 bytes to a.ts" }));
    expect(html).toContain("agent-tool-code");
    expect(html).toContain("x =");
    expect(html).toContain("\n");
    expect(html).not.toContain("\\n");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("Successfully wrote");
    expect(html).not.toContain("no output");
    expect(html).toContain("agent-tool-detail flush");
  });

  test("edit renders diff instead of raw JSON", () => {
    const html = renderToolCard(ctx, tool({ name: "edit", args: { path: "a.ts", oldText: "old", newText: "new" }, resultText: "ok" }));
    expect(html).toContain("agent-diff-line del");
    expect(html).toContain("agent-diff-line add");
    expect(html).not.toContain("oldText");
  });

  test("streaming known tools hide raw argument JSON", () => {
    const html = renderStreamingToolItem(ctx, "sid", 0, "write", `{"path":"a.ts","content":"x\\ny"}`);
    expect(html).toContain("agent-tool-code");
    expect(html).toContain("hidden");
    expect(html).not.toContain("agent-tool-stream");
    expect(html).not.toContain("content");
  });

  test("bash keeps running xterm and completed captured output separate", () => {
    const running = renderRunningToolCard(ctx, tool({ name: "bash", status: "running", args: { command: "npm test" }, tmuxSession: "tmux", terminalVisible: true }));
    expect(running).toContain("agent-tool-term");
    const done = renderToolCard(ctx, tool({ name: "bash", args: { command: "npm test" }, resultText: "final output" }));
    expect(done).toContain("final output");
    expect(done).not.toContain("agent-tool-term");
    expect(done).not.toContain("agent-tool-params");
  });
});
