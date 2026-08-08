import { invalidArguments } from "./errors.ts";

export interface JsonObject {
  [field: string]: unknown;
}

export function requestAcceptsJson(request: Request): boolean {
  return request.headers.get("accept")?.includes("application/json") ?? false;
}

export async function readJsonObject<T>(request: Request, parse: (value: JsonObject) => T): Promise<T> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw invalidArguments("valid JSON object body is required");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidArguments("JSON object body is required");
  return parse(value as JsonObject);
}
