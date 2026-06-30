export interface GitHubTokenValidationSuccess {
  ok: true;
  name: string;
  email: string;
}

export interface GitHubTokenValidationFailure {
  ok: false;
  message: string;
}

export type GitHubTokenValidation = GitHubTokenValidationSuccess | GitHubTokenValidationFailure;

type GitHubUserBody = { id?: unknown; login?: unknown; name?: unknown; email?: unknown };
type GitHubEmailBody = Array<{ email?: unknown; primary?: unknown; verified?: unknown }>;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function githubHeaders(token: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "atelier",
    "x-github-api-version": "2022-11-28",
  };
}

async function fetchPrimaryGitHubEmail(token: string): Promise<string | undefined> {
  try {
    const response = await fetch("https://api.github.com/user/emails", { headers: githubHeaders(token) });
    if (!response.ok) return undefined;
    const emails = await response.json().catch(() => undefined) as GitHubEmailBody | undefined;
    const primary = emails?.find((email) => email.primary === true && email.verified === true && nonEmptyString(email.email));
    return nonEmptyString(primary?.email);
  } catch {
    return undefined;
  }
}

export async function validateGitHubToken(token: string): Promise<GitHubTokenValidation> {
  const trimmed = token.trim();
  if (!trimmed) return { ok: false, message: "Enter a GitHub token." };

  let response: Response;
  try {
    response = await fetch("https://api.github.com/user", { headers: githubHeaders(trimmed) });
  } catch {
    return { ok: false, message: "Could not reach GitHub. Check your network and try again." };
  }

  if (response.status === 401 || response.status === 403) return { ok: false, message: "GitHub rejected that token. Check that it is active and has repository read access." };
  if (!response.ok) return { ok: false, message: `GitHub token validation failed (${response.status}). Try again.` };

  const body = await response.json().catch(() => undefined) as GitHubUserBody | undefined;
  const login = nonEmptyString(body?.login) ?? "github-user";
  const id = typeof body?.id === "number" ? body.id : undefined;
  const name = nonEmptyString(body?.name) ?? login;
  const email = nonEmptyString(body?.email) ?? await fetchPrimaryGitHubEmail(trimmed) ?? (id ? `${id}+${login}@users.noreply.github.com` : `${login}@users.noreply.github.com`);
  return { ok: true, name, email };
}
