import { createHash, randomBytes } from "node:crypto";
import { createWorkspaceMetadataState } from "@atelier/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const identitySchema = Type.Object({ workspaceId: Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_.-]*$", maxLength: 128 }), agentId: Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" }) }, { additionalProperties: false });
export type AgentMcpIdentity = Static<typeof identitySchema>;
const schema = Type.Object({ agents: Type.Record(Type.String(), Type.String()) });

export function createAgentMcpCredentials(dataDir?: string) {
  const store = createWorkspaceMetadataState("agent-mcp.json", (value) => Value.Parse(schema, value), (): Static<typeof schema> => ({ agents: {} }), { dataDir });
  const hash = (token: string) => createHash("sha256").update(token).digest("hex");
  return {
    issue(identity: AgentMcpIdentity): string {
      const prefix = Buffer.from(JSON.stringify(identity)).toString("base64url");
      const token = `${prefix}.${randomBytes(32).toString("base64url")}`;
      const state = store.read(identity.workspaceId);
      store.write(identity.workspaceId, { agents: { ...state.agents, [identity.agentId]: hash(token) } });
      return token;
    },
    authenticate(token: string): AgentMcpIdentity | undefined {
      if (token.length > 1024 || !/^[\w-]+\.[\w-]{43}$/.test(token)) return undefined;
      let identity: unknown;
      try { identity = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString()); } catch { return undefined; }
      if (!Value.Check(identitySchema, identity)) return undefined;
      return store.read(identity.workspaceId).agents[identity.agentId] === hash(token) ? identity : undefined;
    },
    revoke(identity: AgentMcpIdentity): void {
      const agents = { ...store.read(identity.workspaceId).agents };
      delete agents[identity.agentId];
      store.write(identity.workspaceId, { agents });
    },
    revokeWorkspace(workspaceId: string): void { store.delete(workspaceId); },
  };
}
