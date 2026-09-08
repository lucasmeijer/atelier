import type { WorkspaceHttpAppBackend } from "@atelier/shared";

function localHostname(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(hostname.toLowerCase());
}

/** Only the current local app; never turn a redirect into publication of another port. */
export function isSameLocalApp(target: URL, candidate: URL): boolean {
  return localHostname(target.hostname) && localHostname(candidate.hostname)
    && target.protocol === candidate.protocol && target.port === candidate.port
    && !candidate.username && !candidate.password;
}

export function localAppHost(target: URL): string {
  return `localhost:${target.port || (target.protocol === "https:" ? "443" : "80")}`;
}

export interface LocalAppOriginTranslation {
  receiving: string;
  upstream: string;
}

/** Translate only this hop's same-origin requests, never missing, opaque, or foreign Origins. */
export function translateLocalAppOrigin(backend: WorkspaceHttpAppBackend, headers: Headers, receivingOrigin: string): LocalAppOriginTranslation | undefined {
  if (headers.get("origin") !== receivingOrigin) return undefined;
  const upstream = new URL(`${backend.target.protocol}//${localAppHost(backend.target)}`).origin;
  headers.set("origin", upstream);
  return { receiving: receivingOrigin, upstream };
}

/** Header-only compatibility. Response bodies and unrelated origins are untouched. */
export function adaptLocalAppResponse(backend: WorkspaceHttpAppBackend, response: Response, publicOrigin: string, translation?: LocalAppOriginTranslation): Response {
  const headers = new Headers(response.headers);
  // These response fields refer to the request's Origin, not the app's public URL.
  // Reverse exactly the translation made on this request, including each nested hop.
  for (const name of ["access-control-allow-origin", "timing-allow-origin"]) {
    const value = headers.get(name);
    if (value === null) continue;
    if (translation) {
      headers.set(name, name === "timing-allow-origin"
        ? value.split(",").map((origin) => origin.trim() === translation.upstream ? translation.receiving : origin.trim()).join(", ")
        : value === translation.upstream ? translation.receiving : value);
    }
    // Even a static upstream allow-origin now varies with the incoming Origin.
    const vary = headers.get("vary")?.split(",").map((field) => field.trim().toLowerCase()) ?? [];
    if (!vary.includes("*") && !vary.includes("origin")) headers.append("vary", "Origin");
  }
  const location = headers.get("location");
  if (location) {
    const destination = URL.parse(location, backend.target);
    if (destination && isSameLocalApp(backend.target, destination)) {
      // Concatenate so a path beginning with // cannot replace the public authority.
      headers.set("location", `${publicOrigin}${destination.pathname}${destination.search}${destination.hash}`);
    }
  }
  const cookies = headers.getSetCookie();
  if (cookies.length) {
    headers.delete("set-cookie");
    for (const cookie of cookies) {
      headers.append("set-cookie", cookie.split(";").filter((attribute, index) => {
        if (index === 0) return true;
        const match = attribute.match(/^\s*domain\s*=\s*\.?([^\s;]+)\s*$/i);
        return !match || !localHostname(match[1]!);
      }).join(";"));
    }
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
