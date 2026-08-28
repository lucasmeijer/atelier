import type { JsonValue } from "@atelier/core";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const editableFileSchema = Type.Object({
  content: Type.String(),
  revision: Type.String(),
  writable: Type.Boolean(),
});
const fileSaveResponseSchema = Type.Object({ revision: Type.String() });

export const fileSaveRequestSchema = Type.Object({
  content: Type.String(),
  revision: Type.String(),
  force: Type.Optional(Type.Boolean()),
});

export type FileSaveRequest = Static<typeof fileSaveRequestSchema>;
export type EditableFileResponse = Static<typeof editableFileSchema>;

export function parseEditableFileResponse(value: JsonValue): EditableFileResponse {
  return Value.Parse(editableFileSchema, value);
}

export function parseFileSaveResponse(value: JsonValue): Static<typeof fileSaveResponseSchema> {
  return Value.Parse(fileSaveResponseSchema, value);
}
