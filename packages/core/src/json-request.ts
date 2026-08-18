import { invalidArguments } from "./errors.ts";

export function requestAcceptsJson(request: Request): boolean {
  return request.headers.get("accept")?.includes("application/json") ?? false;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

function isJsonValue(value: unknown): value is JsonValue {
  return value === null
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
    || typeof value === "string"
    || (Array.isArray(value) ? value.every(isJsonValue) : isJsonObject(value));
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every(isJsonValue);
}

export async function readJsonObject(request: Request): Promise<JsonObject> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw invalidArguments("valid JSON object body is required");
  }
  if (!isJsonObject(value)) throw invalidArguments("JSON object body is required");
  return value;
}
