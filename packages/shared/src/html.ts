export const disclosureIconHtml = '<svg class="disclosure-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>';

export function escapeHtml(value: string | number): string {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "�")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

interface ProgressButtonBase {
  initialHtml: string;
  inProgressHtml: string;
  progress?: number;
  variant: "primary" | "secondary" | "danger";
  type?: "button" | "submit";
  disabled?: boolean;
  id?: string;
}

type ProgressButtonOptions =
  | (ProgressButtonBase & { state: "initial" | "in-progress"; finishHtml?: string })
  | (ProgressButtonBase & { state: "finish"; finishHtml: string });

export function progressButtonHtml(options: ProgressButtonOptions): string {
  const disabled = options.disabled || options.state === "in-progress" ? " disabled" : "";
  const busy = options.state === "in-progress" ? ` aria-busy="true"` : "";
  const finish = options.finishHtml === undefined ? "" : `<span class="progress-button__content" data-progress-content="finish">${options.finishHtml}</span>`;
  return `<button${options.id ? ` id="${escapeHtml(options.id)}"` : ""} class="button ${options.variant} progress-button" type="${options.type ?? "button"}" data-progress-state="${options.state}" style="--button-progress:${options.progress ?? 0}"${disabled}${busy}><svg class="progress-button__perimeter" aria-hidden="true"><rect pathLength="100"/></svg><span class="progress-button__content" data-progress-content="initial">${options.initialHtml}</span><span class="progress-button__content" data-progress-content="in-progress">${options.inProgressHtml}</span>${finish}</button>`;
}
