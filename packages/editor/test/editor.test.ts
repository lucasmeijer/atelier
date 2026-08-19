import { describe, expect, test } from "bun:test";
import { createAtelierEventBus } from "@atelier/core";
import { atelierServerModule } from "../src/server/index.ts";
import { renderFileWorkView } from "../src/server/render.ts";
import { deleteWorkspaceFileEditorState, fileEditorViewLabels, openWorkspaceFileEditorView } from "../src/server/state.ts";

describe("editor workspace integration", () => {
  test("asks open editors to check disk only when an agent turn finishes", async () => {
    const events = createAtelierEventBus();
    const broadcasts: string[] = [];
    // SAFETY: The test fixture controls this value and establishes the asserted shape.
    await atelierServerModule.initialize!({
      events,
      broadcastWorkspace: (_workspaceId: string, html: string) => broadcasts.push(html),
      onWorkspaceRemoved: () => {},
    } as never);
    openWorkspaceFileEditorView("workspace-1", "/work/example.ts");
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
    // SAFETY: The test fixture controls this value and establishes the asserted shape.
    const response = await atelierServerModule.routes![0]!.handle(request, new URL(request.url), {} as never);
    expect(response?.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response?.text()).toBe("<h1>Preview</h1>\n<p><strong>Rendered</strong></p>");
  });

  test("adds the rendered Markdown toggle only to Markdown files", () => {
    const markdownTab = openWorkspaceFileEditorView("workspace-md", "/work/README.md").view;
    const codeTab = openWorkspaceFileEditorView("workspace-md", "/work/index.ts").view;
    const markdownHtml = renderFileWorkView("workspace-md", markdownTab, "README.md").bodyHtml!;
    const codeHtml = renderFileWorkView("workspace-md", codeTab, "index.ts").bodyHtml!;
    expect(markdownHtml).toContain("file-editor#togglePreview");
    expect(markdownHtml).toContain("file-editor-preview agent-md");
    expect(codeHtml).not.toContain("file-editor#togglePreview");
    deleteWorkspaceFileEditorState("workspace-md");
  });

  test("reuses file views and disambiguates duplicate basenames", () => {
    const first = openWorkspaceFileEditorView("workspace-2", "/work/one/index.ts");
    const reopened = openWorkspaceFileEditorView("workspace-2", "/work/one/index.ts", { line: 4 });
    const second = openWorkspaceFileEditorView("workspace-2", "/work/two/index.ts");
    expect(reopened.created).toBe(false);
    expect(reopened.view).toBe(first.view);
    expect(reopened.view.line).toBe(4);
    expect(fileEditorViewLabels([first.view, second.view])).toEqual(new Map([
      [first.view.key, "one/index.ts"],
      [second.view.key, "two/index.ts"],
    ]));
    deleteWorkspaceFileEditorState("workspace-2");
  });
});
