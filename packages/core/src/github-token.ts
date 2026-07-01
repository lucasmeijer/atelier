import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAtelierRuntimeContext } from "./runtime-context.ts";

function storedGitHubTokenPath(): string {
  return join(getAtelierRuntimeContext().atelierDataDir, "workspace", "github-token");
}

export function discoverHostGitHubToken(): string | undefined {
  const path = storedGitHubTokenPath();
  const stored = existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
  return stored || process.env.GH_TOKEN?.trim() || undefined;
}

export function hasWorkspaceGitHubToken(): boolean {
  return Boolean(discoverHostGitHubToken());
}

export function setWorkspaceGitHubToken(token: string): void {
  const path = storedGitHubTokenPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${token.trim()}\n`, { mode: 0o600 });
}

export function clearWorkspaceGitHubToken(): void {
  rmSync(storedGitHubTokenPath(), { force: true });
}
