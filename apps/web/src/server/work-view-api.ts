import { invalidArguments, type JsonObject } from "@atelier/core";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const workViewReferenceSchema = Type.Intersect([
  Type.Object({ type: Type.String() }),
  Type.Record(Type.String(), Type.Unknown()),
]);

export const reorderWorkViewRequestSchema = Type.Object({
  key: Type.String(),
  index: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

export const closeWorkViewRequestSchema = Type.Object({
  reference: workViewReferenceSchema,
}, { additionalProperties: false });

export function parseReorderWorkViewRequest(body: JsonObject): Static<typeof reorderWorkViewRequestSchema> {
  if (!Value.Check(reorderWorkViewRequestSchema, body)) throw invalidArguments("key and non-negative integer index are required");
  return body;
}

export function parseCloseWorkViewRequest(body: JsonObject): Static<typeof closeWorkViewRequestSchema> {
  if (!Value.Check(closeWorkViewRequestSchema, body)) throw invalidArguments("reference with a type is required");
  return body;
}
