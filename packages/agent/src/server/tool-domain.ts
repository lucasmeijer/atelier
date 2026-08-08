import type { DiffOperation } from "./diff.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface BashToolInput {
  kind: "bash";
  name: "bash";
  command: string;
  timeoutSeconds: number;
}

export interface ReadToolInput {
  kind: "read";
  name: "read";
  path?: string;
  offset?: number;
  limit?: number;
}

export interface WriteToolInput {
  kind: "write";
  name: "write";
  path?: string;
  content: string;
}

export interface EditToolInput {
  kind: "edit";
  name: "edit";
  path?: string;
  operations: DiffOperation[];
}

export interface GenericToolInput {
  kind: "generic";
  name: string;
  args?: JsonObject;
}

export type ToolInput = BashToolInput | ReadToolInput | WriteToolInput | EditToolInput | GenericToolInput;

export interface ToolResultDetails {
  exitCode?: number;
  aborted: boolean;
  timedOut: boolean;
  displayAnsi?: string;
  patch?: string;
}

function objectValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Reflect.get(value, key);
}

function stringField(value: unknown, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const field = objectValue(value, key);
    if (typeof field === "string") return field;
  }
  return undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  const field = objectValue(value, key);
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function editOperations(value: unknown): DiffOperation[] {
  const edits = objectValue(value, "edits");
  if (Array.isArray(edits)) {
    return edits.flatMap((edit) => {
      const oldText = stringField(edit, "oldText");
      const newText = stringField(edit, "newText");
      return oldText !== undefined && newText !== undefined ? [{ oldText, newText }] : [];
    });
  }
  const oldText = stringField(value, "oldText");
  const newText = stringField(value, "newText");
  return oldText !== undefined && newText !== undefined ? [{ oldText, newText }] : [];
}

function jsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const parsed: JsonValue[] = [];
    for (const item of value) {
      const next = jsonValue(item);
      if (next === undefined) return undefined;
      parsed.push(next);
    }
    return parsed;
  }
  if (!value || typeof value !== "object") return undefined;
  const parsed: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    const next = jsonValue(item);
    if (next === undefined) return undefined;
    parsed[key] = next;
  }
  return parsed;
}

function jsonObject(value: unknown): JsonObject | undefined {
  const parsed = jsonValue(value);
  return parsed && !Array.isArray(parsed) && typeof parsed === "object" ? parsed : undefined;
}

export function parseToolInput(name: string, args: unknown): ToolInput {
  if (name === "bash") {
    const timeout = numberField(args, "timeout");
    return { kind: "bash", name, command: stringField(args, "command") ?? "", timeoutSeconds: timeout && timeout > 0 ? timeout : 600 };
  }
  if (name === "read") return { kind: "read", name, path: stringField(args, "path", "file_path"), offset: numberField(args, "offset"), limit: numberField(args, "limit") };
  if (name === "write") return { kind: "write", name, path: stringField(args, "path", "file_path"), content: stringField(args, "content") ?? "" };
  if (name === "edit") return { kind: "edit", name, path: stringField(args, "path", "file_path"), operations: editOperations(args) };
  return { kind: "generic", name, args: jsonObject(args) };
}

export function parseToolResultDetails(name: string, details: unknown): ToolResultDetails {
  return {
    exitCode: numberField(details, "exitCode"),
    aborted: objectValue(details, "aborted") === true,
    timedOut: objectValue(details, "timedOut") === true,
    displayAnsi: name === "bash" ? stringField(details, "displayAnsi") : undefined,
    patch: name === "edit" ? stringField(details, "patch") : undefined,
  };
}

export function toolResultIndicatesError(details: ToolResultDetails): boolean {
  return details.aborted || details.timedOut || (details.exitCode !== undefined && details.exitCode !== 0);
}

function partialStringField(stream: string, key: string): string | undefined {
  const marker = new RegExp(`"${key}"\\s*:\\s*"`).exec(stream);
  if (!marker) return undefined;
  const start = marker.index + marker[0].length;
  let escaped = false;
  let raw = "";
  for (let index = start; index < stream.length; index++) {
    const char = stream[index]!;
    if (!escaped && char === '"') break;
    raw += char;
    if (escaped) escaped = false;
    else if (char === "\\") escaped = true;
  }
  if (raw.endsWith("\\")) raw = raw.slice(0, -1);
  try { return JSON.parse(`"${raw}"`) as string; } catch { return raw.replaceAll("\\n", "\n").replaceAll('\\"', '"'); }
}

export function parseStreamingToolInput(name: string, stream: string): ToolInput {
  if (stream.trim()) {
    try { return parseToolInput(name, JSON.parse(stream)); } catch { /* partial external JSON */ }
  }
  if (name === "bash") return parseToolInput(name, { command: partialStringField(stream, "command") ?? "" });
  if (name === "write") return parseToolInput(name, { path: partialStringField(stream, "path"), content: partialStringField(stream, "content") ?? "" });
  if (name === "read" || name === "edit") return parseToolInput(name, { path: partialStringField(stream, "path") });
  return parseToolInput(name, undefined);
}
