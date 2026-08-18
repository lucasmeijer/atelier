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
    const emails: unknown = await response.json().catch(() => undefined);
    if (!Array.isArray(emails)) return undefined;
    for (const email of emails) {
      if (!(email instanceof Object) || !("primary" in email) || email.primary !== true || !("verified" in email) || email.verified !== true || !("email" in email)) continue;
      const primary = nonEmptyString(email.email);
      if (primary) return primary;
    }
    return undefined;
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

  const body: unknown = await response.json().catch(() => undefined);
  const login = nonEmptyString(body instanceof Object && "login" in body ? body.login : undefined) ?? "github-user";
  const idValue = body instanceof Object && "id" in body ? body.id : undefined;
  const id = typeof idValue === "number" ? idValue : undefined;
  const name = nonEmptyString(body instanceof Object && "name" in body ? body.name : undefined) ?? login;
  const email = nonEmptyString(body instanceof Object && "email" in body ? body.email : undefined) ?? await fetchPrimaryGitHubEmail(trimmed) ?? (id ? `${id}+${login}@users.noreply.github.com` : `${login}@users.noreply.github.com`);
  return { ok: true, name, email };
}
