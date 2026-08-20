import { describe, expect, test } from "bun:test";
import { patchVSCodeWorkspaceAppResponse, vscodeAppKey } from "../src/server/proxy.ts";

const app = { appKey: vscodeAppKey, workspaceId: "work_1" };
const workbenchRequest = new Request("http://localhost:41000/stable/current/static/out/vs/code/browser/workbench/workbench.js");

describe("VS Code proxy response patching", () => {
  test("exposes the command API when VS Code changes minified identifiers", async () => {
    const script = "before;var $cn;(o=>{async function s(e,...t){return(await fH.p).commands.executeCommand(e,...t)}o.executeCommand=s})($cn||={});after";
    const response = new Response(script, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "content-length": String(script.length),
        "content-encoding": "gzip",
      },
    });

    const patched = await patchVSCodeWorkspaceAppResponse(app, response, workbenchRequest);

    expect(await patched.text()).toContain("o.executeCommand=s;globalThis.__atelierVSCodeCommands=o");
    expect(patched.headers.has("content-length")).toBe(false);
    expect(patched.headers.has("content-encoding")).toBe(false);
  });

  test("fails when the VS Code command API cannot be found", async () => {
    const response = new Response("console.log('different workbench shape')", {
      headers: { "content-type": "text/javascript" },
    });

    await expect(patchVSCodeWorkspaceAppResponse(app, response, workbenchRequest)).rejects.toThrow("could not expose VS Code command bridge");
  });
});
