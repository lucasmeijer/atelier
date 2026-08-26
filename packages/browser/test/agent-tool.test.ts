import { expect, test } from "bun:test";
import { createBrowserPresenter } from "../src/server/agent-tool.ts";
import { createWorkspaceBrowserView, deleteWorkspaceBrowserState } from "../src/server/state.ts";

test("presenting a new URL refreshes an already-open preview browser", async () => {
  const workspaceId = `browser_presenter_${crypto.randomUUID()}`;
  createWorkspaceBrowserView(workspaceId);
  const presentedUrls: string[] = [];
  const presenter = createBrowserPresenter(workspaceId, {
    async presentBrowser(view) {
      presentedUrls.push(view.targetUrl);
    },
  });

  try {
    await presenter.execute("first", { kind: "browser", url: "http://localhost:3000/first" });
    await presenter.execute("second", { kind: "browser", url: "http://localhost:3001/catalogue" });

    expect(presentedUrls).toEqual([
      "http://localhost:3000/first",
      "http://localhost:3001/catalogue",
    ]);
  } finally {
    deleteWorkspaceBrowserState(workspaceId);
  }
});
