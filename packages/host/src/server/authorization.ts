import { existsSync } from "node:fs";
import { publicWorkspaceAppOrigin } from "@atelier/proxy-ingress/server";
/** Normal Atelier authentication is applied by the app before module dispatch.
 * Parent ingress translates same-origin requests to the local app origin and
 * attests that decision. Public routing metadata is not the translated Origin. */
export function hostOriginAllowed(request: Request, parentConnected = existsSync("/run/atelier-parent")): boolean {
  const origin = request.headers.get("origin");
  const attestedOrigin = request.headers.get("x-atelier-origin-context");
  if (parentConnected && attestedOrigin !== null) {
    // An explicit "null" includes foreign origins that happen to match localhost.
    return attestedOrigin !== "null" && origin === attestedOrigin;
  }
  return origin === new URL(publicWorkspaceAppOrigin(request)).origin;
}
