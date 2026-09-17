import { createWorkspaceMetadataState } from "@atelier/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

// Retain the persisted filename/shape so existing onboarding workspaces keep their grant.
const schema = Type.Object({ projectOnboarding: Type.Array(Type.String()) });
function store() {
  return createWorkspaceMetadataState("agent-capabilities.json", (value) => Value.Parse(schema, value), (): Static<typeof schema> => ({ projectOnboarding: [] }));
}

export function markProjectOnboardingWorkspace(workspaceId: string): void {
  store().write(workspaceId, { projectOnboarding: ["workspace"] });
}

/** Host-owned, lifetime-of-workspace grant. All agents in this workspace share visibility. */
export function isProjectOnboardingWorkspace(workspaceId: string): boolean {
  return store().read(workspaceId).projectOnboarding.length > 0;
}
