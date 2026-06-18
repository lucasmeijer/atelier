export interface GitHubTokenValidationSuccess {
  ok: true;
  login: string;
}

export interface GitHubTokenValidationFailure {
  ok: false;
  message: string;
}

export type GitHubTokenValidation = GitHubTokenValidationSuccess | GitHubTokenValidationFailure;

export async function validateGitHubToken(token: string): Promise<GitHubTokenValidation> {
  const trimmed = token.trim();
  if (!trimmed) return { ok: false, message: "Enter a GitHub token." };

  let response: Response;
  try {
    response = await fetch("https://api.github.com/user", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${trimmed}`,
        "user-agent": "atelier",
        "x-github-api-version": "2022-11-28",
      },
    });
  } catch {
    return { ok: false, message: "Could not reach GitHub. Check your network and try again." };
  }

  if (response.status === 401 || response.status === 403) return { ok: false, message: "GitHub rejected that token. Check that it is active and has repository read access." };
  if (!response.ok) return { ok: false, message: `GitHub token validation failed (${response.status}). Try again.` };

  const body = await response.json().catch(() => undefined) as { login?: unknown } | undefined;
  const login = typeof body?.login === "string" && body.login ? body.login : "GitHub user";
  return { ok: true, login };
}
