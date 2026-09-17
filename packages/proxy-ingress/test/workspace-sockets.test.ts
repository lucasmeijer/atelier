import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceIngress, createWorkspaceIngressSockets } from "../src/ingress/index.ts";

test("host protocols share workspace sockets without replacing health or origin publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-sockets-"));
  const ingress = createWorkspaceIngress({ hostname: "127.0.0.1", resolveWorkspace() {}, resolveApp() { return undefined; } });
  const sockets = createWorkspaceIngressSockets(ingress, directory, async (request, workspaceId) => {
    if (new URL(request.url).pathname === "/mcp") return Response.json({ workspaceId, body: await request.text() });
  });
  try {
    await sockets.ensure("first");
    await sockets.ensure("second");
    const body = JSON.stringify({ workspaceId: "other-workspace", settings: "x".repeat(4096) });
    for (const workspaceId of ["first", "second"]) {
      const unix = join(directory, workspaceId, "ingress.sock");
      expect(await (await fetch("http://localhost/health", { unix })).text()).toBe("ok");
      const response = await fetch("http://localhost/mcp", { unix, method: "POST", body });
      expect(await response.json()).toEqual({ workspaceId, body });
      expect((await fetch("http://localhost/unknown", { unix })).status).toBe(404);
      expect((await fetch("http://localhost/origins", { unix, method: "POST", body: "{}" })).status).toBe(400);
      const published = await fetch("http://localhost/origins", { unix, method: "POST", body: '{"port":8080}' });
      expect(published.status).toBe(200);
      expect((await published.json()).origin).toStartWith("http://localhost:");
    }
  } finally {
    sockets.stop();
    await ingress.stopAll();
    await rm(directory, { recursive: true, force: true });
  }
});
