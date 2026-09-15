import { expect, test } from "bun:test";
import { workspaceGatewayErrorHeader } from "@atelier/shared";
import { createWorkspaceIngress, type WorkspaceIngress } from "../src/ingress/index.ts";

async function withGateway(
  respond: () => Response,
  exercise: (ingress: WorkspaceIngress, request: (method?: string) => Promise<Response>) => Promise<void>,
) {
  const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: respond });
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
    const opened = await ingress.openCanonical({ workspaceId: "test", appKey: "app" }, "/");
    const origin = opened.headers.get("location")!;
    await exercise(ingress, (method = "GET") => fetch(origin, { method, proxy: origin }));
  } finally {
    await ingress.stopAll();
    gateway.stop(true);
  }
}

for (const method of ["GET", "HEAD", "POST"]) {
  test(`gateway transport failure retries only safe requests: ${method}`, async () => {
    let attempts = 0;
    let failing = true;
    await withGateway(() => {
      attempts++;
      return failing
        ? new Response("connection refused", { status: 502, headers: { [workspaceGatewayErrorHeader]: "upstream" } })
        : new Response("recovered");
    }, async (ingress, request) => {
      const response = await request(method);
      expect(response.status).toBe(503);
      expect(response.headers.get(workspaceGatewayErrorHeader)).toBeNull();
      await response.body?.cancel();
      expect(attempts).toBe(method === "POST" ? 1 : 3);
      expect(ingress.inspect()[0]!.targetState).toBe("failed");
      expect(ingress.inspect()[0]!.failureCategory).toBe("connection_refused");
      failing = false;
      expect(await (await request()).text()).toBe("recovered");
      expect(ingress.inspect()[0]!.targetState).toBe("active");
      expect(ingress.inspect()[0]!.lastFailure).toBeUndefined();
    });
  });
}

for (const status of [401, 500, 502]) {
  test(`unmarked app HTTP ${status} is forwarded without retry or ingress failure`, async () => {
    let attempts = 0;
    await withGateway(() => {
      attempts++;
      return new Response("app response", { status });
    }, async (ingress, request) => {
      const response = await request();
      expect(response.status).toBe(status);
      expect(await response.text()).toBe("app response");
      expect(attempts).toBe(1);
      expect(ingress.inspect()[0]!.targetState).toBe("active");
    });
  });
}

test("gateway authentication failures are not app login responses and are not retried", async () => {
  let attempts = 0;
  await withGateway(() => {
    attempts++;
    return new Response("denied", { status: 401, headers: { [workspaceGatewayErrorHeader]: "authentication" } });
  }, async (ingress, request) => {
    const response = await request();
    expect(response.status).toBe(502);
    await response.body?.cancel();
    expect(attempts).toBe(1);
    expect(ingress.inspect()[0]!.failureCategory).toBe("workspace_authentication");
  });
});
