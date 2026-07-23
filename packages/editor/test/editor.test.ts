import { describe, expect, test } from "bun:test";
import { createAtelierEventBus } from "@atelier/core";
import { atelierServerModule } from "../src/server/index.ts";
import { deleteWorkspaceFileEditorState, fileEditorTabLabels, openWorkspaceFileEditorTab } from "../src/server/state.ts";

describe("editor workspace integration", () => {
  test("asks open editors to check disk only when an agent turn finishes", async () => {
    const events = createAtelierEventBus();
    const broadcasts: string[] = [];
    await atelierServerModule.initialize!({
      events,
      broadcastWorkspace: (_workspaceId: string, html: string) => broadcasts.push(html),
      onWorkspaceRemoved: () => {},
    } as never);
    openWorkspaceFileEditorTab("workspace-1", "/work/example.ts");
    expect(broadcasts).toHaveLength(0);
    await events.emit("workspace_agent_turn_finished", { workspaceId: "workspace-1", agentLabel: "Agent 1" });
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toContain("file_editor_signal_workspace-1");
    deleteWorkspaceFileEditorState("workspace-1");
  });

  test("reuses file tabs and disambiguates duplicate basenames", () => {
    const first = openWorkspaceFileEditorTab("workspace-2", "/work/one/index.ts");
    const reopened = openWorkspaceFileEditorTab("workspace-2", "/work/one/index.ts", { line: 4 });
    const second = openWorkspaceFileEditorTab("workspace-2", "/work/two/index.ts");
    expect(reopened.created).toBe(false);
    expect(reopened.tab).toBe(first.tab);
    expect(reopened.tab.line).toBe(4);
    expect(fileEditorTabLabels([first.tab, second.tab])).toEqual(new Map([
      [first.tab.key, "one/index.ts"],
      [second.tab.key, "two/index.ts"],
    ]));
    deleteWorkspaceFileEditorState("workspace-2");
  });
});
