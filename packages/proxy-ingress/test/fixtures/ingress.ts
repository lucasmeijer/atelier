import { join } from "node:path";
import { createWorkspaceIngress, createFileOriginIdentityStore, createWorkspaceIngressSockets, type ParentOriginPublisher } from "../../src/ingress/index.ts";

// Test-only entrypoint: all publication, persistence, sockets and proxying are the
// production module. These instances use separate directories and listener ports.
export async function startIngress(directory: string, startPort: number, parent: ParentOriginPublisher, gateways: Record<string, URL>) {
  const ingress = createWorkspaceIngress({
    hostname: "127.0.0.1",
    originPortRange: { start: startPort, end: startPort + 20 },
    originIdentityStore: createFileOriginIdentityStore(join(directory, "origins.json")),
    parentOriginPublisher: parent,
    resolveWorkspace(id) { if (!gateways[id]) throw new Error("unknown workspace"); },
    resolveApp() { return undefined; },
    resolvePort(id, port, protocol, url) {
      return { kind: "http", target: new URL(`${protocol}://127.0.0.1:${port}${url.pathname}${url.search}`), gateway: { url: gateways[id]!, token: id } };
    },
  });
  const sockets = createWorkspaceIngressSockets(ingress, join(directory, "sockets"));
  for (const id of Object.keys(gateways)) await sockets.ensure(id);
  await ingress.initialize();
  return { ingress, socket: (id: string) => join(directory, "sockets", id, "ingress.sock"), async stop() { sockets.stop(); await ingress.stopAll(); } };
}
