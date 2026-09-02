import type { WorkspaceClientModule } from "@atelier/shared";
import { createTranscriptionComposerController } from "./transcription-controller.ts";
import { SharedMicrophone } from "./microphone.ts";

const sharedMicrophone = new SharedMicrophone();
const transcriptionButtonSelector = '[data-transcription-composer-target="button"]';

function activeTranscriptionButton(): HTMLButtonElement | null {
  const dialogButton = document.querySelector<HTMLButtonElement>(`dialog[open] ${transcriptionButtonSelector}`);
  if (dialogButton) return dialogButton;
  const activeAgentButton = document.querySelector<HTMLButtonElement>(`.workspace-detail-resident.visible [data-workspace-logically-visible="true"] ${transcriptionButtonSelector}`);
  if (activeAgentButton) return activeAgentButton;
  return [...document.querySelectorAll<HTMLButtonElement>(transcriptionButtonSelector)]
    .find((button) => button.getClientRects().length > 0) ?? null;
}

export const atelierClientModule: WorkspaceClientModule = {
  id: "transcription",
  install({ application, Controller, hooks }) {
    application.register("transcription-composer", createTranscriptionComposerController(Controller, sharedMicrophone));
    hooks.registerCommand({
      id: "transcription.toggle",
      label: "Start or stop transcription",
      description: "Toggle microphone dictation in the active Composer.",
      scope: "agent-conversation",
      binding: "Meta+Alt+Backslash",
      run: () => activeTranscriptionButton()?.click(),
    });
  },
};
