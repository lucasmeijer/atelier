import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const scenario of ["cached", "missing", "different-tag", "no-cache"] as const) {
  test(`default image resolution: ${scenario}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "default-image-test-"));
    const namespace = directory.split("/").at(-1)!;
    try {
      // Isolate mocks and process-local promises from the rest of the test suite.
      // Use the real default-context generator and the public resolver interface.
      const client = join(directory, "client.ts");
      await writeFile(client, `
        import {mock} from 'bun:test';
        const localPath = ${JSON.stringify(join(import.meta.dir, "local-images.ts"))};
        const runtimePath = ${JSON.stringify(join(import.meta.dir, "runtime-connection.ts"))};
        const sharedPath = ${JSON.stringify(join(import.meta.dir, "shared-build.ts"))};
        const local = await import(localPath);
        const runtime = await import(runtimePath);
        const shared = await import(sharedPath);
        const checks = [], builds = [];
        let connections = 0;
        mock.module(localPath, () => ({...local, nativeImageExists: async tag => {
          checks.push(tag);
          // A different deterministic tag must not count as the requested image.
          return ${JSON.stringify(scenario)} === 'different-tag' ? tag === 'atelier-workspace:old-default' : ${scenario === "cached" || scenario === "no-cache"};
        }}));
        mock.module(runtimePath, () => ({...runtime, readDockerRuntimeConnection: async () => {
          connections++;
          return {version:1, depth:1, adminSocket:'/unused/admin.sock', socketDirectory:'/unused', snapshotterRoot:'/unused/store', buildServices:{buildkitSocket:'/unused/buildkit.sock',registryAddress:'atelier.tailnet.ts.net:42000'}};
        }}));
        mock.module(sharedPath, () => ({...shared, buildSharedWorkspaceImage: async options => {
          builds.push({kind:options.kind, tag:options.tag, noCache:options.noCache});
          return options.tag;
        }}));
        const {ensureDefaultWorkspaceImage} = await import(${JSON.stringify(join(import.meta.dir, "index.ts"))});
        const first = await ensureDefaultWorkspaceImage();
        const second = await ensureDefaultWorkspaceImage();
        console.log(JSON.stringify({first,second,checks,connections,builds}));
      `);
      // Separate processes model the dev launcher and the server. A cache hit
      // must succeed in both, without contacting shared infrastructure.
      for (let attempt = 0; attempt < (scenario === "cached" ? 2 : 1); attempt++) {
        const child = Bun.spawn([process.execPath, client], {
          env: { ...process.env, ATELIER_NAMESPACE: namespace, ATELIER_WORKSPACE_IMAGE_NO_CACHE: scenario === "no-cache" ? "1" : "0" },
          stdout: "pipe", stderr: "pipe", timeout: 15_000,
        });
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect(stderr).toBe("");
        expect(code).toBe(0);
        const result = JSON.parse(stdout);
        expect(result.first).toMatch(/^atelier-workspace:[a-f0-9]{16}$/);
        expect(result.second).toBe(result.first);
        expect(result.checks).toEqual(scenario === "no-cache" ? [] : [result.first]);
        expect(result.connections).toBe(scenario === "cached" ? 0 : 1);
        expect(result.builds).toEqual(scenario === "cached" ? [] : [{ kind: "default", tag: result.first, noCache: scenario === "no-cache" }]);
      }
    } finally {
      await rm(directory, { recursive: true });
      await rm(join("/tmp/atelier-workspace-image-context", namespace), { recursive: true, force: true });
    }
  });
}
