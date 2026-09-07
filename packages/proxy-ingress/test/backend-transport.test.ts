import { describe, expect, test } from "bun:test";
import { isWorkspaceAppPort, workspaceGatewayPort, type WorkspaceHttpAppBackend } from "@atelier/shared";
import { backendTransport } from "../src/ingress/backend-transport.ts";

function backend(target: string): WorkspaceHttpAppBackend {
  return { kind: "http", target: new URL(target), gateway: { url: new URL("http://127.0.0.1:45678"), token: "workspace-secret" } };
}

describe("workspace gateway transport", () => {
  test("accepts app ports across the entire TCP range except its own listener", () => {
    for (const port of [1, 80, 443, 3000, 5173, 8000, 8080, 65535]) expect(isWorkspaceAppPort(port)).toBe(true);
    for (const port of [0, -1, 65536, NaN, 12.5, workspaceGatewayPort]) expect(isWorkspaceAppPort(port)).toBe(false);
  });

  test("connects directly to the gateway without losing path, host, or app auth", () => {
    const headers = new Headers({ host: "preview.example:41000", authorization: "Bearer app-token", "x-atelier-gateway-token": "forged", "x-atelier-gateway-port": "22", "x-atelier-gateway-protocol": "file", "proxy-authorization": "forged" });
    const transport = backendTransport(backend("https://127.0.0.1:5173//a%2Fb?x=%2F&x=2"), headers);
    expect(transport.target.toString()).toBe("http://127.0.0.1:45678//a%2Fb?x=%2F&x=2");
    expect(Object.fromEntries(transport.headers)).toEqual({
      host: "preview.example:41000",
      authorization: "Bearer app-token",
      "x-atelier-gateway-host": "preview.example:41000",
      "x-atelier-gateway-token": "workspace-secret",
      "x-atelier-gateway-port": "5173",
      "x-atelier-gateway-protocol": "https",
    });
    expect(headers.get("x-atelier-gateway-token")).toBe("forged");
  });

  test("routes default HTTP and HTTPS ports correctly", () => {
    for (const [url, port] of [["http://127.0.0.1/", "80"], ["https://127.0.0.1/", "443"]]) {
      expect(backendTransport(backend(url!), new Headers()).headers.get("x-atelier-gateway-port")).toBe(port!);
    }
  });

  test("does not forward internal credentials to non-gateway backends", () => {
    const transport = backendTransport({ kind: "http", target: new URL("http://127.0.0.1:5173/") }, new Headers({ "x-atelier-gateway-token": "forged", "x-atelier-gateway-port": "22", "x-atelier-gateway-protocol": "http", "proxy-authorization": "forged" }));
    expect([...transport.headers]).toEqual([]);
  });

  test("rejects non-local, reserved, and non-web destinations", () => {
    for (const target of ["http://example.com:5173/", "http://127.0.0.1:2999/", "ftp://127.0.0.1:5173/"]) {
      expect(() => backendTransport(backend(target), new Headers())).toThrow("workspace-local");
    }
  });
});
