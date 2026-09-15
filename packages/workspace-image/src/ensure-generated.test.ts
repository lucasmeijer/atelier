import { expect, test } from "bun:test";
import { ensureGeneratedDefaultWorkspaceImage, prepareDefaultWorkspaceImage } from "./default-image.ts";

test("one context supports local reuse, missing-image rebuild and publication identity", async () => {
  const context = await prepareDefaultWorkspaceImage();
  let builds = 0;
  const images = new Set<string>();
  const options = {
    context,
    exists: async (image: string) => images.has(image),
    build: async (_context: typeof context, image: string) => { builds++; images.add(image); },
  };
  try {
    const first = await ensureGeneratedDefaultWorkspaceImage(options);
    expect(first).toBe(context.metadata.tag);
    expect(await ensureGeneratedDefaultWorkspaceImage(options)).toBe(first);
    expect(builds).toBe(1);
    images.delete(first);
    await ensureGeneratedDefaultWorkspaceImage(options);
    expect(builds).toBe(2);
    const published = await ensureGeneratedDefaultWorkspaceImage({ ...options, imageName: tag => tag.replace("atelier-workspace:", "ghcr.io/example/workspace:") });
    expect(published.split(":").at(-1)).toBe(first.split(":").at(-1));
    expect(builds).toBe(3);
  } finally { await context.dispose(); }
});
