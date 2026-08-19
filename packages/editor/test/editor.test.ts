import { describe, expect, test } from "bun:test";
import { createAtelierEventBus } from "@atelier/core";
import { atelierServerModule, initializeEditorWorkspaceIntegration } from "../src/server/index.ts";
import { renderFileEditorTab } from "../src/server/render.ts";
import { deleteWorkspaceFileEditorState, fileEditorTabLabels, openWorkspaceFileEditorTab } from "../src/server/state.ts";

describe("editor workspace integration", () => {
  test("asks open editors to check disk only when an agent turn finishes", async () => {
    const events = createAtelierEventBus();
    const broadcasts: string[] = [];
    initializeEditorWorkspaceIntegration({
      events,
      broadcastWorkspace: (_workspaceId: string, html: string) => broadcasts.push(html),
      onWorkspaceRemoved: () => {},
    });
    openWorkspaceFileEditorTab("workspace-1", "/work/example.ts");
    expect(broadcasts).toHaveLength(0);
    await events.emit("workspace_agent_turn_finished", { workspaceId: "workspace-1", agentLabel: "Agent 1" });
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toContain("file_editor_signal_workspace-1");
    deleteWorkspaceFileEditorState("workspace-1");
  });

  test("renders Markdown previews through the shared renderer", async () => {
    const request = new Request("http://test.local/workspaces/workspace-md/file-editor/markdown-preview", {
      method: "POST",
      body: "# Preview\n\n**Rendered**",
    });
    const response = await atelierServerModule.routes![0]!.handle(request, new URL(request.url), {
      openTab: () => {
        throw new Error("Markdown previews must not open a workspace tab");
      },
    });
    expect(response?.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response?.text()).toBe("<h1>Preview</h1>\n<p><strong>Rendered</strong></p>");
  });

  test("adds the rendered Markdown toggle only to Markdown files", () => {
    const markdownTab = openWorkspaceFileEditorTab("workspace-md", "/work/README.md").tab;
    const codeTab = openWorkspaceFileEditorTab("workspace-md", "/work/index.ts").tab;
    const markdownHtml = renderFileEditorTab("workspace-md", markdownTab, "README.md").paneHtml!;
    const codeHtml = renderFileEditorTab("workspace-md", codeTab, "index.ts").paneHtml!;
    expect(markdownHtml).toContain("file-editor#togglePreview");
    expect(markdownHtml).toContain("file-editor-preview agent-md");
    expect(codeHtml).not.toContain("file-editor#togglePreview");
    deleteWorkspaceFileEditorState("workspace-md");
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
