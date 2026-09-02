import { turboStream, turboStreamResponse } from "@atelier/shared";

export function response(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", headers.get("content-type") ?? "text/html; charset=utf-8");
  headers.set("cache-control", headers.get("cache-control") ?? "no-store");
  return new Response(body, { ...init, headers });
}

export const stream = turboStreamResponse;
export const replace = (target: string, html: string): string => turboStream("replace", target, html);
export const update = (target: string, html: string): string => turboStream("update", target, html);
export const updateTargets = (selector: string, html: string): string => turboStream("update", selector, html, { targets: true });
export const replaceTargets = (selector: string, html: string): string => turboStream("replace", selector, html, { targets: true });
export const remove = (target: string): string => turboStream("remove", target);
export const append = (target: string, html: string): string => turboStream("append", target, html);

export function wantsStream(request: Request): boolean {
  return request.headers.get("accept")?.includes("text/vnd.turbo-stream.html") ?? false;
}
