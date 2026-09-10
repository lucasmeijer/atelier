import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSharedImagePreload } from "./shared-preload.ts";

const digest = `sha256:${"a".repeat(64)}`;

test("explicit upstream digests retain their original identity", async () => {
  const sourceRef = `example.com/image@${digest}`;
  const result = await prepareSharedImagePreload({ version: 1, adminSocket: "/unused/admin.sock", snapshotterRoot: "/store", socketDirectory: "/unused", depth: 0, buildServices: { buildkitSocket: "/unused/buildkit.sock", registryAddress: "atelier.tailnet.ts.net:42000" } }, { refs: [sourceRef], images: [{ spec: sourceRef, sourceRef, imageId: digest, aliases: ["local-image:test"] }] });
  expect(result).toHaveLength(1);
  expect(result[0]).toContain(`docker pull '${sourceRef}'`);
  expect(result[0]).toContain(`docker tag '${sourceRef}' 'local-image:test'`);
});

for (const [fail, aliases] of [[false, ["unpublished:latest", "workspace-base:alias"]], [true, ["unpublished:latest"]], [false, []]] as const) {
  test(`direct workspace preload ${fail ? "surfaces pull failures" : aliases.length ? "pulls by digest and installs aliases" : "retains ID-only preloads"}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "preload-direct-"));
    const log = join(dir, "docker.jsonl");
    const image = `atelier/workspaces@${digest}`;
    let requests = 0;
    const registry = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      if (request.method === "HEAD") return new Response(null, { headers: { "docker-content-digest": digest } });
      expect(new URL(request.url).pathname).toBe(`/v2/atelier/workspaces/manifests/${digest}`);
      requests++;
      return new Response("fixture", { status: fail ? 503 : 200 });
    } });
    const address = `127.0.0.1:${registry.port}`;
    try {
      await writeFile(join(dir, "docker"), `#!${process.execPath}
        import { appendFileSync } from 'node:fs';
        const a=process.argv.slice(2);
        if(a[0]==='image' && a[1]==='inspect') {console.log(${JSON.stringify(digest)}); process.exit(0);}
        appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
        if(a[0]==='pull') {
          const [host,...path]=a[1].split('/');
          const response=await fetch('http://'+host+'/v2/'+path.join('/').replace('@','/manifests/'));
          await response.text();
          if(!response.ok)process.exit(9);
        }
      `, { mode: 0o755 });
      const runner = join(dir, "client.ts");
      const sourceRef = aliases[0] ?? digest;
      await writeFile(runner, `
        import {prepareSharedImagePreload} from ${JSON.stringify(import.meta.dir + "/shared-preload.ts")};
        const scripts = await prepareSharedImagePreload({version:1,depth:1,adminSocket:'/unused/admin.sock',snapshotterRoot:'/store',socketDirectory:'/unused',buildServices:{buildkitSocket:'/unused/buildkit.sock',registryAddress:${JSON.stringify(address)}}},
          {refs:[${JSON.stringify(sourceRef)}],images:[{spec:${JSON.stringify(sourceRef)},sourceRef:${JSON.stringify(sourceRef)},imageId:${JSON.stringify(digest)},aliases:${JSON.stringify(aliases)}}]});
        const child = Bun.spawn(['bash','-ec',scripts.join('\\n')],{stdout:'inherit',stderr:'inherit'});
        process.exit(await child.exited);
      `);
      const child = Bun.spawn([process.execPath, runner], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
      expect(requests).toBe(1);
      const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(calls[0]).toEqual(["pull", `${address}/${image}`]);
      if (fail) {
        expect(code).toBe(9);
        expect(calls).toHaveLength(1);
      } else {
        expect(stderr).toBe("");
        expect(code).toBe(0);
        const tags = aliases.length ? aliases : [`atelier-preloaded:${digest.slice(7)}`];
        expect(calls.slice(1)).toEqual([...tags.map(alias => ["tag", calls[0][1], alias]), ["image", "rm", calls[0][1]]]);
      }
    } finally { await registry.stop(true); await rm(dir, { recursive: true }); }
  });
}
