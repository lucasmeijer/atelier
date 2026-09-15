import { existsSync } from "node:fs";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { buttonHtml } from "@atelier/design-system/button";
import { actionLinkHtml } from "@atelier/design-system/action-link";
import { escapeHtml } from "@atelier/shared";
import { response } from "./http.ts";

const managed = () => existsSync("/run/atelier-system/access-v1");
const schema = Type.Object({ mode: Type.Union([Type.Literal("localhost"), Type.Literal("tailscale")]), connectionState: Type.String(), authUrl: Type.Optional(Type.String()), error: Type.Optional(Type.String()) });
export async function renderAccessSettings(source = true): Promise<string> {
  if (!managed()) return "";
  const status = await fetch("http://127.0.0.1:3001/access");
  if (!status.ok) throw new Error(`System access status: ${status.status}`);
  const access = Value.Parse(schema, await status.json());
  const remote = access.mode === "tailscale";
  const caption = remote ? "Use local access" : "Enable remote access";
  const reconnect = remote && access.connectionState !== "Running" ? `<form action="/settings/access" method="post"><input type="hidden" name="mode" value="tailscale">${buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Reconnect remote access" } })}</form>` : "";
  const login = access.authUrl ? actionLinkHtml({ href: access.authUrl, variant: "primary", content: { kind: "caption", caption: "Sign in to Tailscale" }, attributesHtml: 'target="_blank" rel="noreferrer"' }) : "";
  return `<turbo-frame id="settings_access"${source ? ' src="/settings/access"' : ""} data-controller="access-settings"><section class="settings-sec"><h2>Access</h2><p>${remote ? access.connectionState === "Running" ? "Remote access is connected." : "Remote access is disconnected." : "Using local access."}</p>${access.error ? `<p class="settings-error">${escapeHtml(access.error)}</p>` : ""}${login}${reconnect}<form action="/settings/access" method="post"><input type="hidden" name="mode" value="${remote ? "localhost" : "tailscale"}">${buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption } })}</form></section></turbo-frame>`;
}
export async function handleAccessSettings(request: Request, url: URL): Promise<Response | undefined> {
  if (!url.pathname.startsWith("/settings/access")) return;
  if (!managed()) return new Response("System access settings are unavailable", { status: 404 });
  if (url.pathname === "/settings/access/events" && request.method === "GET") {
    const upstream = await fetch("http://127.0.0.1:3001/events", { signal: request.signal });
    return new Response(upstream.body, { status: upstream.status, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }
  if (url.pathname !== "/settings/access") return;
  if (request.method === "POST") {
    const mode = (await request.formData()).get("mode");
    if (mode !== "localhost" && mode !== "tailscale") return new Response("Invalid access mode", { status: 400 });
    const result = await fetch("http://127.0.0.1:3001/access", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
    if (!result.ok) throw new Error(`System access setting: ${result.status}: ${await result.text()}`);
    return Response.redirect(new URL("/settings/access", url), 303);
  }
  if (request.method === "GET") return response(await renderAccessSettings(false));
}
