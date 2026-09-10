import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import * as files from "@atelier/files/server";
import * as vscode from "@atelier/vscode/server";
import { createTestApp } from "./support/test-web-app.ts";

const listVSCode = spyOn(vscode, "listWorkspaceVSCodeViews");
const openVSCode = spyOn(vscode, "openFileInVSCode");
const openFiles = spyOn(files, "openFileInFiles");

afterEach(() => {
  listVSCode.mockReset();
  openVSCode.mockReset();
  openFiles.mockReset();
});
afterAll(() => {
  listVSCode.mockRestore();
  openVSCode.mockRestore();
  openFiles.mockRestore();
});

test("neutral file links prefer the workspace's existing VS Code", async () => {
  listVSCode.mockReturnValue([{ title: "VS Code" }]);
  openVSCode.mockResolvedValue(new Response(null, { status: 204 }));
  const { app } = createTestApp();
  const response = await app.fetch(new Request("http://localhost/workspaces/navigation/file/open?path=src/example.ts&line=42&column=3"));
  expect(response.status).toBe(204);
  expect(listVSCode).toHaveBeenCalledWith("navigation");
  expect(openVSCode).toHaveBeenCalledWith("navigation", "VS Code", { path: "/work/src/example.ts", line: 42, column: 3 }, expect.any(Function));
  expect(openFiles).not.toHaveBeenCalled();
});

test("neutral file links use Files when no VS Code is open", async () => {
  listVSCode.mockReturnValue([]);
  openFiles.mockResolvedValue(new Response(null, { status: 204 }));
  const { app } = createTestApp();
  const response = await app.fetch(new Request("http://localhost/workspaces/navigation/file/open?path=/tmp/example.ts&line=2"));
  expect(response.status).toBe(204);
  expect(openFiles).toHaveBeenCalledWith("navigation", { path: "/tmp/example.ts", line: 2, column: undefined }, expect.any(Function));
  expect(openVSCode).not.toHaveBeenCalled();
});

test("explicit Files navigation never consults VS Code", async () => {
  listVSCode.mockReturnValue([{ title: "VS Code" }]);
  openFiles.mockResolvedValue(new Response(null, { status: 204 }));
  const { app } = createTestApp();
  const response = await app.fetch(new Request("http://localhost/workspaces/navigation/files-view/open?path=/work/example.ts&filesView=workspace"));
  expect(response.ok).toBe(true);
  expect(listVSCode).not.toHaveBeenCalled();
  expect(openVSCode).not.toHaveBeenCalled();
});

test("neutral navigation rejects missing paths and unsupported methods before choosing an editor", async () => {
  const { app } = createTestApp();
  const missing = await app.fetch(new Request("http://localhost/workspaces/navigation/file/open"));
  expect(missing.status).toBe(400);
  const post = await app.fetch(new Request("http://localhost/workspaces/navigation/file/open?path=/work/example.ts", { method: "POST" }));
  expect(post.status).toBe(405);
  expect(post.headers.get("allow")).toBe("GET");
  expect(listVSCode).not.toHaveBeenCalled();
  expect(openFiles).not.toHaveBeenCalled();
  expect(openVSCode).not.toHaveBeenCalled();
});
