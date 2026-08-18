import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAtelierRuntimeContext, invalidArguments, shellQuote, type AtelierEventBus } from "@atelier/core";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const gitIdentitySchema = Type.Object({
  name: Type.String(),
  email: Type.String(),
});

export type GitIdentitySettings = Static<typeof gitIdentitySchema>;

const gitIdentityStoreSchema = Type.Object({
  gitIdentity: Type.Optional(gitIdentitySchema),
});

type GitIdentityStore = Static<typeof gitIdentityStoreSchema>;

export function gitIdentitySettingsFile(dataDir = getAtelierRuntimeContext().atelierDataDir): string {
  return join(dataDir, "project-settings.json");
}

async function readStore(file: string): Promise<GitIdentityStore> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!Value.Check(gitIdentityStoreSchema, parsed) || !parsed.gitIdentity) return {};
    const name = parsed.gitIdentity.name.trim();
    const email = parsed.gitIdentity.email.trim();
    return name && email ? { gitIdentity: { name, email } } : {};
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return {};
    throw error;
  }
}

async function writeStore(file: string, store: GitIdentityStore): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tempFile = `${file}.${randomUUID()}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(tempFile, file);
}

function validateGitIdentity(identity: GitIdentitySettings): GitIdentitySettings {
  const name = identity.name.trim();
  const email = identity.email.trim();
  if (!name) throw invalidArguments("git user name is required");
  if (!email) throw invalidArguments("git user email is required");
  if (/\r|\n/.test(name) || /\r|\n/.test(email)) throw invalidArguments("git identity must fit on one line");
  return { name, email };
}

function execGitConfig(key: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["config", "--global", "--get", key], { encoding: "utf8" }, (error, stdout) => {
      if (error) return resolve(undefined);
      const value = stdout.trim();
      resolve(value || undefined);
    });
  });
}

async function getHostGlobalGitIdentity(): Promise<GitIdentitySettings | undefined> {
  const [name, email] = await Promise.all([execGitConfig("user.name"), execGitConfig("user.email")]);
  if (!name || !email) return undefined;
  try {
    return validateGitIdentity({ name, email });
  } catch {
    return undefined;
  }
}

function shouldAdoptHostGlobalGitIdentity(file: string): boolean {
  return file === gitIdentitySettingsFile();
}

export async function getStoredGitIdentity(file = gitIdentitySettingsFile()): Promise<GitIdentitySettings | undefined> {
  return (await readStore(file)).gitIdentity;
}

export async function getGitIdentity(file = gitIdentitySettingsFile()): Promise<GitIdentitySettings | undefined> {
  const stored = await getStoredGitIdentity(file);
  if (stored || !shouldAdoptHostGlobalGitIdentity(file)) return stored;
  const hostIdentity = await getHostGlobalGitIdentity();
  if (!hostIdentity) return undefined;
  await writeStore(file, { gitIdentity: hostIdentity });
  return hostIdentity;
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
    const script = `git config --global user.name ${shellQuote(identity.name)}; git config --global user.email ${shellQuote(identity.email)}`;
    plan.initScripts.push(`su atelier -c ${shellQuote(script)}`);
  });
}
