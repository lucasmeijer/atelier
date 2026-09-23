import { Type } from "typebox";
import { Value } from "typebox/value";
import { shellQuote } from "@atelier/core";
import { registerWorkspaceResponseTransform, registerWorkspaceSubscriptionSecrets } from "@atelier/proxy-egress/server";
import { execWorkspaceCommand, listWorkspaces } from "@atelier/workspace";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

const codexToken = "atelier-subscription-codex-access";
const codexAccount = "atelier-subscription-codex-account";
const anthropicToken = "atelier-subscription-anthropic-access";

export function registerSubscriptionCli(getRuntime: () => Promise<ModelRuntime>): void {
  async function subscriptionToken(provider: string): Promise<string> {
    const auth = await (await getRuntime()).getAuth(provider);
    if (auth?.source !== "OAuth" || !auth.auth.apiKey) throw new Error(`Connect a ${provider} subscription in Atelier to use this CLI.`);
    return auth.auth.apiKey;
  }
  registerWorkspaceResponseTransform("codex-accounts-check", async (response, request) => {
    if (new URL(request.url).hostname !== "chatgpt.com" || !["/api/codex/accounts/check", "/backend-api/wham/accounts/check"].includes(new URL(request.url).pathname) || !response.ok) return response;
    const accountId = codexAccountId(await subscriptionToken("openai-codex"));
    return maskCodexAccountDiscovery(response, accountId);
  });
  registerWorkspaceSubscriptionSecrets({
    codexSubscription: { placeholder: codexToken, hosts: ["chatgpt.com"], value: "", resolve: () => subscriptionToken("openai-codex") },
    codexAccount: { placeholder: codexAccount, hosts: ["chatgpt.com"], value: "", resolve: async () => {
      const token = await subscriptionToken("openai-codex");
      return codexAccountId(token);
    } },
    anthropicSubscription: { placeholder: anthropicToken, hosts: ["api.anthropic.com"], value: "", resolve: () => subscriptionToken("anthropic") },
  });
}

function codexAccountId(token: string): string {
  const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
  return Value.Parse(Type.Object({ "https://api.openai.com/auth": Type.Object({ chatgpt_account_id: Type.String({ minLength: 1 }) }) }), claims)["https://api.openai.com/auth"].chatgpt_account_id;
}

/** Codex 0.154+ checks that its selected account appears in accounts/check.
 * Keep the real account ID in the host: translate that endpoint's selected ID
 * back to the placeholder in the response, just as requests translate it out.
 */
export async function maskCodexAccountDiscovery(response: Response, accountId: string): Promise<Response> {
  const payload: unknown = await response.clone().json().catch(() => null);
  if (!Value.Check(Type.Object({ accounts: Type.Array(Type.Object({ id: Type.String() })) }), payload)) return response;
  for (const account of payload.accounts) if (account.id === accountId) account.id = codexAccount;
  const discovery = payload as typeof payload & { account_ordering?: string[]; default_account_id?: string };
  if (Array.isArray(discovery.account_ordering)) discovery.account_ordering = discovery.account_ordering.map(id => id === accountId ? codexAccount : id);
  if (discovery.default_account_id === accountId) discovery.default_account_id = codexAccount;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(JSON.stringify(payload), { status: response.status, statusText: response.statusText, headers });
}

// Only placeholders enter the sandbox. Pi owns refresh tokens and refresh serialization.
// Far-future timestamps keep the CLIs from trying to refresh these non-credentials.
export function subscriptionCliFiles(): Array<{ provider: string; path: string; content: string; marker: string }> {
  const idToken = [Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"), Buffer.from(JSON.stringify({
    email: "subscription@atelier.local",
    "https://api.openai.com/auth": { chatgpt_account_id: codexAccount },
  })).toString("base64url"), "atelier"].join(".");
  return [
    { provider: "openai-codex", path: ".codex/auth.json", marker: codexToken, content: JSON.stringify({
      auth_mode: "chatgpt", OPENAI_API_KEY: null,
      tokens: { id_token: idToken, access_token: codexToken, refresh_token: "", account_id: codexAccount },
      last_refresh: "2099-01-01T00:00:00Z",
    }) },
    { provider: "anthropic", path: ".claude/.credentials.json", marker: anthropicToken, content: JSON.stringify({
      // An empty refresh token means revoked/expired to Claude Code. Null means
      // there is no local refresh credential; Atelier owns token refresh instead.
      claudeAiOauth: { accessToken: anthropicToken, refreshToken: null, expiresAt: 4070908800000, scopes: ["user:inference", "user:profile"] },
    }) },
  ];
}

export async function installSubscriptionCli(workspaceId: string, runtime: ModelRuntime): Promise<void> {
  const credentials = await runtime.listCredentials();
  for (const file of subscriptionCliFiles()) {
    const connected = credentials.some((credential) => credential.providerId === file.provider && credential.type === "oauth");
    const path = shellQuote(`/home/atelier/${file.path}`);
    const result = await execWorkspaceCommand(workspaceId, ["sh", "-c", `set -eu
umask 077
${connected ? `if [ ! -e ${path} ] || grep -qF ${shellQuote(file.marker)} ${path}; then
  mkdir -p "$(dirname ${path})"
  temporary="$(mktemp ${path}.XXXXXX)"
  printf '%s\\n' ${shellQuote(file.content)} > "$temporary"
  mv "$temporary" ${path}
fi` : `if [ -f ${path} ] && grep -qF ${shellQuote(file.marker)} ${path}; then rm ${path}; fi`}`]);
    if (result.exitCode !== 0) throw new Error(`Could not configure subscription CLI: ${result.stderr}`);
  }
}

export async function syncSubscriptionClis(runtime: ModelRuntime): Promise<void> {
  for (const workspace of (await listWorkspaces({ inspectImages: false })).workspaces) {
    if (!workspace.parked) await installSubscriptionCli(workspace.id, runtime);
  }
}
