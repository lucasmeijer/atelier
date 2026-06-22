import type { WorkspaceModule } from "@atelier/shared";

export function renderKeypressProbe(): string {
  return `<aside class="keypress-probe" data-controller="keypress-probe" aria-live="polite" title="Shows keyboard events Atelier can capture in this browser context; browser/OS/iframe-reserved shortcuts will not appear.">
    <div class="keypress-probe-head"><strong>Keys</strong><span data-keypress-probe-target="count">0</span><button type="button" data-action="keypress-probe#clear" aria-label="Clear captured keys">clear</button></div>
    <ol data-keypress-probe-target="list"><li class="empty">Press keys… browser/iframe-reserved combos will not appear.</li></ol>
  </aside>`;
}

export const keypressProbeStaticFiles = {
  "/keypress-probe.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
} as const;

export const keypressProbeWorkspaceModule: WorkspaceModule = {
  id: "keypress-probe",
  staticFiles: keypressProbeStaticFiles,
  attachToWorkspace() {
    return { workspaceChromeHtml: [renderKeypressProbe()] };
  },
};

export { keypressProbeWorkspaceModule as atelierServerModule };
