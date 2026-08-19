// Portions adapted from @earendil-works/gondolin, Apache-2.0.
// Source: https://github.com/earendil-works/gondolin

import crypto from "node:crypto";
import { HttpRequestBlockedError } from "./errors.ts";
import { isInternalAddress } from "./ip.ts";
import { matchesAnyHost, normalizeHostnamePattern } from "./patterns.ts";
import { ON_REQUEST_EARLY_POLICY_SAFE, type HttpHooks } from "./types.ts";

export type SecretDefinition = { hosts: string[]; value: string; placeholder?: string };
export type CreateHttpHooksOptions = {
  allowedHosts?: string[];
  allowedInternalHosts?: string[];
  secrets?: Record<string, SecretDefinition>;
  replaceSecretsInPath?: boolean;
  replaceSecretsInQuery?: boolean;
  blockInternalRanges?: boolean;
  isRequestAllowed?: HttpHooks["isRequestAllowed"];
  isIpAllowed?: HttpHooks["isIpAllowed"];
  onRequest?: HttpHooks["onRequest"];
  onResponse?: HttpHooks["onResponse"];
};
export type SecretInfo = { name: string; placeholder: string; hosts: string[] };
export type RequestTransformHttpHooks = Omit<HttpHooks, "onRequest"> & {
  onRequest(request: Request): Promise<Request>;
};
export type CreateHttpHooksResult<Hooks extends HttpHooks = HttpHooks> = { httpHooks: Hooks; env: Record<string, string>; allowedHosts: string[]; secrets: SecretInfo[] };

type SecretEntry = { name: string; placeholder: string; value: string; hosts: string[] };

export function createHttpHooks(options?: CreateHttpHooksOptions & { onRequest?: undefined }): CreateHttpHooksResult<RequestTransformHttpHooks>;
export function createHttpHooks(options: CreateHttpHooksOptions): CreateHttpHooksResult;
export function createHttpHooks(options: CreateHttpHooksOptions = {}): CreateHttpHooksResult {
  const env: Record<string, string> = {};
  const blockInternalRanges = options.blockInternalRanges ?? true;
  const configuredAllowedHosts = options.allowedHosts === undefined ? ["*"] : uniqueHosts(options.allowedHosts);
  const allowedInternalHosts = uniqueHosts(options.allowedInternalHosts ?? []);
  const allowedHosts = configuredAllowedHosts.includes("*") ? ["*"] : uniqueHosts([...configuredAllowedHosts, ...allowedInternalHosts]);
  const secretEntries = new Map<string, SecretEntry>();

  for (const [name, secret] of Object.entries(options.secrets ?? {})) {
    const placeholder = secret.placeholder ?? makeDefaultSecretPlaceholder();
    if (!placeholder) throw new Error(`invalid placeholder for secret: ${name}`);
    assertSecretPlaceholderIsSafe(name, placeholder, secretEntries.values());
    env[name] = placeholder;
    secretEntries.set(name, { name, placeholder, value: secret.value, hosts: uniqueHosts(secret.hosts) });
  }

  const getEntries = () => Array.from(secretEntries.values());
  const secrets = getEntries().map((entry) => ({ name: entry.name, placeholder: entry.placeholder, hosts: [...entry.hosts] }));

  const applySecretsToRequest = (request: Request): Request => {
    const hostname = getHostname(request.url);
    const entries = getEntries();
    assertSecretValuesAllowedForHost(request, hostname, entries, options.replaceSecretsInQuery ?? false);
    const headers = replaceSecretPlaceholdersInHeaders(request.headers, hostname, entries);
    const url = replaceSecretPlaceholdersInUrl(request.url, hostname, entries, options.replaceSecretsInPath ?? false, options.replaceSecretsInQuery ?? false);
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
      if (updated instanceof Response) return updated;
      if (updated) nextRequest = updated;
    }
    return applySecretsToRequest(nextRequest);
  };
  onRequest[ON_REQUEST_EARLY_POLICY_SAFE] = !options.onRequest;

  return {
    env,
    allowedHosts,
    secrets,
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

export function makeDefaultSecretPlaceholder(): string {
  return `ATELIER_SECRET_${crypto.randomBytes(24).toString("hex")}`;
}

function assertSecretPlaceholderIsSafe(name: string, placeholder: string, existingEntries: Iterable<SecretEntry>): void {
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
  const init: RequestInit & { duplex?: "half" } = { method: request.method, headers: options.headers, body: canHaveBody ? request.body : undefined };
  if (canHaveBody && request.body) init.duplex = "half";
  return new Request(options.url, init);
}
function syncHeaders(target: Headers, source: Headers): void {
  const sourceNames = new Set<string>();
  source.forEach((_value, name) => sourceNames.add(name.toLowerCase()));
  const removedNames: string[] = [];
  target.forEach((_value, name) => {
    if (!sourceNames.has(name.toLowerCase())) removedNames.push(name);
  });
  for (const name of removedNames) target.delete(name);
  source.forEach((value, name) => target.set(name, value));
}

function getHostname(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

function assertSecretValuesAllowedForHost(request: Request, hostname: string, entries: SecretEntry[], checkQuery: boolean) {
  for (const entry of entries) {
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
function requestContainsSecretValuesInQuery(url: string, values: string[]): boolean {
  const secrets = values.filter(Boolean);
  return [...new URL(url).searchParams].some(([name, value]) => secrets.some((secret) => name.includes(secret) || value.includes(secret)));
}

function decodeBasicAuth(value: string): string | null {
  const match = value.match(/^(Basic)(\s+)(\S+)(\s*)$/i);
  if (!match) return null;
  try {
    return Buffer.from(match[3]!, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function collectStringMatchRanges(container: string, search: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  if (!search) return ranges;
  for (let start = container.indexOf(search); start !== -1; start = container.indexOf(search, start + 1)) {
    ranges.push({ start, end: start + search.length });
  }
  return ranges;
}

function replaceSecretPlaceholdersInHeaders(incomingHeaders: Headers, hostname: string, entries: SecretEntry[]): Headers {
  let headers: Headers | null = null;
  for (const [headerName, value] of incomingHeaders.entries()) {
    let updated = replaceSecretPlaceholdersInString(value, hostname, entries);
    updated = replaceBasicAuthSecretPlaceholders(headerName, updated, hostname, entries);
    if (updated !== value) { headers ??= new Headers(incomingHeaders); headers.set(headerName, updated); }
  }
  return headers ?? incomingHeaders;
}
function replaceSecretPlaceholdersInUrl(url: string, hostname: string, entries: SecretEntry[], replacePath: boolean, replaceQuery: boolean): string {
  if (!replacePath && !replaceQuery) return url;
  const parsed = new URL(url);
  const matchingEntries = entries.filter((entry) => matchesAnyHost(hostname, entry.hosts));
  let changed = false;
  if (replacePath) {
    const pathname = replaceSecretPlaceholdersInString(parsed.pathname, hostname, matchingEntries);
    if (pathname !== parsed.pathname) { parsed.pathname = pathname; changed = true; }
  }
  if (replaceQuery) {
    let queryChanged = false;
    const params = new URLSearchParams();
    for (const [name, value] of parsed.searchParams) {
      const nextName = replaceSecretPlaceholdersInString(name, hostname, matchingEntries);
      const nextValue = replaceSecretPlaceholdersInString(value, hostname, matchingEntries);
      queryChanged ||= nextName !== name || nextValue !== value;
      params.append(nextName, nextValue);
    }
    if (queryChanged) { parsed.search = params.toString(); changed = true; }
  }
  return changed ? parsed.toString() : url;
}
function replaceBasicAuthSecretPlaceholders(headerName: string, headerValue: string, hostname: string, entries: SecretEntry[]): string {
  if (!/^(authorization|proxy-authorization)$/i.test(headerName)) return headerValue;
  const match = headerValue.match(/^(Basic)(\s+)(\S+)(\s*)$/i);
  if (!match) return headerValue;
  const decoded = decodeBasicAuth(headerValue);
  if (!decoded) return headerValue;
  const updated = replaceSecretPlaceholdersInString(decoded, hostname, entries);
  return updated === decoded ? headerValue : `${match[1]}${match[2]}${Buffer.from(updated, "utf8").toString("base64")}${match[4] ?? ""}`;
}
function replaceSecretPlaceholdersInString(value: string, hostname: string, entries: SecretEntry[]): string {
  const secretValueRanges = entries.flatMap((entry) => collectStringMatchRanges(value, entry.value));
  const replacements = entries.flatMap((entry) => collectStringMatchRanges(value, entry.placeholder).filter((range) => !secretValueRanges.some((s) => s.start <= range.start && s.end >= range.end)).map((range) => ({ ...range, entry })));
  if (!replacements.length) return value;
  replacements.sort((a, b) => a.start - b.start || b.end - a.end);
  let updated = "";
  let offset = 0;
  for (const replacement of replacements) {
    if (replacement.start < offset) continue;
    updated += value.slice(offset, replacement.start);
    if (!matchesAnyHost(hostname, replacement.entry.hosts)) throw new HttpRequestBlockedError(`secret ${replacement.entry.name} not allowed for host: ${hostname || "unknown"}`);
    updated += replacement.entry.value;
    offset = replacement.end;
  }
  return updated + value.slice(offset);
}
function uniqueHosts(hosts: string[]): string[] {
  return [...new Set(hosts.map(normalizeHostnamePattern).filter(Boolean))];
}
