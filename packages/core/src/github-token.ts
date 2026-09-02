import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAtelierRuntimeContext } from "./runtime-context.ts";

// Submodule URLs are repository-controlled, so never offer the GitHub token to another host.
export const gitHubCredentialHelperShellBody = `test "$1" = get || exit 0
protocol=
host=
while IFS='=' read -r key value; do
  case "$key" in
    protocol) protocol="$value" ;;
    host) host="$value" ;;
  esac
done
[ "$protocol" = https ] || exit 0
case "$host" in github.com|github.com:443) ;; *) exit 0 ;; esac
[ -n "\${GH_TOKEN:-}" ] || exit 0
echo username=x-access-token
echo password="$GH_TOKEN"`;

export const gitHubCredentialHelperCommand = `!f() { ${gitHubCredentialHelperShellBody}; }; f`;

function storedGitHubTokenPath(): string {
  return join(getAtelierRuntimeContext().atelierDataDir, "workspace", "github-token");
}

function disabledHostGitHubTokenPath(): string {
  return join(getAtelierRuntimeContext().atelierDataDir, "workspace", "github-token-disabled");
}

export function discoverHostGitHubToken(): string | undefined {
  const path = storedGitHubTokenPath();
  const stored = existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
  if (stored) return stored;
  if (existsSync(disabledHostGitHubTokenPath())) return undefined;
  return process.env.GH_TOKEN?.trim() || undefined;
}

export function hasWorkspaceGitHubToken(): boolean {
  return Boolean(discoverHostGitHubToken());
}

export function setWorkspaceGitHubToken(token: string): void {
  const path = storedGitHubTokenPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${token.trim()}\n`, { mode: 0o600 });
  rmSync(disabledHostGitHubTokenPath(), { force: true });
}

export function clearWorkspaceGitHubToken(): void {
  const disabledPath = disabledHostGitHubTokenPath();
  rmSync(storedGitHubTokenPath(), { force: true });
  mkdirSync(dirname(disabledPath), { recursive: true });
  writeFileSync(disabledPath, "", { mode: 0o600 });
}
