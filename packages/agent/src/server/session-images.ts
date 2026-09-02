import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { imageMimeByExtension } from "./attachment-drafts.ts";

const allowedMimeTypes = new Set(Object.values(imageMimeByExtension));
const entrySchema = Type.Object({
  id: Type.String(),
  message: Type.Object({ content: Type.Array(Type.Unknown()) }),
});
const imagePartSchema = Type.Object({
  type: Type.Literal("image"),
  mimeType: Type.String(),
  data: Type.String(),
});

export async function sessionImageEndpoint(sessionFile: string, entryId: string, contentIndex: number): Promise<Response> {
  const lines = (await readFile(sessionFile, "utf8")).split("\n").filter(Boolean);
  const entry = lines
    .map((line) => {
      const candidate: unknown = JSON.parse(line);
      return Value.Check(entrySchema, candidate) ? candidate : undefined;
    })
    .find((candidate) => candidate?.id === entryId);
  if (!entry) return new Response("not found", { status: 404 });

  const part = entry.message.content[contentIndex];
  if (!Value.Check(imagePartSchema, part) || !allowedMimeTypes.has(part.mimeType)) return new Response("not found", { status: 404 });

  const data = Buffer.from(part.data, "base64");
  return new Response(data, { headers: {
    "cache-control": "private, max-age=31536000, immutable",
    "content-length": String(data.byteLength),
    "content-security-policy": "default-src 'none'; sandbox",
    "content-type": part.mimeType,
    "x-content-type-options": "nosniff",
  } });
}
