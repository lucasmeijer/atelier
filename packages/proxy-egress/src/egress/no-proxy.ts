import { readFile } from "node:fs/promises";
import { join } from "node:path";

type WorkspaceProxyManifest = { noProxy?: unknown; proxy?: { noProxy?: unknown } };

export function defaultNoProxyEntries(): string[] {
  return [
    "localhost",
    "127.0.0.1",
    "::1",
    ...parseNoProxyValue(process.env.ATELIER_WORKSPACE_PROXY_NO_PROXY),
    // Legacy/public Atelier domains should be reached directly. The egress
    // proxy can downgrade/MITM TLS to HTTP/1.1 for secret injection, which
    // breaks strict HTTP/2 clients such as Subito's gRPC uploader.
    ...domainNoProxyEntries("luther.lucasmeijer.com"),
    ...domainNoProxyEntries("shockwaving.com"),
  ];
}

function domainNoProxyEntries(domain: string | undefined): string[] {
  const normalized = domain?.trim().toLowerCase().replace(/^\*\./, "").replace(/^\./, "").replace(/\.$/, "");
  return normalized ? [normalized, `.${normalized}`, `*.${normalized}`] : [];
}

export function uniqueNoProxyEntries(entries: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of entries) {
    for (const entry of expandNoProxyEntry(raw)) {
      const key = entry.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(entry);
    }
  }
  return result;
}

function expandNoProxyEntry(raw: string): string[] {
  const entry = raw.trim();
  if (!entry) return [];
  const wildcard = entry.match(/^\*\.([^,\s]+)$/);
  return wildcard ? [entry, `.${wildcard[1]}`] : [entry];
}

export async function readWorkspaceNoProxyEntries(workHostPath: string): Promise<string[]> {
  const manifestPath = join(workHostPath, ".atelier", "workspace.json");
  let manifest: WorkspaceProxyManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as WorkspaceProxyManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return uniqueNoProxyEntries([...parseNoProxyValue(manifest.noProxy), ...parseNoProxyValue(manifest.proxy?.noProxy)]);
}

function parseNoProxyValue(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") return value.split(",");
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
  throw new Error("workspace manifest noProxy must be a string or array of strings");
}
