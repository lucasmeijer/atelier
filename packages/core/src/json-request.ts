import { invalidArguments } from "./errors.ts";

export function requestAcceptsJson(request: Request): boolean {
  return request.headers.get("accept")?.includes("application/json") ?? false;
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw invalidArguments("valid JSON object body is required");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidArguments("JSON object body is required");
  return value as Record<string, unknown>;
}
