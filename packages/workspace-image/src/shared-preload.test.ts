import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSharedImagePreload } from "./shared-preload.ts";

const digest = `sha256:${"a".repeat(64)}`;

test("explicit upstream digests retain their original identity", async () => {
  const sourceRef = `example.com/image@${digest}`;
  const result = await prepareSharedImagePreload({ version: 1, adminSocket: "/unused/admin.sock", snapshotterRoot: "/store", socketDirectory: "/unused", depth: 0, buildServices: { buildkitSocket: "/unused/buildkit.sock", registrySocket: "/unused/registry.sock" } }, { refs: [sourceRef], images: [{ spec: sourceRef, sourceRef, imageId: digest, aliases: ["local-image:test"] }] });
  expect(result.initScripts).toHaveLength(1);
  expect(result.initScripts[0]).toContain(`docker pull '${sourceRef}'`);
  expect(result.initScripts[0]).toContain(`docker tag '${sourceRef}' 'local-image:test'`);
});

for (const [fail, aliases] of [[false, ["unpublished:latest", "workspace-base:alias"]], [true, ["unpublished:latest"]], [false, []]] as const) {
  test(`workspace preload runner ${fail ? "surfaces pull failures" : aliases.length ? "pulls by digest and installs aliases" : "retains ID-only preloads"}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "preload-runner-"));
    const socket = join(dir, "registry.sock");
    const log = join(dir, "docker.jsonl");
    const image = `atelier/bases/${"b".repeat(64)}@${digest}`;
    let requests = 0;
    const registry = Bun.serve({ unix: socket, fetch(request) {
      expect(new URL(request.url).pathname).toBe(`/v2/atelier/bases/${"b".repeat(64)}/manifests/${digest}`);
      requests++;
      return new Response("fixture", { status: fail ? 503 : 200 });
    } });
    try {
      await writeFile(join(dir, "docker"), `#!${process.execPath}
        import { appendFileSync } from 'node:fs';
        const a=process.argv.slice(2);
        appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
        if(a[0]==='pull') {
          const [host,...path]=a[1].split('/');
          const response=await fetch('http://'+host+'/v2/'+path.join('/').replace('@','/manifests/'));
          await response.text();
          if(!response.ok)process.exit(9);
        }
      `, { mode: 0o755 });
      // Copy the runner away from the package: it must work without node_modules.
      const runner = join(dir, "runner.ts");
      await writeFile(runner, await readFile(join(import.meta.dir, "registry-relay.ts")));
      const child = Bun.spawn([process.execPath, runner, socket, image, ...aliases], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
      expect(requests).toBe(1);
      const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(calls[0][0]).toBe("pull");
      expect(calls[0][1]).toEndWith(`/${image}`);
      if (fail) {
        expect(code).not.toBe(0);
        expect(stderr).toContain("Docker preload pull failed with exit code 9");
        expect(calls).toHaveLength(1);
      } else {
        expect(code).toBe(0);
        const tags = aliases.length ? aliases : [`atelier-preloaded:${digest.slice(7)}`];
        expect(calls.slice(1)).toEqual([...tags.map(alias => ["tag", calls[0][1], alias]), ["image", "rm", calls[0][1]]]);
      }
    } finally { await registry.stop(true); await rm(dir, { recursive: true }); }
  });
}
