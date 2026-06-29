export function defaultNoProxyEntries(): string[] {
  return [
    "localhost",
    "127.0.0.1",
    "::1",
    ...(process.env.ATELIER_WORKSPACE_PROXY_NO_PROXY?.split(",") ?? []),
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
