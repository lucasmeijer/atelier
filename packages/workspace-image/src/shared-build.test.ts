import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSharedWorkspaceImage } from "./shared-build.ts";

const baseDigest = `sha256:${"a".repeat(64)}`;
const builtId = `sha256:${"c".repeat(64)}`;
const imageDigest = `sha256:${"b".repeat(64)}`;

test("shared builds require the declared registry transport", async () => {
  await expect(buildSharedWorkspaceImage({ kind: "repository", connection: { version: 1, adminSocket: "/s/admin.sock", socketDirectory: "/s", snapshotterRoot: "/store", depth: 1 }, sourcePath: "/context", dockerfile: "/Dockerfile", originalDockerfile: "/Dockerfile", baseImage: "base", tag: "result" })).rejects.toThrow("lacks registry transport");
});

for (const depth of [0, 1]) test(`build client at depth ${depth} publishes and reuses images through the registry`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "shared-build-test-"));
  let published = false;
  let indexed = false;
  let uploads = 0;
  let pulls = 0;
  const registry = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method === "PUT") {
      if (path.startsWith("/v2/atelier/workspaces/")) indexed = true;
      else { published = true; uploads++; }
      return new Response(null, { status: 201 });
    }
    if (request.method === "HEAD") {
      expect(request.headers.get("accept")).toContain("application/vnd.oci.image.index.v1+json");
      const built = path.endsWith(`image-${builtId.slice(7)}`);
      const found = built ? indexed : path.includes("/atelier/bases/") && published;
      return new Response(null, { status: found ? 200 : 404, headers: { "docker-content-digest": built ? imageDigest : baseDigest } });
    }
    expect(path).toBe(`/v2/atelier/workspaces/manifests/${imageDigest}`);
    if (request.headers.has("x-fixture-docker")) pulls++;
    return new Response("fixture manifest", { headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" } });
  } });
  const address = `127.0.0.1:${registry.port}`;
  try {
    await mkdir(join(dir, "context"));
    await writeFile(join(dir, "context/Dockerfile"), "FROM atelier-workspace\nCOPY value /value\n");
    await writeFile(join(dir, "context/.dockerignore"), "default-ignore\n");
    await writeFile(join(dir, "context/Dockerfile.dockerignore"), "specific-ignore\n");
    await writeFile(join(dir, "docker"), `#!${process.execPath}
      const a = process.argv.slice(2);
      if ((a[0] === "push" || a[0] === "pull") && !a[1].startsWith(${JSON.stringify(address)} + "/")) throw Error("wrong creator registry endpoint");
      if (a[0] === 'version') console.log('linux/amd64');
      if (a[0] === 'image' && a[1] === 'inspect') console.log(a.at(-1)==='unpublished-base'?${JSON.stringify(baseDigest)}:${JSON.stringify(builtId)});
      if (a[0] === 'push' || a[0] === 'pull') {
        const [host, ...parts] = a[1].split('/');
        const path = a[0] === 'push' ? parts.join('/').replace(':image','/manifests/image') : parts.join('/').replace('@','/manifests/');
        const response = await fetch('http://'+host+'/v2/'+path, {headers:{'x-fixture-docker':'1'},method:a[0]==='push'?'PUT':'GET',body:a[0]==='push'?'fixture':undefined});
        if(!response.ok) throw Error('registry request failed');
        await response.text();
      }
    `, { mode: 0o755 });
    await writeFile(join(dir, "buildctl"), `#!${process.execPath}
      import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
      const a = process.argv.slice(2);
      const dockerfile = a.find(v=>v.startsWith('dockerfile=')).slice(11);
      appendFileSync(${JSON.stringify(join(dir, "builds.jsonl"))},JSON.stringify({args:a,ignore:readFileSync(dockerfile+'/Dockerfile.dockerignore','utf8')})+'\\n');
      writeFileSync(a[a.indexOf('--metadata-file')+1],JSON.stringify({'containerimage.digest':${JSON.stringify(imageDigest)}}));
    `, { mode: 0o755 });
    await writeFile(join(dir, "client.ts"), `
      import {buildSharedWorkspaceImage,publishSharedImage} from ${JSON.stringify(import.meta.dir + "/shared-build.ts")};
      const options = {kind:"repository" as const,connection:{version:1,adminSocket:${JSON.stringify(join(dir, "admin.sock"))},snapshotterRoot:'/store',socketDirectory:${JSON.stringify(dir)},depth:${depth},buildServices:{registryAddress:${JSON.stringify(address)},buildkitSocket:'/s/buildkit.sock'}},sourcePath:${JSON.stringify(join(dir, "context"))},dockerfile:${JSON.stringify(join(dir, "context/Dockerfile"))},originalDockerfile:${JSON.stringify(join(dir, "context/Dockerfile"))},baseImage:'unpublished-base',tag:'fixture-result'};
      await Promise.all([publishSharedImage(options.connection,"unpublished-base"),publishSharedImage(options.connection,"unpublished-base")]);
      for(let i=0;i<2;i++) { if(i===1) await import("node:fs/promises").then(fs=>fs.unlink(options.originalDockerfile+".dockerignore")); console.log(await buildSharedWorkspaceImage(options)); }
      console.log(await buildSharedWorkspaceImage({...options,kind:"default"}));
      console.log(await publishSharedImage(options.connection,"cached-result"));
    `);
    const child = Bun.spawn([Bun.which("bun")!, join(dir, "client.ts")], { env: { ...Bun.env, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1", PATH: `${dir}:${Bun.env.PATH}` }, stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout.trim().split("\n")).toEqual([`atelier-workspace:${imageDigest.slice(7)}`, `atelier-workspace:${imageDigest.slice(7)}`, `atelier-workspace:${imageDigest.slice(7)}`, `atelier/workspaces@${imageDigest}`]);
    const builds = (await readFile(join(dir, "builds.jsonl"), "utf8")).trim().split("\n");
    expect(builds).toHaveLength(3);
    for (const [index, build] of builds.entries()) {
      expect(JSON.parse(build).ignore).toBe(index === 0 ? "specific-ignore\n" : "default-ignore\n");
      const binding = `context:atelier-workspace=docker-image://${address}/atelier/bases/${baseDigest.slice(7)}@${baseDigest}`;
      expect(JSON.parse(build).args.includes(binding)).toBe(index < 2);
      expect(JSON.parse(build).args).toContain(`label:com.atelier.workspace-image.kind=${index < 2 ? "repository" : "default"}`);
      expect(JSON.parse(build).args).toContain(`type=image,name=${address}/atelier/workspaces,push=true,push-by-digest=true`);
    }
    expect(uploads).toBe(1);
    expect(pulls).toBe(3);
  } finally { await registry.stop(true); await rm(dir, { recursive: true }); }
});
