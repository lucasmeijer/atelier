import { turboStream, turboStreamResponse } from "./index.ts";
export const stream = turboStreamResponse;
export const replace = (target: string, html: string) => turboStream("replace", target, html);
export const update = (target: string, html: string, options?: { method?: "morph" }) => turboStream("update", target, html, options);
export const replaceTargets = (target: string, html: string) => turboStream("replace", target, html, { targets: true });
export const remove = (target: string) => turboStream("remove", target);
export const append = (target: string, html: string) => turboStream("append", target, html);
export const wantsStream = (request: Request) => request.headers.get("accept")?.includes("text/vnd.turbo-stream.html") ?? false;
export function response(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "text/html; charset=utf-8");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(body, { ...init, headers });
}
