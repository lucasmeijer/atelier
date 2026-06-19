import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultDataDir, invalidArguments, type AtelierEventBus } from "@atelier/core";

export interface GitIdentitySettings {
  name: string;
  email: string;
}

interface GitIdentityStore {
  gitIdentity?: GitIdentitySettings;
}

export function gitIdentitySettingsFile(dataDir = defaultDataDir()): string {
  return join(dataDir, "repository-settings.json");
}

async function readStore(file: string): Promise<GitIdentityStore> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<GitIdentityStore>;
    const candidate = parsed.gitIdentity;
    if (!candidate || typeof candidate !== "object") return {};
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    const email = typeof candidate.email === "string" ? candidate.email.trim() : "";
    return name && email ? { gitIdentity: { name, email } } : {};
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return {};
    throw error;
  }
}

async function writeStore(file: string, store: GitIdentityStore): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function validateGitIdentity(identity: GitIdentitySettings): GitIdentitySettings {
  const name = identity.name.trim();
  const email = identity.email.trim();
  if (!name) throw invalidArguments("git user name is required");
  if (!email) throw invalidArguments("git user email is required");
  if (/\r|\n/.test(name) || /\r|\n/.test(email)) throw invalidArguments("git identity must fit on one line");
  return { name, email };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export async function getGitIdentity(file = gitIdentitySettingsFile()): Promise<GitIdentitySettings | undefined> {
  return (await readStore(file)).gitIdentity;
}

export async function hasGitIdentity(file = gitIdentitySettingsFile()): Promise<boolean> {
  return Boolean(await getGitIdentity(file));
}

export async function setGitIdentity(identity: GitIdentitySettings, file = gitIdentitySettingsFile()): Promise<GitIdentitySettings> {
  const validated = validateGitIdentity(identity);
  await writeStore(file, { gitIdentity: validated });
  return validated;
}

export async function clearGitIdentity(file = gitIdentitySettingsFile()): Promise<void> {
  await writeStore(file, {});
}

export function registerGitIdentityWorkspaceEvents(events: AtelierEventBus): void {
  events.on("workspace_plan_prepare", async ({ plan }) => {
    const identity = await getGitIdentity();
    if (!identity) return;
    plan.initScripts.push(`git config --file /home/atelier/.gitconfig user.name ${shellQuote(identity.name)}; git config --file /home/atelier/.gitconfig user.email ${shellQuote(identity.email)}; chown atelier:atelier /home/atelier/.gitconfig`);
  });
}
