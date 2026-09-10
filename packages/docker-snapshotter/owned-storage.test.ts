import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const filesystem of ["tmpfs", "ramfs", "ext2/ext3", "xfs"]) {
  test(`owned runtime validates ${filesystem} backing before starting services`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "owned-storage-"));
    try {
      const child = Bun.spawn(["bash", "-c", `
        mountpoint() { return 0; }
        stat() { echo '${filesystem}'; }
        flock() { return 1; }
        export -f mountpoint stat flock
        bash "$1" "$2" 1000 false
      `, "test", join(import.meta.dir, "atelier-owned-snapshotter"), directory], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
      expect(code).toBe(1);
      if (filesystem === "tmpfs" || filesystem === "ramfs") {
        expect(stderr).toContain(`requires disk-backed persistent storage, not ${filesystem}`);
        expect(await readdir(directory)).toEqual([]);
      } else {
        expect(stderr).toContain("Docker runtime already owned");
        expect(await readdir(directory)).toEqual(["installation.lock"]);
      }
    } finally { await rm(directory, { recursive: true }); }
  });
}
