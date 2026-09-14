import { isWorkspaceAppPort } from "@atelier/shared";
import { mkdir, chmod, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceIngress } from "./index.ts";

/** Each socket is a capability for exactly one workspace; bodies cannot choose it. */
export function createWorkspaceIngressSockets(ingress: WorkspaceIngress, directory: string) {
  const servers = new Map<string, ReturnType<typeof Bun.serve>>();
  const pending = new Map<string, Promise<void>>();
  return {
    async ensure(workspaceId: string): Promise<void> {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(workspaceId)) throw new Error("Invalid workspace id");
      if (servers.has(workspaceId)) return;
      if (pending.has(workspaceId)) return pending.get(workspaceId);
      const creating = (async () => {
        const path = join(directory, workspaceId, "ingress.sock");
        await mkdir(join(directory, workspaceId), { recursive: true });
        try { await unlink(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const server = Bun.serve({ unix: path, maxRequestBodySize: 1024, async fetch(request) {
          if (new URL(request.url).pathname === "/health" && request.method === "GET") return new Response("ok");
          if (new URL(request.url).pathname !== "/origins" || request.method !== "POST") return new Response("Not found", { status: 404 });
          let input: unknown;
          try { input = await request.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }
          if (!input || typeof input !== "object" || Array.isArray(input)) return new Response("Invalid publication", { status: 400 });
          const value = input as Record<string, unknown>;
          if (Object.keys(value).some((key) => key !== "port" && key !== "protocol") || typeof value.port !== "number" || !isWorkspaceAppPort(value.port) || (value.protocol !== undefined && value.protocol !== "http" && value.protocol !== "https")) return new Response("Expected {port: 1..65535, protocol: http|https}", { status: 400 });
          const origin = await ingress.publishPort(workspaceId, Number(value.port), value.protocol as "http" | "https" | undefined);
          return Response.json({ origin });
        } });
        await chmod(path, 0o666);
        servers.set(workspaceId, server);
      })().finally(() => pending.delete(workspaceId));
      pending.set(workspaceId, creating);
      return creating;
    },
    async remove(workspaceId: string) { servers.get(workspaceId)?.stop(true); servers.delete(workspaceId); await ingress.stopWorkspace(workspaceId); },
    stop() { for (const server of servers.values()) server.stop(true); servers.clear(); },
  };
}
