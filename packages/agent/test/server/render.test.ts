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
    expect(html).toContain('data-controller="atelier-fullscreen"');
    expect(html).toContain('data-atelier-fullscreen-mode-value="template"');
    expect(html).toContain('template data-atelier-fullscreen-target="content"');
  });

  test("edit renders diff instead of raw JSON", () => {
    const html = renderToolCard(ctx, tool({ name: "edit", args: { path: "a.ts", oldText: "old", newText: "new" }, resultText: "Applied 1 block" }));
    expect(html).toContain("a.ts · 1 block · +1 -1");
    expect(html).toContain("agent-diff-line del");
    expect(html).toContain("agent-diff-line add");
    expect(html).toContain("agent-tool-detail flush");
    expect(html).not.toContain("oldText");
    expect(html).not.toContain("Applied 1 block");
    expect(html).not.toContain("no output");
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
    expect(done).toContain("agent-tool-copy");
    expect(done).toContain("agent-copy#copy");
    expect(done).not.toContain("agent-tool-term");
    expect(done).not.toContain("agent-tool-params");
  });

  test("bash defaults to terminal display with a model output toggle", () => {
    const html = renderToolCard(ctx, tool({
      name: "bash",
      args: { command: "printf color" },
      resultText: "plain model text",
      details: { displayAnsi: "\x1b[31mred\x1b[0m <tag>" },
    }));
    expect(html).toContain("agent-bash-result");
    expect(html).toContain('data-controller="atelier-fullscreen"');
    expect(html).toContain('template data-atelier-fullscreen-target="content"');
    expect(html).toContain("Terminal");
    expect(html).toContain("Model");
    expect(html).toContain("checked");
    expect(html).toContain("agent-tool-ansi");
    expect(html).toContain("color:#cd0000");
    expect(html).toContain("red");
    expect(html).toContain("&lt;tag&gt;");
    expect(html).toContain("agent-tool-model");
    expect(html).toContain("plain model text");
  });

  test("bash colorizes plain CMake build output when tools emit no ANSI", () => {
    const html = renderToolCard(ctx, tool({
      name: "bash",
      args: { command: "cmake --build build-cmake" },
      resultText: "[ 40%] Built target libninja",
      details: { displayAnsi: "[ 40%] Built target libninja" },
    }));
    expect(html).toContain("color:#00cdcd");
    expect(html).toContain("color:#00cd00");
    expect(html).toContain("Built target");
  });

  test("tool output escapes html-unsafe control characters", () => {
    const html = renderToolCard(ctx, tool({ name: "read", args: { path: "image.jpg" }, resultText: "abc\u0000\u0001def<script>" }));
    expect(html).toContain("abc��def&lt;script&gt;");
    expect(html).not.toContain("\u0000");
    expect(html).not.toContain("\u0001");
  });
});
