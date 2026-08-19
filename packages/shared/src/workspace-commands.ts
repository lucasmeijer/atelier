import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const serializedWorkspaceCommandSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  description: Type.Optional(Type.String()),
  scope: Type.Union([
    Type.Literal("global"),
    Type.Literal("workspace"),
    Type.Literal("group"),
    Type.Literal("tab"),
  ]),
  binding: Type.Optional(Type.String()),
});

const serializedWorkspaceCommandsSchema = Type.Array(serializedWorkspaceCommandSchema);

export type SerializedWorkspaceCommand = Static<typeof serializedWorkspaceCommandSchema>;

export function parseSerializedWorkspaceCommands(serialized: string): SerializedWorkspaceCommand[] {
  const commands: unknown = JSON.parse(serialized);
  if (!Value.Check(serializedWorkspaceCommandsSchema, commands)) throw new Error("Invalid serialized workspace commands");
  return commands;
}
