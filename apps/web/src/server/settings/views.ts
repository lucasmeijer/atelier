import { providerBrandColor, providerBrandIconHtml } from "@atelier/shared";

export type SettingsSurface = "settings" | "onboarding";

export function providerIcon(provider: string, label = provider, className = "settings-provider-icon"): string {
  return `<div class="${className}" style="--provider-color:${providerBrandColor(provider)}">${providerBrandIconHtml(provider, label)}</div>`;
}
