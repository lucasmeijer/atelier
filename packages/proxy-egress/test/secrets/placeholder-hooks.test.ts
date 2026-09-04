import { describe, expect, test } from "bun:test";
import { HttpRequestBlockedError } from "../../src/secrets/errors.ts";
import { createHttpHooks } from "../../src/secrets/placeholder-hooks.ts";
import { matchHostname } from "../../src/secrets/patterns.ts";
import { isInternalAddress } from "../../src/secrets/ip.ts";

function expectRequest(result: Request | Response | void): asserts result is Request {
  expect(result).toBeInstanceOf(Request);
}

describe("secret placeholder hooks", () => {
  test("creates placeholder env var, not real secret", () => {
    const hooks = createHttpHooks({ secrets: { GH_TOKEN: { value: "real-secret", hosts: ["github.com"] } } });
    expect(hooks.env.GH_TOKEN).toMatch(/^ATELIER_SECRET_[0-9a-f]{48}$/);
    expect(hooks.env.GH_TOKEN).not.toBe("real-secret");
  });

  test("replaces bearer placeholder for allowed host", async () => {
    const hooks = createHttpHooks({ secrets: { GH_TOKEN: { value: "real-secret", hosts: ["api.github.com"], placeholder: "ATELIER_SECRET_fake" } } });
    const result = await hooks.httpHooks.onRequest!(new Request("https://api.github.com/user", { headers: { authorization: "Bearer ATELIER_SECRET_fake" } }));
    expectRequest(result);
    expect(result.headers.get("authorization")).toBe("Bearer real-secret");
  });

  test("blocks placeholder sent to disallowed host", async () => {
    const hooks = createHttpHooks({ secrets: { GH_TOKEN: { value: "real-secret", hosts: ["github.com"], placeholder: "ATELIER_SECRET_fake" } } });
    await expect(hooks.httpHooks.onRequest!(new Request("https://example.com", { headers: { authorization: "Bearer ATELIER_SECRET_fake" } }))).rejects.toBeInstanceOf(HttpRequestBlockedError);
  });

  test("preserves unrelated headers and request ownership during repeated secret injection", async () => {
    for (const replaceSecretsInPath of [false, true]) {
      const hooks = createHttpHooks({ replaceSecretsInPath, secrets: { TOKEN: { value: "real-secret", hosts: ["example.com"], placeholder: "ATELIER_SECRET_fake" } } });
      for (let attempt = 0; attempt < 2; attempt++) {
        const request = new Request("https://example.com/ATELIER_SECRET_fake", {
          headers: { authorization: "Bearer ATELIER_SECRET_fake", "x-request-id": String(attempt) },
        });
        const result = await hooks.httpHooks.onRequest(request);
        expect(result === request).toBe(!replaceSecretsInPath);
        expect(result.headers.get("authorization")).toBe("Bearer real-secret");
        expect(result.headers.get("x-request-id")).toBe(String(attempt));
        expect(request.headers.get("authorization")).toBe(replaceSecretsInPath ? "Bearer ATELIER_SECRET_fake" : "Bearer real-secret");
      }
    }
  });

  test("replaces Basic auth password placeholders", async () => {
    const hooks = createHttpHooks({ secrets: { GH_TOKEN: { value: "real-secret", hosts: ["github.com"], placeholder: "ATELIER_SECRET_fake" } } });
    const basic = Buffer.from("x-access-token:ATELIER_SECRET_fake").toString("base64");
    const result = await hooks.httpHooks.onRequest!(new Request("https://github.com/repo.git", { headers: { authorization: `Basic ${basic}` } }));
    expectRequest(result);
    expect(result.headers.get("authorization")).toBe(`Basic ${Buffer.from("x-access-token:real-secret").toString("base64")}`);
  });

  test("does not replace request body", async () => {
    const hooks = createHttpHooks({ secrets: { GH_TOKEN: { value: "real-secret", hosts: ["github.com"], placeholder: "ATELIER_SECRET_fake" } } });
    const result = await hooks.httpHooks.onRequest!(new Request("https://github.com", { method: "POST", body: "ATELIER_SECRET_fake" }));
    expectRequest(result);
    expect(await result.text()).toBe("ATELIER_SECRET_fake");
  });

  test("does not replace URL path by default", async () => {
    const hooks = createHttpHooks({ secrets: { API_TOKEN: { value: "123:secret", hosts: ["api.example.com"], placeholder: "ATELIER_SECRET_fake" } } });
    const result = await hooks.httpHooks.onRequest!(new Request("https://api.example.com/botATELIER_SECRET_fake/getMe"));
    expectRequest(result);
    expect(result.url).toBe("https://api.example.com/botATELIER_SECRET_fake/getMe");
  });

  test("optionally replaces a URL path placeholder for an allowed host", async () => {
    const hooks = createHttpHooks({ replaceSecretsInPath: true, secrets: { API_TOKEN: { value: "123:secret", hosts: ["api.example.com"], placeholder: "ATELIER_SECRET_fake" } } });
    const result = await hooks.httpHooks.onRequest!(new Request("https://api.example.com/botATELIER_SECRET_fake/getMe"));
    expectRequest(result);
    expect(result.url).toBe("https://api.example.com/bot123:secret/getMe");
  });

  test("leaves a URL path placeholder unchanged for a nonmatching host", async () => {
    const hooks = createHttpHooks({ replaceSecretsInPath: true, secrets: { API_TOKEN: { value: "123:secret", hosts: ["api.example.com"], placeholder: "ATELIER_SECRET_fake" } } });
    const result = await hooks.httpHooks.onRequest!(new Request("https://example.com/botATELIER_SECRET_fake/getMe"));
    expectRequest(result);
    expect(result.url).toBe("https://example.com/botATELIER_SECRET_fake/getMe");
  });

  test("URL-encodes reserved characters injected into a path", async () => {
    const hooks = createHttpHooks({ replaceSecretsInPath: true, secrets: { API_TOKEN: { value: "secret value?#", hosts: ["api.example.com"], placeholder: "ATELIER_SECRET_fake" } } });
    const result = await hooks.httpHooks.onRequest!(new Request("https://api.example.com/token/ATELIER_SECRET_fake"));
    expectRequest(result);
    expect(result.url).toBe("https://api.example.com/token/secret%20value%3F%23");
  });

  test("does not replace query string by default", async () => {
    const hooks = createHttpHooks({ secrets: { GH_TOKEN: { value: "real-secret", hosts: ["github.com"], placeholder: "ATELIER_SECRET_fake" } } });
    const result = await hooks.httpHooks.onRequest!(new Request("https://github.com/?token=ATELIER_SECRET_fake"));
    expectRequest(result);
    expect(result.url).toContain("ATELIER_SECRET_fake");
  });

  test("optionally replaces query string only for a matching host", async () => {
    const hooks = createHttpHooks({ replaceSecretsInQuery: true, secrets: { GH_TOKEN: { value: "real-secret", hosts: ["github.com"], placeholder: "ATELIER_SECRET_fake" } } });
    const matching = await hooks.httpHooks.onRequest!(new Request("https://github.com/?token=ATELIER_SECRET_fake"));
    const nonmatching = await hooks.httpHooks.onRequest!(new Request("https://example.com/?token=ATELIER_SECRET_fake"));
    expectRequest(matching);
    expectRequest(nonmatching);
    expect(matching.url).toContain("token=real-secret");
    expect(nonmatching.url).toContain("token=ATELIER_SECRET_fake");
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
