import { atelierDataPath, getAtelierRuntimeContext } from "@atelier/core";
import type { WorkspaceServerSocketHandler, WorkspaceSocketConnection } from "@atelier/shared";
import { mkdir, stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { readTranscriptionModel, transcriptionModel, type TranscriptionModelId } from "./models.ts";

const transcriptionPort = 8098;
const transcriptionReadyUrl = `http://127.0.0.1:${transcriptionPort}/ready`;
const transcriptionSocketUrl = `ws://127.0.0.1:${transcriptionPort}/v1/realtime`;
let transcriptionServer: Promise<void> | undefined;
let transcriptionProcess: ReturnType<typeof Bun.spawn> | undefined;

async function isTranscriptionServerReady(): Promise<boolean> {
  try {
    return (await fetch(transcriptionReadyUrl)).ok;
  } catch {
    return false;
  }
}

function transcriptionCacheDir(): string {
  return atelierDataPath(getAtelierRuntimeContext(), "transcription-cache");
}

async function artifactProgress(modelId: TranscriptionModelId): Promise<number> {
  const { artifact } = transcriptionModel(modelId);
  const path = join(transcriptionCacheDir(), "nemo-speech", "models", artifact.repository, artifact.revision, artifact.filename);
  const size = await stat(path).then((file) => file.size).catch(async (error) => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return await stat(`${path}.partial`).then((file) => file.size).catch((partialError) => {
      if (partialError instanceof Error && "code" in partialError && partialError.code === "ENOENT") return 0;
      throw partialError;
    });
  });
  return Math.min(100, Math.floor(size / artifact.size * 100));
}

async function startTranscriptionServer(model: TranscriptionModelId): Promise<void> {
  if (await isTranscriptionServerReady()) return;

  const executable = Bun.which("nemo-speech");
  if (!executable) throw new Error("The server image does not include the NeMo Speech CPU runtime");

  const cacheDir = transcriptionCacheDir();
  await mkdir(cacheDir, { recursive: true });
  const child = Bun.spawn([
    executable,
    "serve",
    "--host", "127.0.0.1",
    "--port", String(transcriptionPort),
    "--threads", String(Math.max(2, Math.min(8, availableParallelism()))),
    "--asr-model", model,
    "--device", "cpu",
    "--no-ui",
  ], {
    env: { ...process.env, XDG_CACHE_HOME: cacheDir },
    stdout: "inherit",
    stderr: "inherit",
  });
  transcriptionProcess = child;

  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    if (await isTranscriptionServerReady()) return;
    if (child.exitCode !== null) throw new Error(`NeMo Speech exited with code ${child.exitCode}`);
    await Bun.sleep(500);
  }
  child.kill();
  throw new Error("NeMo Speech did not become ready within ten minutes");
}

export async function stopTranscriptionServer(): Promise<void> {
  const process = transcriptionProcess;
  transcriptionProcess = undefined;
  transcriptionServer = undefined;
  if (!process || process.exitCode !== null) return;
  process.kill();
  await process.exited;
}

function ensureTranscriptionServer(model: TranscriptionModelId): Promise<void> {
  transcriptionServer ??= startTranscriptionServer(model).catch((error) => {
    transcriptionServer = undefined;
    throw error;
  });
  return transcriptionServer;
}

function status(socket: WorkspaceSocketConnection, state: "loading" | "error", message: string, progress?: number): void {
  socket.send(JSON.stringify({ type: "atelier.transcription.status", status: state, message, progress }));
}

export const createTranscriptionSocketSession: WorkspaceServerSocketHandler = (url) => {
  if (url.pathname !== "/transcription/realtime") return undefined;

  let browser: WorkspaceSocketConnection | undefined;
  let upstream: WebSocket | undefined;

  async function connect(): Promise<void> {
    let progressTimer: ReturnType<typeof setInterval> | undefined;
    try {
      const modelId = await readTranscriptionModel();
      const model = transcriptionModel(modelId);
      let reportedProgress = -1;
      const reportProgress = async () => {
        if (!browser) return;
        const progress = await artifactProgress(modelId);
        if (progress === reportedProgress) return;
        reportedProgress = progress;
        const message = progress < 100 ? `Downloading ${model.name} · ${progress}%` : `Loading ${model.name}…`;
        status(browser, "loading", message, progress);
      };
      await reportProgress();
      progressTimer = setInterval(() => void reportProgress(), 250);
      await ensureTranscriptionServer(modelId);
      if (!browser) return;
      upstream = new WebSocket(transcriptionSocketUrl);
      upstream.addEventListener("message", (event) => browser?.send(String(event.data)));
      upstream.addEventListener("error", () => {
        if (browser) status(browser, "error", "The CPU transcription service disconnected");
      });
      upstream.addEventListener("close", () => browser?.close());
    } catch (error) {
      if (!browser) return;
      status(browser, "error", error instanceof Error ? error.message : String(error));
      browser.close(1011, "transcription service unavailable");
    } finally {
      if (progressTimer) clearInterval(progressTimer);
    }
  }

  return {
    open(socket) {
      browser = socket;
      status(socket, "loading", "Preparing the CPU transcription model…", 0);
      void connect();
    },
    message(_socket, message) {
      if (upstream?.readyState !== WebSocket.OPEN) throw new Error("Audio arrived before the transcription server was ready");
      upstream.send(message instanceof Uint8Array ? new Uint8Array(message).buffer : message);
    },
    close() {
      upstream?.close();
      browser = undefined;
    },
  };
};
