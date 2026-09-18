import { afterEach, expect, test } from "bun:test";
import { defineTool, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgentMcpServer } from "../../agent/src/server/mcp-server.ts";
import { createPiAtelierExtension } from "../src/extension/pi-atelier.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

type HandlerResult = void | { systemPrompt: string };
interface FakeEvent { systemPrompt?: string }
type FakeHandler = (...args: any[]) => Promise<HandlerResult>;

function fakePi(existing: string[] = []) {
  const handlers = new Map<string, FakeHandler[]>([]);
  const tools = new Map<string, ToolDefinition<any, any>>();
  const executions: unknown[][] = [];
  const partial = {
    on(name: string, handler: FakeHandler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(tool: ToolDefinition<any, any>) { tools.set(tool.name, tool); },
    getAllTools() { return [...existing.map((name) => ({ name })), ...[...tools.values()].map(({ name }) => ({ name }))]; },
    async exec(...args: unknown[]) { executions.push(args); return { code: 0, stdout: "", stderr: "", killed: false }; },
  };
  // SAFETY: The extension under test uses only the ExtensionAPI members implemented by this fake.
  const pi = partial as ExtensionAPI;
  async function emit(name: string, event: FakeEvent = {}): Promise<HandlerResult> {
    let result: HandlerResult = undefined;
    for (const handler of handlers.get(name) ?? []) result = await handler(event, {});
    return result;
  }
  return { pi, tools, executions, emit };
}

async function fixture() {
  const identity = { workspaceId: "workspace-a", agentId: "agent-a" };
  const token = "secret-token";
  let cancelled = false;
  const endpoint = createAgentMcpServer({
    authenticate: (candidate) => candidate === token ? identity : undefined,
    instructions: () => "Use present to show interactive work.",
    tools: () => [
      defineTool({
        name: "present", label: "Present", description: "Present work",
        parameters: Type.Object({ kind: Type.String() }),
        execute: async (_id, args: { kind: string }, _signal, update) => {
          update?.({ content: [{ type: "text", text: "Opening" }], details: {} });
          return { content: [{ type: "text", text: `Presented ${args.kind}` }], details: {} };
        },
      }),
      defineTool({
        name: "fail", label: "Fail", description: "Fail visibly", parameters: Type.Object({}),
        execute: async () => { throw new Error("deliberate failure"); },
      }),
      defineTool({
        name: "wait", label: "Wait", description: "Wait until cancelled", parameters: Type.Object({}),
        execute: async (_id, _args, signal, update) => {
          update?.({ content: [{ type: "text", text: "Waiting" }], details: {} });
          await new Promise<void>((resolve) => signal!.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }));
          return { content: [{ type: "text", text: "Cancelled" }], details: {} };
        },
      }),
    ],
  });
  const server = Bun.serve({ port: 0, fetch: (request) => endpoint.fetch(request) });
  cleanup.push(async () => { await endpoint.revoke({ workspaceId: identity.workspaceId }); server.stop(true); });
  return { url: new URL("/mcp", server.url).href, token, turnFinishedCommand: "/session/turn-finished.sh", cancelled: () => cancelled };
}

test("pi-atelier discovers tools and carries instructions, progress, errors and completion", async () => {
  const mcp = await fixture();
  const f = fakePi(["bash"]);
  createPiAtelierExtension(async () => mcp)(f.pi);
  await f.emit("session_start");

  expect([...f.tools.keys()]).toEqual(["present", "fail", "wait"]);
  expect(await f.emit("before_agent_start", { systemPrompt: "Base" })).toEqual({ systemPrompt: "Base\n\nUse present to show interactive work." });
  const updates: string[] = [];
  const result = await f.tools.get("present")!.execute("call", { kind: "browser" }, undefined, (update) => {
    updates.push(update.content[0]!.type === "text" ? update.content[0]!.text : "image");
  }, undefined!);
  expect(updates).toEqual(["Opening"]);
  expect(result.content).toEqual([{ type: "text", text: "Presented browser" }]);
  await expect(f.tools.get("fail")!.execute("call", {}, undefined, undefined, undefined!)).rejects.toThrow("deliberate failure");

  const abort = new AbortController();
  const waiting = f.tools.get("wait")!.execute("call", {}, abort.signal, () => abort.abort(), undefined!);
  await expect(waiting).rejects.toThrow();
  for (let attempt = 0; attempt < 50 && !mcp.cancelled(); attempt++) await Bun.sleep(10);
  expect(mcp.cancelled()).toBe(true);

  await f.emit("agent_end");
  expect(f.executions).toEqual([["sh", [mcp.turnFinishedCommand]]]);
  await f.emit("session_shutdown");
  await expect(f.tools.get("present")!.execute("call", { kind: "browser" }, undefined, undefined, undefined!)).rejects.toThrow("not connected");
});

test("pi-atelier fails instead of overriding an existing tool", async () => {
  const mcp = await fixture();
  const f = fakePi(["present"]);
  createPiAtelierExtension(async () => mcp)(f.pi);
  await expect(f.emit("session_start")).rejects.toThrow("collides with an existing Pi tool: present");
});
