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
        const local = await import(localPath);
        const checks = [], builds = [];
        mock.module(localPath, () => ({...local, nativeImageExists: async tag => {
          checks.push(tag);
          // A different deterministic tag must not count as the requested image.
          return ${JSON.stringify(scenario)} === 'different-tag' ? tag === 'atelier-workspace:old-default' : ${scenario === "cached" || scenario === "no-cache"};
        }}));
        const observablePath = ${JSON.stringify(join(import.meta.dir, "../../observable-terminal/src/server/index.ts"))};
        const observable = await import(observablePath);
        mock.module(observablePath, () => ({...observable, runHostObservableCommand: async options => {
          builds.push(options.command);
          return {exitCode:0,output:''};
        }}));
        const {ensureDefaultWorkspaceImage} = await import(${JSON.stringify(join(import.meta.dir, "index.ts"))});
        const first = await ensureDefaultWorkspaceImage();
        const second = await ensureDefaultWorkspaceImage();
        console.log(JSON.stringify({first,second,checks,builds}));
      `);
      // Separate processes model the dev launcher and the server. A cache hit
      // must succeed in both, without starting an image build.
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
        expect(result.checks).toEqual(scenario === "no-cache" ? [] : [result.first, result.first]);
        expect(result.builds).toHaveLength(scenario === "cached" ? 0 : 2);
        for (const command of result.builds) {
          expect(command).toContain("docker");
          expect(command).toContain(result.first);
          expect(command.includes("--no-cache")).toBe(scenario === "no-cache");
        }
      }
    } finally {
      await rm(directory, { recursive: true });
      await rm(join("/tmp/atelier-workspace-image-context", namespace), { recursive: true, force: true });
    }
  });
}
