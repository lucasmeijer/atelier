import type { StaticFileContribution } from "@atelier/shared";
import { designSystemStaticFiles } from "./assets.ts";

/** Self-contained CSS for documents on foreign origins (for example proxy errors).
 * Resolves the same package stylesheet and font, without another visual theme or
 * requiring that the document's origin serve Atelier assets.
 */
export async function inlineDesignSystemCss(): Promise<string> {
  const assets: Record<string, StaticFileContribution> =
    designSystemStaticFiles;
  let css = await Bun.file(assets["/design-system.css"]!.url).text();
  for (const [match, path] of css.matchAll(/@import "([^"]+)";/g)) {
    css = css.replace(match, await Bun.file(assets[path!]!.url).text());
  }
  for (const [match, path] of css.matchAll(/url\("(\/fonts\/[^\"]+)"\)/g)) {
    const font = Buffer.from(
      await Bun.file(assets[path!]!.url).arrayBuffer(),
    ).toString("base64");
    css = css.replace(match, `url("data:font/woff2;base64,${font}")`);
  }
  return css;
}
