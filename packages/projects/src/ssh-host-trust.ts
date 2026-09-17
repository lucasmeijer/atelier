import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invalidArguments, runCommand, shellQuote } from "@atelier/core";
import { gitHubKnownHosts } from "./github-host-keys.ts";
import { findProjectRecord, projectsFile, readProjectStore, updateProjectStore } from "./project.ts";

export async function getProjectSshKnownHosts(projectId: string, file = projectsFile()): Promise<string> {
  return findProjectRecord(await readProjectStore(file), projectId).sshKnownHosts ?? "";
}

/** Additional trust is supplied explicitly, never learned from an unverified network scan. */
export async function setProjectSshKnownHosts(projectId: string, input: string, file = projectsFile()): Promise<string> {
  const lines = input.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  const directory = await mkdtemp(join(tmpdir(), "atelier-host-keys-"));
  try {
    for (const line of lines) {
      // Each record must include a host pattern and a public key (not an authorized_keys record).
      if (!/^(?:@(?:cert-authority|revoked)\s+)?\S+\s+(?:ssh-|ecdsa-|sk-)\S+\s+\S+/.test(line)) throw invalidArguments("Use known_hosts records: hostname key-type public-key. Verify keys with the server administrator first.");
      const path = join(directory, "known_hosts");
      await writeFile(path, `${line}\n`);
      const { exitCode } = await runCommand(["ssh-keygen", "-l", "-f", path]);
      if (exitCode !== 0) throw invalidArguments("Invalid SSH host public key. Use verified known_hosts records.");
    }
    const knownHosts = lines.length ? `${lines.join("\n")}\n` : "";
    return await updateProjectStore(file, (store) => {
      const project = findProjectRecord(store, projectId);
      if (knownHosts) project.sshKnownHosts = knownHosts;
      else delete project.sshKnownHosts;
      return knownHosts;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function prepareWorkspaceSshTrust(directory: string, projectId?: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "known_hosts");
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const projectHosts = projectId ? await getProjectSshKnownHosts(projectId) : "";
  await writeFile(temporary, `${gitHubKnownHosts}${projectHosts}`, { mode: 0o644 });
  await rename(temporary, path);
  return path;
}

export function workspaceGitSshCommand(knownHostsPath: string): string {
  // Retain normal host-managed trust in addition to the explicit project trust file.
  return `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ${shellQuote(`UserKnownHostsFile=${knownHostsPath} ~/.ssh/known_hosts`)}`;
}
