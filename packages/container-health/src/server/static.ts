export const containerHealthStaticFiles = {
  "/container-health.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
} as const;
