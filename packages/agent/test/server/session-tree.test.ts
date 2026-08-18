import { describe, expect, test } from "bun:test";
import type { SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { parseTreeFilterMode, parseTreeLabels, renderAgentTreeMenu, renderAgentTreeSummaryMenu, serializeTreeLabels } from "../../src/server/session-tree.ts";

function message(id: string, parentId: string | null, role: "user" | "assistant", text: string, children: SessionTreeNode[] = []): SessionTreeNode {
  return {
    entry: { type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z", message: { role, content: [{ type: "text", text }], timestamp: 0 } } as never,
    children,
  };
}

describe("agent session tree", () => {
  test("renders branches, labels, and the current leaf as selectable entries", () => {
    const oldBranch = message("old", "root", "assistant", "Old answer");
    const activeBranch = message("active", "root", "assistant", "Current answer");
    activeBranch.label = "chosen path • checkpoint";
    const html = renderAgentTreeMenu([message("root", null, "user", "Try an approach", [oldBranch, activeBranch])], "active");

    expect(html).toContain('aria-label="Session tree"');
    expect(html).toContain('data-tree-entry="root"');
    expect(html).toContain('data-tree-entry="old"');
    expect(html).toContain('data-tree-entry="active"');
    expect(html.indexOf('data-tree-entry="active"')).toBeLessThan(html.indexOf('data-tree-entry="old"'));
    expect(html).toContain("chosen path");
    expect(html).toContain("checkpoint");
    expect(html.match(/data-tree-action="label-remove"/g)).toHaveLength(2);
    expect(html).toContain("current");
    expect(html).toContain("agent-tree-label-editor");
    expect(html).toContain("agent-tree-ribbon");
  });

  test("serializes multiple labels through Pi's single label field", () => {
    expect(serializeTreeLabels(["risk", "checkpoint"])).toBe("risk • checkpoint");
    expect(parseTreeLabels("risk • checkpoint")).toEqual(["risk", "checkpoint"]);
  });

  test("stops a ribbon at a leaf node", () => {
    const html = renderAgentTreeMenu([message("only", null, "assistant", "A leaf")], "only");

    expect(html).toContain('<circle cx="9" cy="24" r="4"/>');
    expect(html).not.toContain('d="M 9 24 V 48"');
  });

  test("offers no summary, automatic summary, and custom summary instructions", () => {
    const html = renderAgentTreeSummaryMenu('entry<&"');

    expect(html).toContain('data-summary-mode="none"');
    expect(html).toContain('data-summary-mode="summary"');
    expect(html).toContain('data-summary-mode="custom"');
    expect(html).toContain("Additional summary instructions");
    expect(html).toContain('data-tree-entry="entry&lt;&amp;&quot;"');
  });

  test("filters and searches the same node types as Pi's tree", () => {
    expect(parseTreeFilterMode("unknown")).toBe("default");
    const labeled = message("labeled", null, "user", "Keep this decision");
    labeled.label = "bookmark";
    const other = message("other", null, "user", "Unrelated message");

    const filtered = renderAgentTreeMenu([labeled, other], "other", { filter: "labeled-only" });
    expect(filtered).toContain('data-tree-entry="labeled"');
    expect(filtered).not.toContain('data-tree-entry="other"');

    const searched = renderAgentTreeMenu([labeled, other], "other", { query: "decision" });
    expect(searched).toContain('data-tree-entry="labeled"');
    expect(searched).not.toContain('data-tree-entry="other"');
  });

  test("omits bookkeeping and tool-call-only assistant entries", () => {
    const html = renderAgentTreeMenu([{
      entry: { type: "model_change", id: "model", parentId: null, timestamp: "", provider: "x", modelId: "y" },
      children: [{
        entry: { type: "message", id: "tools", parentId: "model", timestamp: "", message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] } } as never,
        children: [message("answer", "tools", "assistant", "Readable answer")],
      }],
    }], "answer");

    expect(html).not.toContain('data-tree-entry="model"');
    expect(html).not.toContain('data-tree-entry="tools"');
    expect(html).toContain('data-tree-entry="answer"');

    const all = renderAgentTreeMenu([{
      entry: { type: "model_change", id: "model", parentId: null, timestamp: "", provider: "x", modelId: "y" },
      children: [],
    }], "model", { filter: "all" });
    expect(all).toContain("x/y");
  });
});
