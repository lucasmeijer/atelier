import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, createConnection, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProject, createProjectSshKey, deleteProjectSshKey, projectWorkspaceInit, registerProjectWorkspaceInitEvents, setProjectSshKnownHosts, getProjectSshKnownHosts } from "@atelier/projects";
import { prepareWorkspaceSshTrust, workspaceGitSshCommand } from "../src/ssh-host-trust.ts";
import { createAtelierEventBus } from "@atelier/core";
import type { WorkspaceDockerPlan } from "@atelier/workspace";
import { stopProjectSshAgents, registerProjectSshAgentWorkspaceEvents } from "../src/ssh-agent.ts";

let root: string;
let previousDataDir: string | undefined;
let daemon: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
async function run(command: string[], cwd?: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (status !== 0) throw new Error(`${command[0]} failed: ${stderr}`);
  return stdout;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "atelier-ssh-transport-"));
  previousDataDir = process.env.ATELIER_DATA_DIR;
  process.env.ATELIER_DATA_DIR = join(root, "data");
});
afterEach(async () => {
  await stopProjectSshAgents();
  if (daemon) { daemon.kill(); await daemon.exited; const stderr = await new Response(daemon.stderr).text(); if (stderr) console.error(stderr); daemon = undefined; }
  if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
  else process.env.ATELIER_DATA_DIR = previousDataDir;
  await rm(root, { recursive: true, force: true });
});

async function key(name: string) {
  const path = join(root, name);
  await run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", path]);
  return { path, publicKey: (await readFile(`${path}.pub`, "utf8")).trim(), privateKey: await readFile(path, "utf8") };
}

test("host trust validates every record, persists explicitly, and can be cleared", async () => {
  const project = (await addProject("git@example.test:repo.git")).project;
  expect(await getProjectSshKnownHosts(project.id)).toBe("");
  const host = await key("host");
  const trusted = `example.test ${host.publicKey}\n`;
  expect(await setProjectSshKnownHosts(project.id, trusted)).toBe(trusted);
  await expect(setProjectSshKnownHosts(project.id, `${trusted}invalid record`)).rejects.toThrow("known_hosts");
  await expect(setProjectSshKnownHosts(project.id, "example.test ssh-ed25519 invalid")).rejects.toThrow("Invalid SSH host");
  await expect(setProjectSshKnownHosts(project.id, host.privateKey)).rejects.toThrow("known_hosts");
  expect(await getProjectSshKnownHosts(project.id)).toBe(trusted);
  expect(await setProjectSshKnownHosts(project.id, "")).toBe("");
});

test("GitHub host keys are trusted without project configuration, including SSH over port 443", async () => {
  const project = (await addProject("git@github.com:org/repo.git")).project;
  for (const projectId of [undefined, project.id]) {
    const path = await prepareWorkspaceSshTrust(join(root, "github-defaults"), projectId);
    for (const host of ["github.com", "[ssh.github.com]:443"]) {
      const entries = await run(["ssh-keygen", "-F", host, "-f", path]);
      expect(entries).toContain("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl");
    }
    expect(workspaceGitSshCommand(path)).toContain("StrictHostKeyChecking=yes");
  }
  const extra = await key("additional-host");
  await setProjectSshKnownHosts(project.id, `example.test ${extra.publicKey}`);
  let path = await prepareWorkspaceSshTrust(join(root, "github-defaults"), project.id);
  expect(await run(["ssh-keygen", "-F", "example.test", "-f", path])).toContain(extra.publicKey);
  await setProjectSshKnownHosts(project.id, "");
  path = await prepareWorkspaceSshTrust(join(root, "github-defaults"), project.id);
  expect(await run(["ssh-keygen", "-F", "github.com", "-f", path])).toContain("ssh-ed25519");
});

async function startServer(hostKey: string, authorizedKey: string): Promise<number> {
  // Requires OpenSSH server and passwordless sudo to run its privilege-separated daemon.
  const sshd = Bun.which("sshd") ?? "/usr/sbin/sshd";
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  // SAFETY: listen completed successfully on an explicit TCP address, not a Unix socket.
  const address = socket.address() as AddressInfo;
  const port = address.port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const username = (await run(["id", "-un"])).trim();
  const config = join(root, "sshd_config");
  await writeFile(config, `ListenAddress 127.0.0.1\nPort ${port}\nHostKey ${hostKey}\nAuthorizedKeysFile ${authorizedKey}\nPidFile ${root}/sshd.pid\nStrictModes no\nUsePAM yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\nAllowUsers ${username}\nLogLevel ERROR\n`);
  await run(["sudo", "-n", "mkdir", "-p", "/run/sshd"]);
  daemon = Bun.spawn(["sudo", "-n", sshd, "-D", "-e", "-f", config], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (daemon.exitCode !== null) throw new Error(`sshd exited: ${await new Response(daemon.stderr).text()}`);
    const ready = await new Promise<boolean>((resolve) => {
      const connection = createConnection({ host: "127.0.0.1", port });
      connection.once("connect", () => { connection.destroy(); resolve(true); });
      connection.once("error", () => { connection.destroy(); resolve(false); });
    });
    if (ready) return port;
    await Bun.sleep(20);
  }
  throw new Error("sshd did not start");
}

async function repository(name: string) {
  const seed = join(root, name);
  await run(["git", "init", "-b", "main", seed]);
  await run(["git", "config", "user.name", "Test"], seed);
  await run(["git", "config", "user.email", "test@example.test"], seed);
  await writeFile(join(seed, "file.txt"), name);
  await run(["git", "add", "."], seed);
  await run(["git", "commit", "-m", "initial"], seed);
  const remote = `${seed}.git`;
  await run(["git", "clone", "--bare", seed, remote]);
  return { seed, remote };
}

test("real SSH cloning and nested submodules require verified host trust and valid project credentials", async () => {
  const host = await key("server");
  const login = await key("login");
  const port = await startServer(host.path, `${login.path}.pub`);
  const username = (await run(["id", "-un"])).trim();
  const url = (path: string) => `ssh://${username}@127.0.0.1:${port}${path}`;
  const leaf = await repository("leaf");
  const middle = await repository("middle");
  const parent = await repository("parent");
  for (const [outer, inner] of [[middle, leaf], [parent, middle]] as const) {
    await run(["git", "-c", "protocol.file.allow=always", "submodule", "add", inner.remote, "child"], outer.seed);
    await run(["git", "config", "-f", ".gitmodules", "submodule.child.url", url(inner.remote)], outer.seed);
    await run(["git", "commit", "-am", "SSH submodule"], outer.seed);
    await run(["git", "push", outer.remote, "main"], outer.seed);
  }
  const project = (await addProject(url(parent.remote))).project;
  const storedKey = await createProjectSshKey(project.id, login.privateKey);
  const events = createAtelierEventBus();
  registerProjectWorkspaceInitEvents(events);
  registerProjectSshAgentWorkspaceEvents(events);
  const prepare = async (workspaceId: string, gitUrl = project.gitUrl) => {
    const source = { workspaceId, init: { ...projectWorkspaceInit(project), gitUrl, branch: "main" }, workHostPath: join(root, "data", "workspaces", workspaceId, "work"), workContainerPath: "/work" };
    await events.emit("workspace_source_prepare", source);
    return source;
  };
  await expect(prepare("missing-trust")).rejects.toThrow("Trusted SSH servers");
  expect(await Bun.file(join(root, "data", "ssh-agents", "missing-trust", "agent.sock")).exists()).toBe(false);
  await expect(prepare("missing-submodule-trust", parent.remote)).rejects.toThrow("Trusted SSH servers");
  await setProjectSshKnownHosts(project.id, `[127.0.0.1]:${port} ${host.publicKey}`);
  const source = await prepare("trusted");
  expect(await readFile(join(source.workHostPath, "child", "child", "file.txt"), "utf8")).toBe("leaf");
  const agentDirectory = join(root, "data", "ssh-agents", "trusted");
  const socket = join(agentDirectory, "agent.sock");
  const beforePlan = await stat(socket);
  const plan: WorkspaceDockerPlan = { labels: {}, env: {}, mounts: [], preloadImages: [], extraArgs: [], initScripts: [], containerFiles: [], cleanup: [] };
  await events.emit("workspace_plan_prepare", { ...source, plan });
  expect((await stat(socket)).ino).toBe(beforePlan.ino);
  expect(plan.env.SSH_AUTH_SOCK).toBe("/run/atelier-ssh-agent/agent.sock");
  expect(plan.env.GIT_SSH_COMMAND).toContain("/run/atelier-ssh-agent/known_hosts");
  expect(plan.mounts).toContainEqual({ type: "bind", source: agentDirectory, target: "/run/atelier-ssh-agent", readonly: true });
  await events.emit("workspace_deleted", { workspaceId: source.workspaceId });
  expect(await Bun.file(socket).exists()).toBe(false);
  const mixed = await prepare("non-ssh-main", parent.remote);
  expect(await readFile(join(mixed.workHostPath, "child", "child", "file.txt"), "utf8")).toBe("leaf");
  const changedHost = await key("changed-server");
  await setProjectSshKnownHosts(project.id, `[127.0.0.1]:${port} ${changedHost.publicKey}`);
  await expect(prepare("changed-host")).rejects.toThrow("Host key verification failed");
  await setProjectSshKnownHosts(project.id, `[127.0.0.1]:${port} ${host.publicKey}`);
  await deleteProjectSshKey(project.id, storedKey.id);
  const wrongLogin = await key("wrong-login");
  await createProjectSshKey(project.id, wrongLogin.privateKey);
  await expect(prepare("wrong-login")).rejects.toThrow("Permission denied");
}, 30_000);
