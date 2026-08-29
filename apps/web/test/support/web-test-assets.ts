import type { Page } from "@playwright/test";
import { parseAssetManifest } from "../../src/server/asset-manifest.ts";

const webRoot = new URL("../../", import.meta.url);
const publicRoot = new URL("public/", webRoot);

export interface WebTestAssets {
  path(logicalPath: string): string;
  serve(page: Page): Promise<void>;
}

/** Builds the browser bundle and exposes its complete module and static-asset graph to fake test origins. */
export async function buildWebTestAssets(): Promise<WebTestAssets> {
  const build = Bun.spawn(["bun", "run", "apps/web/scripts/build-assets.ts"], {
    cwd: new URL("../../../..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
  if (exitCode !== 0) throw new Error(`web test asset build failed:\n${stdout}${stderr}`);

  const manifest = parseAssetManifest(await Bun.file(new URL("assets-manifest.json", publicRoot)).text());

  return {
    path(logicalPath: string): string {
      const publicPath = manifest[logicalPath];
      if (!publicPath) throw new Error(`missing built web test asset: ${logicalPath}`);
      return publicPath;
    },
    async serve(page: Page): Promise<void> {
      await page.route("**/*", async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        const publicPath = manifest[pathname] ?? (pathname.startsWith("/assets/") ? pathname : undefined);
        if (!publicPath) return route.fallback();
        const fileUrl = new URL(`.${publicPath}`, publicRoot);
        return route.fulfill({ path: fileUrl.pathname, contentType: Bun.file(fileUrl).type });
      });
    },
  };
}
