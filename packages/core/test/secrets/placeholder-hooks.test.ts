import { describe, expect, test } from "bun:test";
import { HttpRequestBlockedError } from "../../src/secrets/errors.ts";
import { createHttpHooks } from "../../src/secrets/placeholder-hooks.ts";
import { matchHostname } from "../../src/secrets/patterns.ts";
import { isInternalAddress } from "../../src/secrets/ip.ts";

describe("secret placeholder hooks", () => {
  test("creates placeholder env var, not real secret", () => {
    const hooks = createHttpHooks({ secrets: { GH_TOKEN: { value: "real-secret", hosts: ["github.com"] } } });
    expect(hooks.env.GH_TOKEN).toMatch(/^ATELIER_SECRET_[0-9a-f]{48}$/);
    expect(hooks.env.GH_TOKEN).not.toBe("real-secret");
  });

  test("replaces bearer placeholder for allowed host", async () => {
    const hooks = createHttpHooks({ secrets: { GH_TOKEN: { value: "real-secret", hosts: ["api.github.com"], placeholder: "ATELIER_SECRET_fake" } } });
    const result = await hooks.httpHooks.onRequest!(new Request("https://api.github.com/user", { headers: { authorization: "Bearer ATELIER_SECRET_fake" } }));
    expect(result).toBeInstanceOf(Request);
    expect((result as Request).headers.get("authorization")).toBe("Bearer real-secret");
  });

  test("blocks placeholder sent to disallowed host", async () => {
    const hooks = createHttpHooks({ secrets: { GH_TOKEN: { value: "real-secret", hosts: ["github.com"], placeholder: "ATELIER_SECRET_fake" } } });
    await expect(hooks.httpHooks.onRequest!(new Request("https://example.com", { headers: { authorization: "Bearer ATELIER_SECRET_fake" } }))).rejects.toBeInstanceOf(HttpRequestBlockedError);
  });

  test("replaces Basic auth password placeholders", async () => {
    const hooks = createHttpHooks({ secrets: { GH_TOKEN: { value: "real-secret", hosts: ["github.com"], placeholder: "ATELIER_SECRET_fake" } } });
    const basic = Buffer.from("x-access-token:ATELIER_SECRET_fake").toString("base64");
    const result = await hooks.httpHooks.onRequest!(new Request("https://github.com/repo.git", { headers: { authorization: `Basic ${basic}` } }));
    expect((result as Request).headers.get("authorization")).toBe(`Basic ${Buffer.from("x-access-token:real-secret").toString("base64")}`);
  });

  test("does not replace request body", async () => {
    const hooks = createHttpHooks({ secrets: { GH_TOKEN: { value: "real-secret", hosts: ["github.com"], placeholder: "ATELIER_SECRET_fake" } } });
    const result = await hooks.httpHooks.onRequest!(new Request("https://github.com", { method: "POST", body: "ATELIER_SECRET_fake" }));
    expect(await (result as Request).text()).toBe("ATELIER_SECRET_fake");
  });

  test("does not replace query string by default", async () => {
    const hooks = createHttpHooks({ secrets: { GH_TOKEN: { value: "real-secret", hosts: ["github.com"], placeholder: "ATELIER_SECRET_fake" } } });
    const result = await hooks.httpHooks.onRequest!(new Request("https://github.com/?token=ATELIER_SECRET_fake"));
    expect((result as Request).url).toContain("ATELIER_SECRET_fake");
  });

  test("optionally replaces query string", async () => {
    const hooks = createHttpHooks({ replaceSecretsInQuery: true, secrets: { GH_TOKEN: { value: "real-secret", hosts: ["github.com"], placeholder: "ATELIER_SECRET_fake" } } });
    const result = await hooks.httpHooks.onRequest!(new Request("https://github.com/?token=ATELIER_SECRET_fake"));
    expect((result as Request).url).toContain("token=real-secret");
  });

  test("rejects duplicate and overlapping placeholders", () => {
    expect(() => createHttpHooks({ secrets: { A: { value: "a", hosts: ["*"], placeholder: "same" }, B: { value: "b", hosts: ["*"], placeholder: "same" } } })).toThrow(/duplicate/);
    expect(() => createHttpHooks({ secrets: { A: { value: "a", hosts: ["*"], placeholder: "ATELIER_SECRET_abc" }, B: { value: "b", hosts: ["*"], placeholder: "ATELIER_SECRET_abc123" } } })).toThrow(/overlaps/);
  });

  test("allows placeholder equal to secret for nested hooks", () => {
    const hooks = createHttpHooks({ secrets: { A: { value: "same", hosts: ["*"], placeholder: "same" } } });
    expect(hooks.env.A).toBe("same");
  });

  test("blocks real secret value sent to disallowed host", async () => {
    const hooks = createHttpHooks({ secrets: { GH_TOKEN: { value: "real-secret", hosts: ["github.com"], placeholder: "ATELIER_SECRET_fake" } } });
    await expect(hooks.httpHooks.onRequest!(new Request("https://example.com", { headers: { authorization: "Bearer real-secret" } }))).rejects.toBeInstanceOf(HttpRequestBlockedError);
  });
});

describe("host patterns and internal IP checks", () => {
  test("matches exact and wildcard github hosts without lookalikes", () => {
    expect(matchHostname("api.github.com", "api.github.com")).toBe(true);
    expect(matchHostname("github.com", "github.com")).toBe(true);
    expect(matchHostname("raw.githubusercontent.com", "*.githubusercontent.com")).toBe(true);
    expect(matchHostname("evilgithub.com", "*.github.com")).toBe(false);
    expect(matchHostname("github.com.evil.test", "github.com")).toBe(false);
  });

  test("detects internal and metadata IPs", () => {
    expect(isInternalAddress("169.254.169.254")).toBe(true);
    expect(isInternalAddress("100.100.100.200")).toBe(true);
    expect(isInternalAddress("10.1.2.3")).toBe(true);
    expect(isInternalAddress("127.0.0.1")).toBe(true);
    expect(isInternalAddress("8.8.8.8")).toBe(false);
    expect(isInternalAddress("::1")).toBe(true);
    expect(isInternalAddress("fc00::1")).toBe(true);
  });
});
