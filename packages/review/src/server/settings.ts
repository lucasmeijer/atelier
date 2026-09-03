import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atelierDataPath, getAtelierRuntimeContext } from "@atelier/core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  defaultReviewSettings,
  type ReviewDiffLayout,
  type ReviewSettings,
  type ReviewViewport,
} from "../model.ts";

const diffLayoutSchema = Type.Union([Type.Literal("unified"), Type.Literal("split")]);
const settingsSchema = Type.Object({
  mobile: diffLayoutSchema,
  desktop: diffLayoutSchema,
  highlighting: Type.Union([Type.Literal("line"), Type.Literal("word")]),
  overflow: Type.Union([Type.Literal("scroll"), Type.Literal("wrap")]),
});

function settingsPath(): string {
  return atelierDataPath(getAtelierRuntimeContext(), "review-settings.json");
}

export function isReviewDiffLayout(value: string): value is ReviewDiffLayout {
  return value === "unified" || value === "split";
}

export function isReviewViewport(value: string): value is ReviewViewport {
  return value === "mobile" || value === "desktop";
}

export async function readReviewSettings(path = settingsPath()): Promise<ReviewSettings> {
  const text = await readFile(path, "utf8").catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!text) return { ...defaultReviewSettings };
  return Value.Parse(settingsSchema, JSON.parse(text));
}

export async function updateReviewSettings(update: Partial<ReviewSettings>, path = settingsPath()): Promise<void> {
  const settings = { ...await readReviewSettings(path), ...update };
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`);
  await rename(temporaryPath, path);
}
