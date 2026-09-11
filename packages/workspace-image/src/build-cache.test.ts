import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const policy = { all: true, filter: null, keepDuration: 0, reservedSpace: 20, maxUsedSpace: 100, minFreeSpace: 50 };
const cases = [
  { name: "totals and effective catch-all target", usage: [{ size: 30, inUse: true }, { size: 60, inUse: false }, { size: -1, inUse: false }], policies: [{ ...policy, all: false, maxUsedSpace: 5 }, policy], expected: { inUseBytes: 30, reclaimableBytes: 60, totalBytes: 90, targetBytes: 100, gcEnabled: true } },
  { name: "empty cache and disabled GC", usage: null, policies: [], expected: { totalBytes: 0, targetBytes: null, gcEnabled: false } },
  { name: "filtered and age-limited rules are not overall targets", usage: [], policies: [{ ...policy, filter: ["type==source.local"] }, { ...policy, keepDuration: 100 }], expected: { targetBytes: null, gcEnabled: true } },
  { name: "reserved space takes precedence", usage: [], policies: [{ ...policy, reservedSpace: 200 }], expected: { targetBytes: 200 } },
  { name: "free-space-only rule has no fixed target", usage: [], policies: [{ ...policy, maxUsedSpace: 0 }], expected: { targetBytes: null } },
  { name: "invalid external measurements fail", usage: [{ size: "30", inUse: true }], policies: [policy], error: true },
  { name: "command failure surfaces stderr", usage: [], policies: [policy], error: true, exit: 7 },
];

for (const scenario of cases) {
  test(`BuildKit storage: ${scenario.name}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "atelier-build-cache-"));
    const log = join(dir, "calls.jsonl");
    try {
      await writeFile(join(dir, "buildctl"), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (${scenario.exit ?? 0}) { console.error('daemon unavailable'); process.exit(${scenario.exit ?? 0}); }
console.log(JSON.stringify(args.includes('du') ? ${JSON.stringify(scenario.usage)} : [{gcPolicy: ${JSON.stringify(scenario.policies)}}]));
`, { mode: 0o755 });
      const script = `
import { readBuildCacheStorage } from ${JSON.stringify(join(import.meta.dir, "build-cache.ts"))};
console.log(JSON.stringify(await readBuildCacheStorage({version:1, depth:0, adminSocket:'/s/admin.sock', socketDirectory:'/s', snapshotterRoot:'/store', buildServices:{buildkitSocket:'/s/buildkit.sock',registryAddress:'atelier-registry.localhost:42000'}})));
`;
      const proc = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      if (scenario.error) {
        expect(code).not.toBe(0);
        if (scenario.exit) expect(stderr).toContain("daemon unavailable");
      } else {
        expect(code).toBe(0);
        const result = JSON.parse(stdout);
        expect(result).toMatchObject(scenario.expected!);
        expect(Number.isNaN(Date.parse(result.measuredAt))).toBe(false);
      }
      const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      if (!scenario.exit) expect(calls).toHaveLength(2);
      expect(calls.length).toBeGreaterThan(0);
      const allowed = [["du"], ["debug", "workers"]].map(args => ["--addr", "unix:///s/buildkit.sock", "--timeout", "30", ...args, "--format", "{{json .}}"]);
      for (const call of calls) expect(allowed).toContainEqual(call);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
