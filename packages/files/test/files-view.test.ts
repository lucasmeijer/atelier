import { describe, expect, test } from "bun:test";
import { createAtelierEventBus } from "@atelier/core";
import type { WorkspaceWorkViewReference } from "@atelier/shared";
import { atelierServerModule } from "../src/server/index.ts";
import { createFilesView, deleteFilesViewState, listFilesViews, setFilesViewFile } from "../src/server/state.ts";

describe("Files Work view integration", () => {
  test("embed-style links select the file in the default Files view", async () => {
    const request = new Request("http://test.local/workspaces/workspace-progressive/files-view/open?path=%2Fwork%2Fnew.ts");
    let opened: WorkspaceWorkViewReference | undefined;
    // SAFETY: The test fixture supplies the route context fields exercised by this endpoint.
    const response = await atelierServerModule.routes![0]!.handle(request, new URL(request.url), {
      openWorkView: async (_workspaceId: string, reference: WorkspaceWorkViewReference) => {
        opened = reference;
        return new Response("<turbo-stream></turbo-stream>");
      },
    } as never);

    expect(response?.headers.get("content-type")).toContain("text/vnd.turbo-stream.html");
    expect(opened).toEqual({ type: "files", id: "workspace" });
    expect(listFilesViews("workspace-progressive")[0]?.path).toBe("/work/new.ts");
    const html = await response?.text();
    expect(html).toContain("workspace_workspace-progressive_files_workspace_editor");
    expect(html).toContain("workspace_workspace-progressive_files_workspace_tree");
    expect(html).toContain('loading="lazy"');
    expect(html).toContain("new.ts");
    deleteFilesViewState("workspace-progressive");
  });

  test("Markdown previews omit frontmatter", async () => {
    const request = new Request("http://test.local/workspaces/workspace-frontmatter/files-view/markdown-preview?path=%2Fwork%2Fguide.md", {
      method: "POST",
      body: "---\ntitle: Internal title\ndraft: true\n---\n# Public guide",
    });
    // SAFETY: The Markdown preview endpoint does not use the route context.
    const response = await atelierServerModule.routes![0]!.handle(request, new URL(request.url), {} as never);

    expect(response?.headers.get("content-type")).toContain("text/html");
    expect(await response?.text()).toBe("<h1>Public guide</h1>");
  });

  test("the Files command creates a blank independent view", async () => {
    const result = await atelierServerModule.commands![0]!.execute({ workspaceId: "workspace-command", input: {}, events: createAtelierEventBus() });
    const created = listFilesViews("workspace-command").find((view) => view.id === result.createdWorkView?.id);
    expect(created?.path).toBeUndefined();
    deleteFilesViewState("workspace-command");
  });

  test("asks selected Files editors to check disk after an agent turn", async () => {
    const events = createAtelierEventBus();
    const broadcasts: string[] = [];
    // SAFETY: The test fixture supplies the module initialization fields exercised by this test.
    await atelierServerModule.initialize!({ events, broadcastWorkspace: (_workspaceId: string, html: string) => broadcasts.push(html), onWorkspaceRemoved: () => {} } as never);
    setFilesViewFile("workspace-events", "workspace", "/work/example.ts");
    await events.emit("workspace_agent_turn_finished", { workspaceId: "workspace-events", conversationId: "conversation-1" });
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toContain("files_refresh_signal_workspace-events");
    deleteFilesViewState("workspace-events");
  });

  test("attaches the default and additional Files views", async () => {
    const view = createFilesView("workspace-attach");
    setFilesViewFile("workspace-attach", view.id, "/work/README.md");
    // SAFETY: The test fixture supplies the attachment context field exercised by Files.
    const attachment = await atelierServerModule.attachToWorkspace!({ workspaceId: "workspace-attach" } as never);
    expect(attachment.workViews).toHaveLength(2);
    expect(attachment.workViews?.map((view) => view.reference.type)).toEqual(["files", "files"]);
    expect(attachment.workViews?.map((view) => view.initiallyOpen)).toEqual([false, true]);
    deleteFilesViewState("workspace-attach");
  });
});
