import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  defaultPublicOriginPortRange,
  defaultTailscaleLocalApiSocketPath,
  ensureTailscaleServePortConfig,
  mutateTailscaleServeConfig,
  normalizeServeHost,
  pruneTailscaleServePortConfig,
  syncTailscaleServePortConfig,
  tailscaleLocalApiRequest,
  validateManagedPort,
} from "./tailscale-serve.ts";

const targetHost = "127.0.0.1";

const tailscaleStatusSchema = Type.Object({
  Self: Type.Object({ DNSName: Type.String() }),
});

async function main(args: string[]): Promise<void> {
  if (process.getuid?.() !== 0) throw new Error("atelier-tailscale-serve-helper must run as root");

  const [command, hostArg, ...portArgs] = args;
  if (!command || !hostArg) usage();

  const host = normalizeServeHost(hostArg);
  await requireLocalTailscaleHost(host);

  switch (command) {
    case "ensure": {
      const port = parseSinglePort(portArgs);
      await mutateTailscaleServeConfig(defaultTailscaleLocalApiSocketPath, (config) => ensureTailscaleServePortConfig(config, { host, port, targetHost }));
      return;
    }
    case "release": {
      const port = parseSinglePort(portArgs);
      await mutateTailscaleServeConfig(defaultTailscaleLocalApiSocketPath, (config) => pruneTailscaleServePortConfig(config, { host, port, targetHost }));
      return;
    }
    case "sync": {
      const activePorts = new Set(portArgs.map(parsePort));
      await mutateTailscaleServeConfig(defaultTailscaleLocalApiSocketPath, (config) => syncTailscaleServePortConfig(config, { host, activePorts, targetHost }));
      return;
    }
    default:
      usage();
  }
}

function parseSinglePort(args: string[]): number {
  if (args.length !== 1) usage();
  return parsePort(args[0]);
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`invalid Tailscale Serve port: ${value}`);
  const port = Number(value);
  validateManagedPort(port, defaultPublicOriginPortRange);
  return port;
}

async function requireLocalTailscaleHost(host: string): Promise<void> {
  const body = await tailscaleLocalApiRequest(defaultTailscaleLocalApiSocketPath, "GET", "/localapi/v0/status");
  const parsed: unknown = JSON.parse(body);
  if (!Value.Check(tailscaleStatusSchema, parsed)) {
    throw new Error("Tailscale status response does not contain this node's DNS name");
  }
  const dnsName = normalizeServeHost(parsed.Self.DNSName);
  if (host !== dnsName) throw new Error(`Tailscale Serve host ${host} does not match this node (${dnsName})`);
}

function usage(): never {
  throw new Error("usage: atelier-tailscale-serve-helper ensure|release <host> <port> | sync <host> [port ...]");
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
