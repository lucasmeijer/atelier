import { describe, expect, test } from "bun:test";
import { createAtelierEventBus } from "@atelier/core";
import type { WorkspaceWorkViewReference } from "@atelier/shared";
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
    expect((await atelierServerModule.attachToWorkspace!({ workspaceId: "workspace-1" })).overlayHtml?.[0]).toContain("file_editor_signal_workspace-1");
    deleteWorkspaceFileEditorState("workspace-1");
  });

  test("opens the editor view before loading file content", async () => {
    const request = new Request("http://test.local/workspaces/workspace-progressive/file-editor/open?path=%2Fwork%2Fnew.ts");
    let opened: WorkspaceWorkViewReference | undefined;
    // SAFETY: The test fixture controls this route context.
    const response = await atelierServerModule.routes![0]!.handle(request, new URL(request.url), {
      openWorkView: async (_workspaceId: string, reference: WorkspaceWorkViewReference) => {
        opened = reference;
        return new Response("opened");
      },
    } as never);

    expect(await response?.text()).toBe("opened");
    expect(opened).toEqual({ type: "file", path: "/work/new.ts" });
    deleteWorkspaceFileEditorState("workspace-progressive");
  });

  test("renders Markdown previews through the shared renderer", async () => {
    const request = new Request("http://test.local/workspaces/workspace-md/file-editor/markdown-preview?path=%2Fwork%2Fdocs%2FREADME.md", {
      method: "POST",
      body: "# Preview\n\n**Rendered** [Config](../config.ts)",
    });
    // SAFETY: The test fixture controls this value and establishes the asserted shape.
    const response = await atelierServerModule.routes![0]!.handle(request, new URL(request.url), {} as never);
    expect(response?.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await response?.text();
    expect(html).toContain("<h1>Preview</h1>");
    expect(html).toContain("<strong>Rendered</strong>");
    expect(html).toContain("file-editor/open?path=%2Fwork%2Fconfig.ts");
    expect(html).toContain('data-turbo-stream="true"');
  });

  test("adds the rendered Markdown toggle only to Markdown files", () => {
    const markdownTab = openWorkspaceFileEditorView("workspace-md", "/work/README.md").view;
    const codeTab = openWorkspaceFileEditorView("workspace-md", "/work/index.ts").view;
    const markdownHtml = renderFileWorkView("workspace-md", markdownTab, "README.md").bodyHtml!;
    const codeHtml = renderFileWorkView("workspace-md", codeTab, "index.ts").bodyHtml!;
    expect(markdownHtml).toContain("file-editor#togglePreview");
    expect(markdownHtml).toContain("file-editor-preview agent-md");
    expect(markdownHtml).toContain('class="file-editor-loading"');
    expect(markdownHtml).toContain("Loading file…");
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
