/** Shared HTML/turbo-stream helpers for the agent module. */

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function domId(...parts: string[]): string {
  return parts.join("_").replace(/[^a-zA-Z0-9_-]/g, "_");
}

type TurboAction = "append" | "prepend" | "replace" | "update" | "remove" | "append_text";

export function turboStream(action: TurboAction, target: string, html = ""): string {
  if (action === "remove") return `<turbo-stream action="remove" target="${escapeHtml(target)}"></turbo-stream>`;
  return `<turbo-stream action="${action}" target="${escapeHtml(target)}"><template>${html}</template></turbo-stream>`;
}

/** Append raw text (custom client-side action; preserves whitespace, no HTML parsing cost). */
export function turboAppendText(target: string, text: string): string {
  return `<turbo-stream action="append_text" target="${escapeHtml(target)}"><template>${escapeHtml(text)}</template></turbo-stream>`;
}

export function turboStreamResponse(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/vnd.turbo-stream.html; charset=utf-8");
  return new Response(body, { ...init, headers });
}

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "text/html; charset=utf-8");
  return new Response(body, { ...init, headers });
}

export function sseFrame(html: string): string {
  return `${html.split("\n").map((line) => `data: ${line}`).join("\n")}\n\n`;
}
