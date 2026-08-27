export const transcriptionComposerController = "transcription-composer";

const microphoneIcon = `<svg class="transcription-microphone" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 12.5a3 3 0 0 0 3-3v-4a3 3 0 0 0-6 0v4a3 3 0 0 0 3 3Zm-5-3a5 5 0 0 0 10 0M10 14.5V18m-3 0h6"/></svg>`;

export function renderTranscriptionComposerControl(): string {
  return `<button class="button secondary icon-only progress-button transcription-button" type="button" title="Dictate" aria-label="Dictate with microphone" aria-pressed="false" data-state="idle" data-progress-state="initial" style="--button-progress:0" data-transcription-composer-target="button" data-action="transcription-composer#toggle">
    <svg class="progress-button__perimeter" aria-hidden="true"><rect pathLength="100"/></svg>
    <span class="progress-button__content" data-progress-content="initial">${microphoneIcon}<canvas data-transcription-composer-target="waveform" aria-hidden="true"></canvas></span>
    <span class="progress-button__content" data-progress-content="in-progress"><i class="activity-spinner" aria-hidden="true"></i></span>
    <span class="transcription-status" data-transcription-composer-target="status" aria-live="polite">Dictate</span>
  </button>`;
}
