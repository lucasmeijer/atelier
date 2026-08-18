import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { AtelierCoreError, atelierDataPath, dockerHostAtelierDataPath, getAtelierRuntimeContext, type AtelierEventBus } from "@atelier/core";
import { listWorkspaces } from "@atelier/workspace";
import { isGitProjectInit, type GitProjectInitInstruction } from "./project.ts";
import { revealProjectSshKey } from "./ssh-keys.ts";

const containerAgentDir = "/run/atelier-ssh-agent";
const containerAgentSocket = `${containerAgentDir}/agent.sock`;
const agents = new Map<string, { stop(): Promise<void> }>();

function agentDir(workspaceId: string): string {
  return atelierDataPath(getAtelierRuntimeContext(), "ssh-agents", workspaceId);
}

async function waitForSocket(path: string, child: ChildProcess, stderr: () => string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new AtelierCoreError("ssh_agent_failed", stderr().trim() || `ssh-agent exited with status ${child.exitCode}`);
    try {
      if ((await stat(path)).isSocket()) return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await Bun.sleep(20);
  }
  throw new AtelierCoreError("ssh_agent_failed", "timed out waiting for SSH agent socket");
}

async function addPrivateKey(socketPath: string, privateKey: string): Promise<void> {
  const child = spawn("ssh-add", ["-"], { env: { ...process.env, SSH_AUTH_SOCK: socketPath }, stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  child.stdin!.end(privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`);
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (status !== 0) throw new AtelierCoreError("invalid_ssh_private_key", stderr.trim() || "ssh-add rejected the private key; use an unencrypted OpenSSH private key");
}

async function startAgent(workspaceId: string, init: GitProjectInitInstruction): Promise<boolean> {
  if (agents.has(workspaceId)) return true;
  const privateKey = await revealProjectSshKey(init.projectId);
  if (!privateKey) return false;

  const dir = agentDir(workspaceId);
  const socketPath = join(dir, "agent.sock");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true });

  const child = spawn("ssh-agent", ["-D", "-a", socketPath], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  await waitForSocket(socketPath, child, () => stderr);
  try {
    await addPrivateKey(socketPath, privateKey);
  } catch (error) {
    child.kill("SIGTERM");
    await rm(socketPath, { force: true });
    throw error;
  }

  agents.set(workspaceId, {
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      }
      await rm(socketPath, { force: true });
    },
  });
  return true;
}

async function stopAgent(workspaceId: string): Promise<void> {
  const agent = agents.get(workspaceId);
  agents.delete(workspaceId);
  await agent?.stop();
}

export function registerProjectSshAgentWorkspaceEvents(events: AtelierEventBus): void {
  events.on("workspace_plan_prepare", async ({ workspaceId, init, plan }) => {
    if (!isGitProjectInit(init) || !(await startAgent(workspaceId, init))) return;
    plan.env.SSH_AUTH_SOCK = containerAgentSocket;
    plan.mounts.push({ type: "bind", source: dockerHostAtelierDataPath(getAtelierRuntimeContext(), "ssh-agents", workspaceId), target: containerAgentDir, readonly: true });
    plan.cleanup.push(() => stopAgent(workspaceId));
  });
  events.on("workspace_deleted", async ({ workspaceId }) => stopAgent(workspaceId));
}

export async function restoreProjectSshAgents(): Promise<void> {
  for (const workspace of (await listWorkspaces()).workspaces) {
    if (isGitProjectInit(workspace.init)) await startAgent(workspace.id, workspace.init);
  }
}
