import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

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

const githubUserResponseSchema = Type.Object({
  id: Type.Integer(),
  login: Type.String({ minLength: 1, pattern: "\\S" }),
  name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  email: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const githubEmailResponseSchema = Type.Array(Type.Object({
  email: Type.String({ minLength: 1, pattern: "\\S" }),
  primary: Type.Boolean(),
  verified: Type.Boolean(),
}));

function optionalTrimmed(value: string | null | undefined): string | undefined {
  return value?.trim() || undefined;
}

async function decodeJsonResponse<Schema extends TSchema>(response: Response, schema: Schema): Promise<Static<Schema> | undefined> {
  try {
    const encoded: unknown = await response.json();
    return Value.Parse(schema, encoded);
  } catch {
    return undefined;
  }
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
    const emails = await decodeJsonResponse(response, githubEmailResponseSchema);
    if (!emails) return undefined;
    for (const email of emails) {
      if (email.primary && email.verified) return email.email.trim();
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

  const body = await decodeJsonResponse(response, githubUserResponseSchema);
  if (!body) return { ok: false, message: "GitHub returned an invalid user response. Try again." };
  const login = body.login.trim();
  const name = optionalTrimmed(body.name) ?? login;
  const email = optionalTrimmed(body.email) ?? await fetchPrimaryGitHubEmail(trimmed) ?? `${body.id}+${login}@users.noreply.github.com`;
  return { ok: true, name, email };
}
