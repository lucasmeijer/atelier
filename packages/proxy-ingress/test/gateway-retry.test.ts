import { expect, test } from "bun:test";
import { workspaceGatewayErrorHeader } from "@atelier/shared";
import { createWorkspaceIngress } from "../src/ingress/index.ts";

for (const method of ["GET", "HEAD", "POST"]) {
  test(`gateway transport failure retries only safe requests: ${method}`, async () => {
    let attempts = 0;
    let failing = true;
    const gateway = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch() {
        attempts += 1;
        return failing
          ? new Response("connection refused", { status: 502, headers: { [workspaceGatewayErrorHeader]: "upstream" } })
          : new Response("recovered");
      },
    });
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port!;
    probe.stop(true);
    const ingress = createWorkspaceIngress({
      hostname: "127.0.0.1",
      originPortRange: { start: port, end: port },
      resolveWorkspace() {},
      resolveApp: () => ({ kind: "http", target: new URL("http://127.0.0.1:5173/"), gateway: { url: new URL(gateway.url), token: "test" } }),
    });
    try {
      const opened = await ingress.openCanonical({ workspaceId: "retry", appKey: "app" }, "/", new Request("http://127.0.0.1:3000/"));
      const origin = opened.headers.get("location")!;
      const response = await fetch(origin, { method, proxy: origin });
      expect(response.status).toBe(503);
      expect(response.headers.get(workspaceGatewayErrorHeader)).toBeNull();
      await response.text();
      expect(attempts).toBe(method === "POST" ? 1 : 3);
      expect(ingress.inspect()[0]!.targetState).toBe("failed");
      expect(ingress.inspect()[0]!.failureCategory).toBe("connection_refused");
      failing = false;
      const recovered = await fetch(origin, { proxy: origin });
      expect(await recovered.text()).toBe("recovered");
      expect(ingress.inspect()[0]!.targetState).toBe("active");
      expect(ingress.inspect()[0]!.lastFailure).toBeUndefined();
    } finally {
      await ingress.stopAll();
      gateway.stop(true);
    }
  });
}
