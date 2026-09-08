function browserOriginParam(browserKey: string): string {
  return `atelierBrowserOrigin.${browserKey}`;
}

export function browserProxyUrl(browserKey: string, target: URL, base: string): URL {
  const proxy = new URL(`${target.pathname}${target.search}${target.hash}`, base);
  proxy.searchParams.set(browserOriginParam(browserKey), target.origin);
  return proxy;
}

/** Each preview consumes only its own routing metadata; nested previews pass through. */
export function browserRequestTarget(view: { key: string; targetUrl: string }, requestUrl: URL): URL {
  const parameter = browserOriginParam(view.key);
  const origin = URL.parse(requestUrl.searchParams.get(parameter) ?? "");
  const targetOrigin = origin && (origin.protocol === "http:" || origin.protocol === "https:")
    ? origin.origin
    : new URL(view.targetUrl).origin;
  const target = new URL(`${requestUrl.pathname}${requestUrl.search}`, targetOrigin);
  if (target.searchParams.has(parameter)) target.searchParams.delete(parameter);
  return target;
}

export function isWorkspaceLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]" || normalized === "0.0.0.0";
}
