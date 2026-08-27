import type { WorkspaceModule } from "@atelier/shared";
import { createTranscriptionSocketSession } from "./realtime.ts";
import { transcriptionSettingsContribution } from "./settings.ts";

const transcriptionStaticFiles = {
  "/transcription.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
} as const;

export const atelierServerModule: WorkspaceModule = {
  id: "transcription",
  staticFiles: transcriptionStaticFiles,
  settingsContributions: [transcriptionSettingsContribution],
  initialize(context) {
    context.registerSocketHandler(createTranscriptionSocketSession);
  },
};

export { renderTranscriptionComposerControl, transcriptionComposerController } from "./composer.ts";
