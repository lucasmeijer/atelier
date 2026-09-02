import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atelierDataPath, getAtelierRuntimeContext } from "@atelier/core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ReviewDiffLayout } from "../model.ts";

const settingsSchema = Type.Object({
  diffLayout: Type.Union([Type.Literal("unified"), Type.Literal("split")]),
});

function settingsPath(): string {
  return atelierDataPath(getAtelierRuntimeContext(), "review-settings.json");
}

export function isReviewDiffLayout(value: string): value is ReviewDiffLayout {
  return value === "unified" || value === "split";
}

export async function readReviewDiffLayout(path = settingsPath()): Promise<ReviewDiffLayout> {
  const text = await readFile(path, "utf8").catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!text) return "unified";
  return Value.Parse(settingsSchema, JSON.parse(text)).diffLayout;
}

export async function writeReviewDiffLayout(diffLayout: ReviewDiffLayout, path = settingsPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({ diffLayout }, null, 2)}\n`);
  await rename(temporaryPath, path);
}
