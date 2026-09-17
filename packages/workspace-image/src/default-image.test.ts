import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const innerAtelier of [false, true]) for (const scenario of ["cached", "missing", "different-signature", "no-cache"] as const) {
  test(`default image resolution: ${scenario}, inner=${innerAtelier}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "default-image-test-"));
    const namespace = directory.split("/").at(-1)!;
    try {
      // Isolate mocks and process-local promises from the rest of the test suite.
      // Use the real default-context generator and the public resolver interface.
      const client = join(directory, "client.ts");
      await writeFile(client, `
        import {mock} from 'bun:test';
        const fs = await import('node:fs');
        mock.module('node:fs', () => ({...fs, existsSync: path => path === '/run/atelier-parent' ? ${innerAtelier} : fs.existsSync(path)}));
        const localPath = ${JSON.stringify(join(import.meta.dir, "local-images.ts"))};
        const local = await import(localPath);
        const checks = [], builds = [];
        mock.module(localPath, () => ({...local, reuseDefaultWorkspaceImage: async tag => {
          checks.push(tag);
          // A different signature must not count as the requested image.
          return ${JSON.stringify(scenario)} === 'different-signature' ? tag === 'atelier-workspace:old-default' : ${scenario === "cached" || scenario === "no-cache"};
        }}));
        const observablePath = ${JSON.stringify(join(import.meta.dir, "../../observable-terminal/src/server/index.ts"))};
        const observable = await import(observablePath);
        mock.module(observablePath, () => ({...observable, runHostObservableCommand: async options => {
          builds.push(options.command);
          return {exitCode:0,output:''};
        }}));
        const {ensureDefaultWorkspaceImage} = await import(${JSON.stringify(join(import.meta.dir, "index.ts"))});
        try {
          const first = await ensureDefaultWorkspaceImage();
          const second = await ensureDefaultWorkspaceImage();
          console.log(JSON.stringify({first,second,checks,builds}));
        } catch (error) {
          console.log(JSON.stringify({error: error.message,checks,builds}));
          process.exitCode = 1;
        }
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
        const result = JSON.parse(stdout);
        if (innerAtelier && (scenario === "missing" || scenario === "different-signature")) {
          expect(code).toBe(1);
          expect(result.checks).toHaveLength(1);
          const signature = result.checks[0].slice("atelier-workspace:".length);
          expect(signature).toMatch(/^[a-f0-9]{16}$/);
          expect(result.error).toBe(`Inner Atelier needs a default workspace image with signature ${signature} but that has not been preloaded. Exiting instead of building this image, so we do not flood the outer atelier with many parallel image builds.`);
          expect(result.builds).toEqual([]);
          continue;
        }
        expect(code).toBe(0);
        expect(result.first).toMatch(/^atelier-workspace:[a-f0-9]{16}$/);
        expect(result.second).toBe(result.first);
        expect(result.checks).toEqual(!innerAtelier && scenario === "no-cache" ? [] : [result.first, result.first]);
        expect(result.builds).toHaveLength(innerAtelier || scenario === "cached" ? 0 : 2);
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
