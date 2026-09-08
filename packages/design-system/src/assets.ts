import type { StaticFileContribution } from "@atelier/shared";

/** Mount these logical URLs; the host may fingerprint them and rewrite CSS imports. */
export const designSystemStaticFiles = {
  "/text-entry.css": {
    url: new URL("./text-entry/text-entry.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/managed-list.css": {
    url: new URL("./managed-list/managed-list.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/markdown.css": {
    url: new URL("./markdown/markdown.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/status.css": {
    url: new URL("./status/status.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/design-system-catalogue.css": {
    url: new URL("../catalogue/catalogue.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/design-system.css": {
    url: new URL("./design-system.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/action-item.css": {
    url: new URL("./action-item/action-item.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/autocomplete.css": {
    url: new URL("./autocomplete/autocomplete.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/activity-button.css": {
    url: new URL("./activity-button/activity-button.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/button.css": {
    url: new URL("./button/button.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/button-group.css": {
    url: new URL("./button-group/button-group.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/copy-button.css": {
    url: new URL("./copy-button/copy-button.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/destructive-confirmation.css": {
    url: new URL(
      "./destructive-confirmation/destructive-confirmation.css",
      import.meta.url,
    ),
    contentType: "text/css; charset=utf-8",
  },
  "/dialog.css": {
    url: new URL("./dialog/dialog.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/floating-surface.css": {
    url: new URL("./floating-surface/floating-surface.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/icons.css": {
    url: new URL("./icons/icons.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/panel.css": {
    url: new URL("./panel/panel.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/popup.css": {
    url: new URL("./popup/popup.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/perimeter-button.css": {
    url: new URL("./perimeter-button/perimeter-button.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/progress-button.css": {
    url: new URL("./progress-button/progress-button.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/transient-feedback.css": {
    url: new URL(
      "./transient-feedback/transient-feedback.css",
      import.meta.url,
    ),
    contentType: "text/css; charset=utf-8",
  },
  "/toggle.css": {
    url: new URL("./toggle/toggle.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/fonts/jetbrains-mono-latin-400-normal.woff2": {
    url: new URL(
      import.meta
        .resolve("@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2"),
    ),
    contentType: "font/woff2",
  },
} satisfies Record<string, StaticFileContribution>;
