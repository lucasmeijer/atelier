import { escapeHtml, turboStream, turboStreamResponse, type SettingsContribution } from "@atelier/shared";
import { isTranscriptionModelId, readTranscriptionModel, transcriptionModels, writeTranscriptionModel } from "./models.ts";
import { stopTranscriptionServer } from "./realtime.ts";

const sectionId = "settings-sec-transcription";
const settingsPath = "/settings/transcription-model";

async function renderTranscriptionSettings(): Promise<string> {
  const selected = await readTranscriptionModel();
  const options = transcriptionModels.map((model) =>
    `<option value="${model.id}"${model.id === selected ? " selected" : ""}>${escapeHtml(model.name)} — ${escapeHtml(model.description)}</option>`).join("");
  return `<section class="settings-sec settings-sec-inline" id="${sectionId}">
    <div><h2>Transcription</h2><p class="settings-sub">Choose the server-side CPU model used for microphone dictation. A newly selected model downloads on first use.</p></div>
    <form method="post" action="${settingsPath}" data-turbo="true" data-controller="settings-autosave" data-action="change->settings-autosave#save submit->settings-autosave#submit">
      <select class="settings-select" name="model" aria-label="Transcription model">${options}</select>
    </form>
  </section>`;
}

export const transcriptionSettingsContribution: SettingsContribution = {
  id: "transcription",
  label: "Transcription",
  order: 45,
  render: renderTranscriptionSettings,
  async handleAction({ request, url }) {
    if (url.pathname !== settingsPath || request.method !== "POST") return undefined;
    const model = String((await request.formData()).get("model") ?? "");
    if (!isTranscriptionModelId(model)) throw new Error(`unsupported transcription model: ${model}`);
    const changed = model !== await readTranscriptionModel();
    await writeTranscriptionModel(model);
    if (changed) await stopTranscriptionServer();
    return turboStreamResponse(turboStream("replace", sectionId, await renderTranscriptionSettings()));
  },
};
