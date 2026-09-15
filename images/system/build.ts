import { mkdir } from "node:fs/promises";
import { inlineDesignSystemCss } from "../../packages/design-system/src/inline-styles.ts";
const out = new URL("./.build/", import.meta.url).pathname;
await mkdir(out, { recursive: true });
for (const entry of ["supervisor", "test-app"]) {
  const result = await Bun.build({
    entrypoints: [new URL(`./src/${entry}.ts`, import.meta.url).pathname],
    outdir: out,
    target: "bun",
    naming: "[name].js",
  });
  if (!result.success) throw new AggregateError(result.logs);
}
const client = await Bun.build({
  entrypoints: [new URL("./src/client.ts", import.meta.url).pathname],
  outdir: out,
  target: "browser",
  naming: "client.js",
  minify: true,
});
if (!client.success) throw new AggregateError(client.logs);
await Bun.write(`${out}/design-system.css`, await inlineDesignSystemCss());
