import { invalidArguments } from "./errors.ts";

export function requestAcceptsJson(request: Request): boolean {
  return request.headers.get("accept")?.includes("application/json") ?? false;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export async function readJsonObject(request: Request): Promise<JsonObject> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw invalidArguments("valid JSON object body is required");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidArguments("JSON object body is required");
  // SAFETY: Request.json() only produces JSON values, and the checks above establish the object variant.
  return value as JsonObject;
}
