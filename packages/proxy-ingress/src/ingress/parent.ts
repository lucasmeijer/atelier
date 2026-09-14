import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { request } from "node:http";
import { createTailscaleOriginPublisher, defaultTailscaleLocalApiSocketPath, tailscaleLocalApiRequest, type PortRange } from "./tailscale-serve.ts";

export interface ParentOriginPublisher {
  kind: "atelier" | "tailscale" | "localhost";
  publish(port: number): Promise<string>;
  unpublish?(port: number): Promise<void>;
}
export const parentIngressSocket = "/run/atelier-parent/ingress.sock";
export function createLocalOriginPublisher(): ParentOriginPublisher {
  return { kind: "localhost", async publish(port) { return `http://localhost:${port}`; } };
}
export function createParentAtelierPublisher(socketPath = parentIngressSocket): ParentOriginPublisher {
  return { kind: "atelier", async publish(port) {
    const body = JSON.stringify({ port, protocol: "http" });
    const result = await new Promise<string>((resolve, reject) => {
      const req = request({ socketPath, path: "/origins", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          if (response.statusCode !== 200) reject(new Error(`Parent ingress publication failed: HTTP ${response.statusCode}: ${text}`));
          else resolve(text);
        });
      });
      req.on("error", reject);
      req.setTimeout(30_000, () => req.destroy(new Error("Parent ingress publication timed out")));
      req.end(body);
    });
    const parsed = JSON.parse(result) as { origin?: unknown };
    if (typeof parsed.origin !== "string") throw new Error("Parent ingress did not return an origin");
    const url = new URL(parsed.origin);
    if (!["https:", "http:"].includes(url.protocol) || url.origin !== parsed.origin || url.username || url.password) throw new Error("Parent ingress returned an invalid origin");
    return url.origin;
  } };
}

/** A mounted parent directory is configuration even while its server is down. */
export async function detectParentOriginPublisher(portRange?: PortRange): Promise<ParentOriginPublisher> {
  if (existsSync("/run/atelier-parent")) return createParentAtelierPublisher();
  if (existsSync(dirname(defaultTailscaleLocalApiSocketPath))) {
    const status = JSON.parse(await tailscaleLocalApiRequest(defaultTailscaleLocalApiSocketPath, "GET", "/localapi/v0/status"));
    const host = status.Self?.DNSName?.replace(/\.$/, "");
    if (!host) throw new Error("Tailscale has no DNS name; connect Tailscale before starting ingress");
    const publisher = createTailscaleOriginPublisher({ host, portRange });
    return { kind: "tailscale", async publish(port) { await publisher.publish(port); return `https://${host}:${port}`; }, unpublish: (port) => publisher.unpublish(port) };
  }
  return createLocalOriginPublisher();
}
