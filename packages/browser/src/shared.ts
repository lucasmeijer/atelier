export const browserOriginParam = "atelierBrowserOrigin";

export function browserProxyUrl(target: URL, base: string): URL {
  const proxy = new URL(`${target.pathname}${target.search}${target.hash}`, base);
  proxy.searchParams.set(browserOriginParam, target.origin);
  return proxy;
}

export function stripBrowserProxyParams(url: URL): void {
  url.searchParams.delete(browserOriginParam);
}
