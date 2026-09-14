import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProject, getProjectConfiguration } from "../src/project.ts";
import { createProjectRoutes } from "../../../apps/web/src/server/project-routes.ts";

test("project preload API updates future creation settings and rejects malformed requests without mutation", async () => {
  const previous = process.env.ATELIER_DATA_DIR;
  const dir = await mkdtemp(join(tmpdir(), "project-preload-api-"));
  process.env.ATELIER_DATA_DIR = dir;
  try {
    const { project } = await addProject("/tmp/example");
    const routes = createProjectRoutes({
      referencingWorkspaces: () => [],
      refreshWorkspacePaneCollections: async () => "",
      refreshProjectWarnings: async () => { throw new Error("preload changes must not invalidate existing workspaces"); },
      renderLaunchComposer: async () => "",
      createAgentWorkspace: async () => new Response(),
      workspaceCommandModalHostId: "unused",
    });
    const url = new URL(`http://localhost/projects/${project.id}/preload-images`);
    const request = (preloadImages: unknown) => new Request(url, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ preloadImages }),
    });
    const response = await routes.handle(request(["postgres:17"]), url);
    expect(response!.status).toBe(200);
    expect((await response!.json()).project.preloadImages).toEqual(["postgres:17"]);
    for (const invalid of [null, "postgres:17", [42], ["https://registry/image"]]) {
      await expect(routes.handle(request(invalid), url)).rejects.toThrow();
    }
    expect((await getProjectConfiguration(project.id)).preloadImages).toEqual(["postgres:17"]);
  } finally {
    if (previous === undefined) delete process.env.ATELIER_DATA_DIR;
    else process.env.ATELIER_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
