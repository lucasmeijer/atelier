export const hopByHopHeaderNames = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;

export function stripHopByHopHeaders(headers: Headers, extra: string[] = []): Headers {
  const next = new Headers(headers);
  for (const name of hopByHopHeaderNames) next.delete(name);
  for (const name of extra) next.delete(name);
  return next;
}

export function isHopByHopHeader(name: string, extra: string[] = []): boolean {
  const lower = name.toLowerCase();
  return hopByHopHeaderNames.some((header) => header === lower) || extra.some((header) => header.toLowerCase() === lower);
}
