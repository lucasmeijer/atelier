import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultDataDir, isJsonObject } from "@atelier/core";
import { turboStream, turboStreamResponse, type SettingsContribution, type WorkspaceModule } from "@atelier/shared";

const settingsPath = "/settings/keypress-probe";
const settingsSectionId = "settings-sec-keypress-probe";

function keypressProbeSettingsFile(dataDir = defaultDataDir()): string {
  return join(dataDir, "keypress-probe-settings.json");
}

async function isKeypressProbeEnabled(file = keypressProbeSettingsFile()): Promise<boolean> {
  if (!existsSync(file)) return false;
  const settings: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!isJsonObject(settings) || (settings.enabled !== true && settings.enabled !== false)) {
    throw new Error(`Invalid keypress probe settings in ${file}`);
  }
  return settings.enabled;
}

async function setKeypressProbeEnabled(enabled: boolean, file = keypressProbeSettingsFile()): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tempPath = `${file}.tmp`;
  await writeFile(tempPath, `${JSON.stringify({ enabled }, null, 2)}\n`);
  await rename(tempPath, file);
}

function renderKeypressProbe(): string {
  return `<aside class="keypress-probe" data-controller="keypress-probe" aria-live="polite" title="Shows keyboard events Atelier can capture in this browser context; browser/OS/iframe-reserved shortcuts will not appear.">
    <div class="keypress-probe-head"><strong>Keys</strong><span data-keypress-probe-target="count">0</span><button type="button" data-action="keypress-probe#clear" aria-label="Clear captured keys">clear</button></div>
    <ol data-keypress-probe-target="list"><li class="empty">Press keys… browser/iframe-reserved combos will not appear.</li></ol>
  </aside>`;
}

async function renderKeypressProbeSettings(): Promise<string> {
  const enabled = await isKeypressProbeEnabled();
  return `<section class="settings-sec settings-sec-keypress-probe" id="${settingsSectionId}"><h2>Shortcut probe</h2><div class="settings-field"><div><b>Keylogging probe</b><p>Shows a local, visible keyboard-event overlay in workspaces so you can debug why shortcuts are not firing. Events are not stored; browser, OS, and iframe-reserved shortcuts may never reach Atelier.</p></div><form id="settings_keypress_probe" class="toggle" role="group" aria-label="Keylogging probe" method="post" action="${settingsPath}" data-turbo="true"><button class="toggle__option" type="submit" name="enabled" value="false" aria-pressed="${!enabled}">Off</button><button class="toggle__option" type="submit" name="enabled" value="true" aria-pressed="${enabled}">On</button></form></div></section>`;
}

const keypressProbeSettingsContribution: SettingsContribution = {
  id: "keypress-probe",
  label: "Shortcut probe",
  order: 90,
  render: renderKeypressProbeSettings,
  async handleAction({ request, url }) {
    if (url.pathname !== settingsPath || request.method !== "POST") return undefined;
    const form = await request.formData();
    const enabled = form.get("enabled") === "true";
    await setKeypressProbeEnabled(enabled);
    return turboStreamResponse(`${turboStream("replace", settingsSectionId, await renderKeypressProbeSettings())}${turboStream("remove", ".keypress-probe", "", { targets: true })}${enabled ? turboStream("append", ".fixed-workspace-presentation", renderKeypressProbe(), { targets: true }) : ""}`);
  },
};

const keypressProbeStaticFiles = {
  "/keypress-probe.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
} as const;

const keypressProbeWorkspaceModule: WorkspaceModule = {
  id: "keypress-probe",
  staticFiles: keypressProbeStaticFiles,
  settingsContributions: [keypressProbeSettingsContribution],
  async attachToWorkspace() {
    return await isKeypressProbeEnabled() ? { overlayHtml: [renderKeypressProbe()] } : {};
  },
};

export { keypressProbeWorkspaceModule as atelierServerModule };
