import type { JsonObject } from "@atelier/core";
const response = { "200": { description: "Host operation result. Use Accept: application/json for automation; the UI receives server-rendered HTML." } };
const origin = { name: "Origin", in: "header", required: true, schema: { type: "string" }, description: "Must equal the public Atelier origin. Required for privileged mutations and terminal WebSocket upgrades." };
const id = { name: "id", in: "path", required: true, schema: { type: "string", pattern: "^host-[a-f0-9-]{36}$" } };
export const hostOpenApiPaths = {
  "/host": { get: { summary: "Inspect System host availability or open the Host panel", responses: response } },
  "/host/sample": {
    get: { summary: "Read the last host sample; collect once if none exists", responses: response },
    post: { summary: "Collect a fresh, bounded host diagnostic sample", parameters: [origin], responses: response },
  },
  "/host/terminals": {
    get: { summary: "List persistent System terminal sessions", responses: response },
    post: { summary: "Create a persistent root shell in System", parameters: [origin], responses: response },
  },
  "/host/terminals/{id}/terminate": { post: { summary: "Terminate a terminal and its processes (not merely detach)", parameters: [id, origin], responses: response } },
} satisfies Record<string, JsonObject>;
