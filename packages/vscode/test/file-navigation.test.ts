import { expect, test } from "bun:test";
import { patchVSCodeWorkspaceAppResponse } from "../src/server/proxy.ts";

const app = { appKey: "vscode", workspaceId: "navigation" };

async function navigationResponse(path: string, gotoLine = false): Promise<Response> {
  const url = new URL("https://workspace.example:41000/");
  url.searchParams.set("atelierOpenFile", path);
  if (gotoLine) url.searchParams.set("atelierGotoLine", "1");
  url.searchParams.set("atelierBg", "#112233");
  const response = new Response("", { headers: { "content-type": "text/html" } });
  return patchVSCodeWorkspaceAppResponse(app, response, new Request(url));
}

test("file navigation redirects to VS Code's native payload on this browser's app origin", async () => {
  const response = await navigationResponse("/work/example.ts:42:3", true);
  expect(response.status).toBe(302);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const target = new URL(response.headers.get("location")!);
  expect(target.origin).toBe("https://workspace.example:41000");
  expect(JSON.parse(target.searchParams.get("payload")!)).toEqual([
    ["openFile", "vscode-remote://workspace.example:41000/work/example.ts:42:3"],
    ["gotoLineMode", "true"],
  ]);
  expect(target.searchParams.has("atelierOpenFile")).toBe(false);
  expect(target.searchParams.has("atelierGotoLine")).toBe(false);
  expect(target.searchParams.get("atelierBg")).toBe("#112233");
});

test("literal path punctuation is URI encoded and is not treated as a cursor position", async () => {
  const response = await navigationResponse("/work/a b#c%20?.ts:42");
  const target = new URL(response.headers.get("location")!);
  expect(JSON.parse(target.searchParams.get("payload")!)).toEqual([
    ["openFile", "vscode-remote://workspace.example:41000/work/a%20b%23c%2520%3F.ts:42"],
  ]);
});

test("the app boundary rejects relative file paths", async () => {
  expect((await navigationResponse("relative.ts")).status).toBe(422);
});
