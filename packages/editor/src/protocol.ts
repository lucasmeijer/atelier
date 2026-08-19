import type { JsonValue } from "@atelier/core";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const editorFileResponseSchema = Type.Object({
  path: Type.String(),
  content: Type.String(),
  revision: Type.String(),
  writable: Type.Boolean(),
});

const editorSaveResponseSchema = Type.Object({ revision: Type.String() });

const editorSaveRequestSchema = Type.Object({
  content: Type.String(),
  revision: Type.String(),
  force: Type.Optional(Type.Boolean()),
});

export type EditorFileResponse = Static<typeof editorFileResponseSchema>;
export type EditorSaveRequest = Static<typeof editorSaveRequestSchema>;

export function parseEditorFileResponse(value: JsonValue): EditorFileResponse {
  return Value.Parse(editorFileResponseSchema, value);
}

export function parseEditorSaveResponse(value: JsonValue): Static<typeof editorSaveResponseSchema> {
  return Value.Parse(editorSaveResponseSchema, value);
}

export function isEditorSaveRequest(value: unknown): value is EditorSaveRequest {
  return Value.Check(editorSaveRequestSchema, value);
}
