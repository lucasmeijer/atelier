export function escapeHtml(value: string | number): string {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "�")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}


interface ActivityButtonOptions {
  initialHtml: string;
  activeHtml: string;
  state: "initial" | "active";
  variant: "primary" | "secondary" | "danger";
  type?: "button" | "submit";
  disabled?: boolean;
  id?: string;
}

/** An indeterminate long-running action which remains available to cancel while active. */
export function activityButtonHtml(options: ActivityButtonOptions): string {
  const disabled = options.disabled ? " disabled" : "";
  const busy = options.state === "active" ? ` aria-busy="true"` : "";
  return `<button${options.id ? ` id="${escapeHtml(options.id)}"` : ""} class="button ${options.variant} activity-button" type="${options.type ?? "button"}" data-activity-state="${options.state}"${disabled}${busy}><svg class="activity-button__indicator" aria-hidden="true"><rect pathLength="100"/></svg><span class="activity-button__content" data-activity-content="initial">${options.initialHtml}</span><span class="activity-button__content" data-activity-content="active">${options.activeHtml}</span></button>`;
}
