// Portions adapted from @earendil-works/gondolin, Apache-2.0.
// Source: https://github.com/earendil-works/gondolin

import crypto from "node:crypto";
import { HttpRequestBlockedError } from "./errors.ts";
import { isInternalAddress } from "./ip.ts";
import { matchesAnyHost, normalizeHostnamePattern } from "./patterns.ts";
import { ON_REQUEST_EARLY_POLICY_SAFE, type HttpHooks } from "./types.ts";

export type SecretDefinition = { hosts: string[]; value: string; placeholder?: string | (() => string) };
export type CreateHttpHooksOptions = {
  allowedHosts?: string[];
  allowedInternalHosts?: string[];
  secrets?: Record<string, SecretDefinition>;
  replaceSecretsInQuery?: boolean;
  blockInternalRanges?: boolean;
  isRequestAllowed?: HttpHooks["isRequestAllowed"];
  isIpAllowed?: HttpHooks["isIpAllowed"];
  onRequest?: HttpHooks["onRequest"];
  onResponse?: HttpHooks["onResponse"];
};
export type UpdateSecretOptions = { value?: string; hosts?: string[] };
export type SecretManagerEntry = { name: string; placeholder: string; hosts: string[]; deleted: boolean };
export type SecretManager = {
  listSecrets(): SecretManagerEntry[];
  updateSecret(name: string, options: UpdateSecretOptions): void;
  deleteSecret(name: string): void;
};
export type CreateHttpHooksResult = { httpHooks: HttpHooks; env: Record<string, string>; allowedHosts: string[]; secretManager: SecretManager };

type SecretEntry = { name: string; placeholder: string; value: string; revokedValues: string[]; hosts: string[]; deleted: boolean };

export function createHttpHooks(options: CreateHttpHooksOptions = {}): CreateHttpHooksResult {
  const env: Record<string, string> = {};
  const blockInternalRanges = options.blockInternalRanges ?? true;
  const configuredAllowedHosts = options.allowedHosts === undefined ? ["*"] : uniqueHosts(options.allowedHosts);
  const allowedInternalHosts = uniqueHosts(options.allowedInternalHosts ?? []);
  const allowedHosts = configuredAllowedHosts.includes("*") ? ["*"] : uniqueHosts([...configuredAllowedHosts, ...allowedInternalHosts]);
  const secretEntries = new Map<string, SecretEntry>();

  for (const [name, secret] of Object.entries(options.secrets ?? {})) {
    const placeholder = resolveSecretPlaceholder(name, secret);
    assertSecretPlaceholderIsSafe(name, placeholder, secret.value, secretEntries.values());
    env[name] = placeholder;
    secretEntries.set(name, { name, placeholder, value: secret.value, revokedValues: [], hosts: uniqueHosts(secret.hosts), deleted: false });
  }

  const getEntries = () => Array.from(secretEntries.values());
  const getEntry = (name: string) => {
    const entry = secretEntries.get(name);
    if (!entry) throw new Error(`unknown secret: ${name}`);
    return entry;
  };

  const secretManager: SecretManager = {
    listSecrets: () => getEntries().map((entry) => ({ name: entry.name, placeholder: entry.placeholder, hosts: [...entry.hosts], deleted: entry.deleted })),
    updateSecret(name, update) {
      const entry = getEntry(name);
      if (entry.deleted) throw new Error(`secret deleted: ${name}`);
      if (update.value === entry.placeholder) throw new Error(`secret value must not equal placeholder: ${name}`);
      if (update.hosts !== undefined) entry.hosts = uniqueHosts(update.hosts);
      if (update.value !== undefined && update.value !== entry.value) {
        entry.revokedValues = addUniqueString(entry.revokedValues, entry.value);
        entry.value = update.value;
        entry.revokedValues = entry.revokedValues.filter((value) => value !== entry.value);
      }
    },
    deleteSecret(name) { getEntry(name).deleted = true; },
  };

  const applySecretsToRequest = (request: Request): Request => {
    assertRequestShape(request);
    const hostname = getHostname(request.url);
    const entries = getEntries();
    assertSecretValuesAllowedForHost(request, hostname, entries, options.replaceSecretsInQuery ?? false);
    const headers = replaceSecretPlaceholdersInHeaders(request.headers, hostname, entries);
    const url = replaceSecretPlaceholdersInUrlParameters(request.url, hostname, entries, options.replaceSecretsInQuery ?? false);
    if (url === request.url) {
      if (headers !== request.headers) syncHeaders(request.headers, headers);
      return request;
    }
    return cloneRequestWith(request, { url, headers });
  };

  const onRequest: NonNullable<HttpHooks["onRequest"]> = async (request) => {
    let nextRequest = request;
    if (options.onRequest) {
      const updated = await options.onRequest(nextRequest);
      if (updated) {
        if ("status" in updated) return normalizeResponse(updated);
        assertRequestShape(updated);
        nextRequest = updated;
      }
    }
    return applySecretsToRequest(nextRequest);
  };
  onRequest[ON_REQUEST_EARLY_POLICY_SAFE] = !options.onRequest;

  return {
    env,
    allowedHosts,
    secretManager,
    httpHooks: {
      isRequestAllowed: options.isRequestAllowed ?? (() => true),
      isIpAllowed: async (info) => {
        if (!matchesAnyHost(info.hostname, allowedHosts)) return false;
        if (blockInternalRanges && isInternalAddress(info.ip) && !matchesAnyHost(info.hostname, allowedInternalHosts)) return false;
        return options.isIpAllowed ? options.isIpAllowed(info) : true;
      },
      onRequest,
      onResponse: options.onResponse,
    },
  };
}

function resolveSecretPlaceholder(name: string, secret: SecretDefinition): string {
  const placeholder = secret.placeholder === undefined ? makeDefaultSecretPlaceholder() : typeof secret.placeholder === "function" ? secret.placeholder() : secret.placeholder;
  if (!placeholder) throw new Error(`invalid placeholder for secret: ${name}`);
  return placeholder;
}

export function makeDefaultSecretPlaceholder(): string {
  return `ATELIER_SECRET_${crypto.randomBytes(24).toString("hex")}`;
}

function assertSecretPlaceholderIsSafe(name: string, placeholder: string, value: string, existingEntries: Iterable<SecretEntry>): void {
  // In nested Atelier, an inherited outer placeholder can be the inner layer's
  // effective secret value. Allow value === placeholder so the inner proxy can
  // pass that placeholder onward for the outer proxy to inject.
  for (const entry of existingEntries) {
    if (placeholder === entry.placeholder) throw new Error(`duplicate secret placeholder: ${placeholder}`);
    if (placeholder.includes(entry.placeholder) || entry.placeholder.includes(placeholder)) {
      throw new Error(`secret placeholder for ${name} overlaps with secret placeholder for ${entry.name}`);
    }
  }
}

function cloneRequestWith(request: Request, options: { url: string; headers: Headers }): Request {
  const method = request.method.toUpperCase();
  const canHaveBody = method !== "GET" && method !== "HEAD";
  return new Request(options.url, { method: request.method, headers: options.headers, body: canHaveBody ? request.body : undefined, ...(canHaveBody && request.body ? ({ duplex: "half" } as const) : {}) });
}
function normalizeResponse(response: Response): Response { return new Response(response.body, { status: response.status, statusText: response.statusText, headers: new Headers(response.headers) }); }
function assertRequestShape(value: unknown): asserts value is Request { if (typeof value !== "object" || value === null || typeof (value as any).url !== "string" || typeof (value as any).headers?.forEach !== "function") throw new TypeError("onRequest must return Request, Response, or undefined"); }
function syncHeaders(target: Headers, source: Headers): void { const keys = new Set<string>(); source.forEach((_v, k) => keys.add(k.toLowerCase())); const del: string[] = []; target.forEach((_v, k) => { if (!keys.has(k.toLowerCase())) del.push(k); }); del.forEach((k) => target.delete(k)); source.forEach((v, k) => target.set(k, v)); }
function getHostname(url: string): string { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } }

function assertSecretValuesAllowedForHost(request: Request, hostname: string, entries: SecretEntry[], checkQuery: boolean) {
  for (const entry of entries) {
    const activeValue = entry.deleted ? [] : [entry.value];
    if (containsForbiddenHeaders(request.headers, entry.revokedValues, activeValue) || (checkQuery && containsForbiddenQuery(request.url, entry.revokedValues, activeValue))) throw new HttpRequestBlockedError(`secret ${entry.name} revoked for host: ${hostname || "unknown"}`);
    if (entry.deleted) {
      if (containsForbiddenHeaders(request.headers, [entry.value], []) || (checkQuery && containsForbiddenQuery(request.url, [entry.value], []))) throw new HttpRequestBlockedError(`secret ${entry.name} deleted for host: ${hostname || "unknown"}`);
      continue;
    }
    if (matchesAnyHost(hostname, entry.hosts)) continue;
    if (requestContainsSecretValuesInHeaders(request.headers, [entry.value]) || (checkQuery && requestContainsSecretValuesInQuery(request.url, [entry.value]))) throw new HttpRequestBlockedError(`secret ${entry.name} not allowed for host: ${hostname || "unknown"}`);
  }
}

function requestContainsSecretValuesInHeaders(headers: Headers, values: string[]): boolean {
  const nonEmpty = values.filter(Boolean);
  for (const [name, value] of headers.entries()) {
    for (const secret of nonEmpty) if (value.includes(secret) || (/^(authorization|proxy-authorization)$/i.test(name) && (decodeBasicAuth(value)?.includes(secret)))) return true;
  }
  return false;
}
function requestContainsSecretValuesInQuery(url: string, values: string[]): boolean { try { const parsed = new URL(url); return [...parsed.searchParams].some(([n, v]) => values.filter(Boolean).some((s) => n.includes(s) || v.includes(s))); } catch { return false; } }
function containsForbiddenHeaders(headers: Headers, forbidden: string[], allowed: string[]): boolean { const f = forbidden.filter(Boolean); if (!f.length) return false; for (const [name, value] of headers.entries()) { const decoded = /^(authorization|proxy-authorization)$/i.test(name) ? decodeBasicAuthStrict(value) : null; if (containsForbiddenValueOutsideAllowedRanges(decoded ?? value, f, allowed.filter(Boolean))) return true; } return false; }
function containsForbiddenQuery(url: string, forbidden: string[], allowed: string[]): boolean { const f = forbidden.filter(Boolean); if (!f.length) return false; try { for (const [n, v] of new URL(url).searchParams) if (containsForbiddenValueOutsideAllowedRanges(n, f, allowed.filter(Boolean)) || containsForbiddenValueOutsideAllowedRanges(v, f, allowed.filter(Boolean))) return true; } catch {} return false; }
function decodeBasicAuth(value: string): string | null { const match = value.match(/^(Basic)(\s+)(\S+)(\s*)$/i); if (!match) return null; try { return Buffer.from(match[3]!, "base64").toString("utf8"); } catch { return null; } }
function decodeBasicAuthStrict(value: string): string | null { const match = value.match(/^(Basic)(\s+)(\S+)(\s*)$/i); if (!match) return null; const token = match[3]!; if (!/^[A-Za-z0-9+/]+={0,2}$/.test(token) || token.length % 4 === 1) return null; const decoded = Buffer.from(token, "base64").toString("utf8"); return stripBase64Padding(Buffer.from(decoded, "utf8").toString("base64")) === stripBase64Padding(token) ? decoded : null; }
function stripBase64Padding(value: string): string { return value.replace(/=+$/g, ""); }
function containsForbiddenValueOutsideAllowedRanges(container: string, forbidden: string[], allowed: string[]): boolean { const allowedRanges = allowed.flatMap((v) => collectStringMatchRanges(container, v)); return forbidden.some((v) => collectStringMatchRanges(container, v).some((r) => !allowedRanges.some((a) => a.start <= r.start && a.end >= r.end))); }
function collectStringMatchRanges(container: string, search: string): Array<{ start: number; end: number }> { const out: Array<{ start: number; end: number }> = []; if (!search) return out; for (let start = container.indexOf(search); start !== -1; start = container.indexOf(search, start + 1)) out.push({ start, end: start + search.length }); return out; }

function replaceSecretPlaceholdersInHeaders(incomingHeaders: Headers, hostname: string, entries: SecretEntry[]): Headers {
  let headers: Headers | null = null;
  for (const [headerName, value] of incomingHeaders.entries()) {
    let updated = replaceSecretPlaceholdersInString(value, hostname, entries);
    updated = replaceBasicAuthSecretPlaceholders(headerName, updated, hostname, entries);
    if (updated !== value) { headers ??= new Headers(incomingHeaders); headers.set(headerName, updated); }
  }
  return headers ?? incomingHeaders;
}
function replaceSecretPlaceholdersInUrlParameters(url: string, hostname: string, entries: SecretEntry[], enabled: boolean): string {
  if (!enabled) return url;
  try {
    const parsed = new URL(url); let changed = false; const params = new URLSearchParams();
    for (const [n, v] of parsed.searchParams) { const nn = replaceSecretPlaceholdersInString(n, hostname, entries); const vv = replaceSecretPlaceholdersInString(v, hostname, entries); changed ||= nn !== n || vv !== v; params.append(nn, vv); }
    if (!changed) return url; parsed.search = params.toString(); return parsed.toString();
  } catch { return url; }
}
function replaceBasicAuthSecretPlaceholders(headerName: string, headerValue: string, hostname: string, entries: SecretEntry[]): string {
  if (!/^(authorization|proxy-authorization)$/i.test(headerName)) return headerValue;
  const match = headerValue.match(/^(Basic)(\s+)(\S+)(\s*)$/i); if (!match) return headerValue;
  const decoded = decodeBasicAuth(headerValue); if (!decoded) return headerValue;
  const updated = replaceSecretPlaceholdersInString(decoded, hostname, entries);
  return updated === decoded ? headerValue : `${match[1]}${match[2]}${Buffer.from(updated, "utf8").toString("base64")}${match[4] ?? ""}`;
}
function replaceSecretPlaceholdersInString(value: string, hostname: string, entries: SecretEntry[]): string {
  const secretValueRanges = entries.flatMap((entry) => collectStringMatchRanges(value, entry.value));
  const replacements = entries.flatMap((entry) => collectStringMatchRanges(value, entry.placeholder).filter((range) => !secretValueRanges.some((s) => s.start <= range.start && s.end >= range.end)).map((range) => ({ ...range, entry })));
  if (!replacements.length) return value;
  replacements.sort((a, b) => a.start - b.start || b.end - a.end);
  let updated = ""; let offset = 0;
  for (const replacement of replacements) {
    if (replacement.start < offset) continue;
    updated += value.slice(offset, replacement.start);
    if (replacement.entry.deleted) throw new HttpRequestBlockedError(`secret ${replacement.entry.name} deleted for host: ${hostname || "unknown"}`);
    if (!matchesAnyHost(hostname, replacement.entry.hosts)) throw new HttpRequestBlockedError(`secret ${replacement.entry.name} not allowed for host: ${hostname || "unknown"}`);
    updated += replacement.entry.value;
    offset = replacement.end;
  }
  return updated + value.slice(offset);
}
function uniqueHosts(hosts: string[]): string[] { return [...new Set(hosts.map(normalizeHostnamePattern).filter(Boolean))]; }
function addUniqueString(values: string[], value: string): string[] { return value && !values.includes(value) ? [...values, value] : values; }
