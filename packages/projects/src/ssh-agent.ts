import { join } from "node:path";
import { atelierDataPath, dockerHostAtelierDataPath, getAtelierRuntimeContext, type AtelierEventBus } from "@atelier/core";
import { listWorkspaces } from "@atelier/workspace";
import { isGitProjectInit } from "./project.ts";
import { revealProjectSshKeys } from "./ssh-keys.ts";
import { prepareWorkspaceSshTrust, workspaceGitSshCommand } from "./ssh-host-trust.ts";
import { SharedSshAgent } from "./shared-ssh-agent.ts";

const containerAgentDir = "/run/atelier-ssh-agent";
let shared: SharedSshAgent | undefined;

function agentDir(workspaceId: string): string {
  return atelierDataPath(getAtelierRuntimeContext(), "ssh-agents", workspaceId);
}

function sshEnvironment(directory: string) {
  return {
    SSH_AUTH_SOCK: join(directory, "agent.sock"),
    GIT_SSH_COMMAND: workspaceGitSshCommand(join(directory, "known_hosts")),
  };
}

export async function workspaceSourceSshEnvironment(workspaceId: string, projectId?: string): Promise<Record<string, string>> {
  // One module owns the signing backend for the lifetime of Atelier, not a workspace.
  shared ??= new SharedSshAgent(atelierDataPath(getAtelierRuntimeContext(), "ssh-signer"), async (id) => id ? revealProjectSshKeys(id) : []);
  const directory = agentDir(workspaceId);
  await shared.listen(join(directory, "agent.sock"), projectId);
  await prepareWorkspaceSshTrust(directory, projectId);
  return sshEnvironment(directory);
}

export async function stopWorkspaceSshAgent(workspaceId: string): Promise<void> {
  await shared?.remove(join(agentDir(workspaceId), "agent.sock"));
}

export async function stopProjectSshAgents(): Promise<void> {
  const agent = shared;
  shared = undefined;
  await agent?.close();
}

export function registerProjectSshAgentWorkspaceEvents(events: AtelierEventBus): void {
  events.on("workspace_plan_prepare", async ({ workspaceId, init, plan }) => {
    await workspaceSourceSshEnvironment(workspaceId, isGitProjectInit(init) ? init.projectId : undefined);
    Object.assign(plan.env, sshEnvironment(containerAgentDir));
    plan.mounts.push({ type: "bind", source: dockerHostAtelierDataPath(getAtelierRuntimeContext(), "ssh-agents", workspaceId), target: containerAgentDir, readonly: true });
    plan.cleanup.push(() => stopWorkspaceSshAgent(workspaceId));
  });
  events.on("workspace_deleted", async ({ workspaceId }) => stopWorkspaceSshAgent(workspaceId));
}

export async function restoreProjectSshAgents(): Promise<void> {
  for (const workspace of (await listWorkspaces()).workspaces) {
    await workspaceSourceSshEnvironment(workspace.id, isGitProjectInit(workspace.init) ? workspace.init.projectId : undefined);
  }
}
