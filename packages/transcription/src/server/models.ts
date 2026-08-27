import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atelierDataPath, getAtelierRuntimeContext } from "@atelier/core";
import { Type } from "typebox";
import { Value } from "typebox/value";

export const transcriptionModels = [
  {
    id: "nemotron-3.5", name: "Nemotron 3.5", description: "Multilingual streaming transcription",
    artifact: { repository: "nvidia/nemotron-3.5-asr-streaming-0.6b", revision: "1c8deaecc64b91f034d73e08dd8b64625eb3395d", filename: "nemotron-3.5-asr-streaming-0.6b.q8_0.gguf", size: 741548352 },
  },
  {
    id: "nemotron-en", name: "Nemotron English", description: "English streaming transcription",
    artifact: { repository: "nvidia/nemotron-speech-streaming-en-0.6b", revision: "ebe59e5a817142986528bbbee5dba8db7b38ed50", filename: "nemotron-speech-streaming-en-0.6b.q8_0.gguf", size: 699872960 },
  },
  {
    id: "parakeet-tdt", name: "Parakeet TDT", description: "Fast English transcription",
    artifact: { repository: "nvidia/parakeet-tdt-0.6b-v3", revision: "541d1f99c6b0c3cd0b11a95167540bb8edefd82b", filename: "parakeet-tdt-0.6b-v3.q8_0.gguf", size: 713975456 },
  },
  {
    id: "parakeet-ctc", name: "Parakeet CTC", description: "Larger English transcription model",
    artifact: { repository: "nvidia/parakeet-ctc-1.1b", revision: "20e63a0fed6aedba145b74b826dbd41df0941730", filename: "parakeet-ctc-1.1b.q8_0.gguf", size: 1178100960 },
  },
] as const;

export type TranscriptionModelId = (typeof transcriptionModels)[number]["id"];
export const defaultTranscriptionModel: TranscriptionModelId = "nemotron-3.5";

const settingsSchema = Type.Object({
  model: Type.Union(transcriptionModels.map(({ id }) => Type.Literal(id))),
});

function settingsPath(): string {
  return atelierDataPath(getAtelierRuntimeContext(), "transcription.json");
}

export function isTranscriptionModelId(value: string): value is TranscriptionModelId {
  return transcriptionModels.some((model) => model.id === value);
}

export function transcriptionModel(id: TranscriptionModelId): (typeof transcriptionModels)[number] {
  const model = transcriptionModels.find((candidate) => candidate.id === id);
  if (!model) throw new Error(`unsupported transcription model: ${id}`);
  return model;
}

export async function readTranscriptionModel(): Promise<TranscriptionModelId> {
  const text = await readFile(settingsPath(), "utf8").catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!text) return defaultTranscriptionModel;
  return Value.Parse(settingsSchema, JSON.parse(text)).model;
}

export async function writeTranscriptionModel(model: TranscriptionModelId): Promise<void> {
  const path = settingsPath();
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({ model }, null, 2)}\n`);
  await rename(temporaryPath, path);
}
