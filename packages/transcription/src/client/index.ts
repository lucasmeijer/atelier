import type { WorkspaceClientModule } from "@atelier/shared";
import { createTranscriptionComposerController } from "./transcription-controller.ts";

export const atelierClientModule: WorkspaceClientModule = {
  id: "transcription",
  install({ application, Controller }) {
    application.register("transcription-composer", createTranscriptionComposerController(Controller));
  },
};
