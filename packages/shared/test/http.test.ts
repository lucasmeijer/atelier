import { expect, test } from "bun:test";
import { response, wantsStream } from "../src/http.ts";

test("HTML responses default to a non-cacheable UTF-8 representation", () => {
  const result = response("content", { status: 422 });
  expect(result.status).toBe(422);
  expect(result.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(result.headers.get("cache-control")).toBe("no-store");
});

test("HTML responses retain caller-provided headers and cache policy", () => {
  const headers = new Headers({ "cache-control": "private, max-age=60", "x-operation": "settings" });
  const result = response("content", { headers });
  expect(result.headers.get("cache-control")).toBe("private, max-age=60");
  expect(result.headers.get("x-operation")).toBe("settings");
  expect(headers.has("content-type")).toBe(false);
});

test("Turbo content negotiation distinguishes stream requests from ordinary navigation", () => {
  expect(wantsStream(new Request("http://atelier.test"))).toBe(false);
  expect(wantsStream(new Request("http://atelier.test", { headers: { accept: "text/html" } }))).toBe(false);
  expect(wantsStream(new Request("http://atelier.test", { headers: { accept: "text/vnd.turbo-stream.html, text/html" } }))).toBe(true);
});
