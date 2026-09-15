import { Type } from "typebox";
import { Value } from "typebox/value";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { request } from "node:http";
import { createTailscaleOriginPublisher, defaultTailscaleLocalApiSocketPath, tailscaleLocalApiRequest, type PortRange } from "./tailscale-serve.ts";

const originSchema = Type.Object({ origin: Type.String() });
const statusSchema = Type.Object({ BackendState: Type.Literal("Running"), Self: Type.Object({ DNSName: Type.String() }) });

export interface ParentOriginPublisher {
  kind: "atelier" | "tailscale" | "localhost" | "system";
  refresh?: boolean;
  publish(port: number): Promise<string>;
  unpublish?(port: number): Promise<void>;
}
export const parentIngressSocket = "/run/atelier-parent/ingress.sock";
export function createLocalOriginPublisher(): ParentOriginPublisher {
  return { kind: "localhost", async publish(port) { return `http://localhost:${port}`; } };
}
export function createParentAtelierPublisher(socketPath = parentIngressSocket): ParentOriginPublisher {
  return { kind: "atelier", refresh: true, async publish(port) {
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
    const parsed: unknown = JSON.parse(result);
    if (!Value.Check(originSchema, parsed)) throw new Error("Parent ingress did not return an origin");
    const url = new URL(parsed.origin);
    if (!["https:", "http:"].includes(url.protocol) || url.origin !== parsed.origin || url.username || url.password) throw new Error("Parent ingress returned an invalid origin");
    return url.origin;
  } };
}

/** Resolve identity when publishing: first-install login can happen after app startup. */
export function createTailscaleParentPublisher(socketPath = defaultTailscaleLocalApiSocketPath, portRange?: PortRange): ParentOriginPublisher {
  async function connectedPublisher() {
    const status: unknown = JSON.parse(await tailscaleLocalApiRequest(socketPath, "GET", "/localapi/v0/status"));
    if (!Value.Check(statusSchema, status)) throw new Error("Tailscale has no DNS name; connect Tailscale before publishing a preview");
    const host = status.Self.DNSName.replace(/\.$/, "");
    if (!host) throw new Error("Tailscale has no DNS name; connect Tailscale before publishing a preview");
    return { host, publisher: createTailscaleOriginPublisher({ host, socketPath, portRange }) };
  }
  return {
    kind: "tailscale",
    async publish(port) {
      const { host, publisher } = await connectedPublisher();
      await publisher.publish(port);
      return `https://${host}:${port}`;
    },
    async unpublish(port) {
      const { publisher } = await connectedPublisher();
      await publisher.unpublish(port);
    },
  };
}

/** The selected mode is independent from a mounted Tailscale socket. */
export function createSystemOriginPublisher(portRange?: PortRange, fetcher: (url: string) => Promise<Response> = fetch): ParentOriginPublisher {
  const tailscale = createTailscaleParentPublisher(defaultTailscaleLocalApiSocketPath, portRange);
  return { kind: "system", refresh: true, async publish(port) {
    const response = await fetcher("http://127.0.0.1:3001/access");
    if (!response.ok) throw new Error(`System access status failed: ${response.status}`);
    const status: unknown = await response.json();
    if (!Value.Check(Type.Object({ mode: Type.Union([Type.Literal("localhost"), Type.Literal("tailscale")]), localPort: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })) }), status)) throw new Error("Invalid System access status");
    if (status.mode === "tailscale") return tailscale.publish(port);
    if (!status.localPort) throw new Error("System's local port has not been published yet");
    return `http://p${port}.atelier.localhost:${status.localPort}`;
  } };
}

/** A mounted parent directory is configuration even while its server is down. */
export async function detectParentOriginPublisher(portRange?: PortRange): Promise<ParentOriginPublisher> {
  if (existsSync("/run/atelier-parent")) return createParentAtelierPublisher();
  if (existsSync("/run/atelier-system/resources.json")) return createSystemOriginPublisher(portRange);
  if (existsSync(dirname(defaultTailscaleLocalApiSocketPath))) return createTailscaleParentPublisher(defaultTailscaleLocalApiSocketPath, portRange);
  return createLocalOriginPublisher();
}
