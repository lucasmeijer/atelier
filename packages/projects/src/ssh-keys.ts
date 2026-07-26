import { AtelierCoreError } from "@atelier/core";
import { decryptProjectValue, encryptProjectValue } from "./secret-crypto.ts";
import { findProjectRecord, projectsFile, readProjectStore, writeProjectStore } from "./project.ts";

const sshKeySecretId = "ssh-key";

export async function hasProjectSshKey(projectId: string, file = projectsFile()): Promise<boolean> {
  return !!findProjectRecord(await readProjectStore(file), projectId).sshKey;
}

export async function setProjectSshKey(projectId: string, privateKey: string, file = projectsFile(), keyFile?: string): Promise<void> {
  if (!privateKey.trim()) throw new AtelierCoreError("invalid_arguments", "Private key is required");
  const store = await readProjectStore(file);
  const project = findProjectRecord(store, projectId);
  project.sshKey = { encryptedPrivateKey: await encryptProjectValue(projectId, sshKeySecretId, privateKey, keyFile) };
  await writeProjectStore(file, store);
}

export async function deleteProjectSshKey(projectId: string, file = projectsFile()): Promise<void> {
  const store = await readProjectStore(file);
  const project = findProjectRecord(store, projectId);
  if (!project.sshKey) throw new AtelierCoreError("project_ssh_key_not_found", "project SSH key not found");
  delete project.sshKey;
  await writeProjectStore(file, store);
}

export async function revealProjectSshKey(projectId: string, file = projectsFile(), keyFile?: string): Promise<string | undefined> {
  const key = findProjectRecord(await readProjectStore(file), projectId).sshKey;
  return key && await decryptProjectValue(projectId, sshKeySecretId, key.encryptedPrivateKey, keyFile);
}
