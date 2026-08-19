import type { JsonValue } from "@atelier/core";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const workspaceImageMetadataSchema = Type.Object({
  tag: Type.String(),
  modules: Type.Array(Type.String()),
});

export type WorkspaceImageMetadata = Static<typeof workspaceImageMetadataSchema>;

export function parseWorkspaceImageMetadata(value: JsonValue): WorkspaceImageMetadata {
  return Value.Parse(workspaceImageMetadataSchema, value);
}
