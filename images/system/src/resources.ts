import { existsSync } from "node:fs";
import { chown, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
const GiB = 1024 ** 3;
export function resourcePolicy(memory: number, pids: number) {
  if (memory < 3 * GiB)
    throw new Error(
      "Atelier System requires at least 3 GiB effective memory for management and workloads",
    );
  if (pids < 2048)
    throw new Error(
      "Atelier System requires an effective process limit of at least 2048",
    );
  const reserve = Math.min(4 * GiB, Math.max(GiB, Math.ceil(memory * 0.2)));
  const max = Math.floor(memory - reserve);
  return {
    memory: max,
    reserve,
    pids: Math.min(8192, pids - 1024),
  };
}
export async function initializeResources() {
  const membership = await readFile("/proc/self/cgroup", "utf8");
  const relative = membership
    .trim()
    .split("\n")
    .find((line) => line.startsWith("0::"))
    ?.slice(3);
  if (!relative || relative === "/")
    throw new Error(
      "System requires cgroup v2 with --cgroupns=host inside its own container cgroup",
    );
  const root = join("/sys/fs/cgroup", relative);
  const required = ["cpu", "memory", "pids", "io"];
  const available = (await readFile(join(root, "cgroup.controllers"), "utf8"))
    .trim()
    .split(/\s+/);
  for (const name of required)
    if (!available.includes(name))
      throw new Error(`System cgroup controller unavailable: ${name}`);
  const meminfo = await readFile("/proc/meminfo", "utf8");
  let memory = Number(meminfo.match(/^MemTotal:\s+(\d+)/m)![1]) * 1024;
  let pids = Infinity;
  for (let path = root; ; path = dirname(path)) {
    for (const [name, apply] of [
      [
        "memory.max",
        (value: number) => {
          memory = Math.min(memory, value);
        },
      ],
      [
        "pids.max",
        (value: number) => {
          pids = Math.min(pids, value);
        },
      ],
    ] as const) {
      if (path !== "/sys/fs/cgroup") {
        const value = (await readFile(join(path, name), "utf8")).trim();
        if (value !== "max") apply(Number(value));
      }
    }
    if (path === "/sys/fs/cgroup") break;
  }
  const policy = resourcePolicy(memory, pids);
  const management = join(root, "management");
  const workloads = join(root, "workloads");
  const processes = join(management, "processes");
  await mkdir(processes, { recursive: true });
  // docker exec can race bootstrap. Once PID 1 has moved, new execs follow it;
  // drain any exec that started against the old root before enabling controllers.
  const controllers = required.map((name) => `+${name}`).join(" ");
  for (let attempt = 0; ; attempt++) {
    for (const pid of (await readFile(join(root, "cgroup.procs"), "utf8"))
      .trim()
      .split(/\s+/)
      .filter(Boolean)) {
      try {
        await writeFile(join(processes, "cgroup.procs"), pid);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
    try {
      await writeFile(join(root, "cgroup.subtree_control"), controllers);
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EBUSY") || attempt === 49)
        throw error;
      await Bun.sleep(100);
    }
  }
  await writeFile(join(management, "cgroup.subtree_control"), controllers);
  await mkdir(workloads, { recursive: true });
  await writeFile(join(workloads, "cgroup.subtree_control"), controllers);
  for (const [group, weight] of [
    [management, 1000],
    [workloads, 100],
  ] as const) {
    await writeFile(join(group, "cpu.weight"), String(weight));
    // Docker Desktop exposes the io controller without a proportional-I/O
    // scheduler. CPU and memory protection still apply on those kernels.
    if (existsSync(join(group, "io.weight"))) {
      await writeFile(join(group, "io.weight"), `default ${weight}`);
    } else {
      console.info(`I/O weight protection unavailable for ${group}; CPU and memory protection remain enabled`);
    }
  }
  await writeFile(join(management, "memory.low"), String(policy.reserve));
  await writeFile(join(workloads, "memory.max"), String(policy.memory));
  // Throttling this ancestor stalls gateways and workspace initialization too.
  // Keep the hard bound; terminal workloads carry a higher OOM score.
  await writeFile(join(workloads, "memory.high"), "max");
  await writeFile(join(workloads, "memory.swap.max"), "0");
  await writeFile(join(workloads, "pids.max"), String(policy.pids));
  await mkdir(join(workloads, "commands"), { recursive: true });
  // The app runs as uid 1000. cgroup v2 migration requires destination and
  // common-ancestor cgroup.procs permissions; no controller files are delegated.
  await chown(join(root, "cgroup.procs"), 1000, 1000);
  await chown(join(workloads, "commands", "cgroup.procs"), 1000, 1000);
  const result = {
    workloadsCgroupParent: `${relative}/workloads`,
    managementCgroupParent: `${relative}/management/apps`,
    commandsCgroup: join(workloads, "commands"),
    policy,
    effectiveMemory: memory,
  };
  await mkdir("/run/atelier-system", { recursive: true });
  await writeFile("/run/atelier-system/resources.json", JSON.stringify(result));
  const config = JSON.parse(await readFile("/etc/docker/daemon.json", "utf8"));
  config["cgroup-parent"] = result.workloadsCgroupParent;
  config["exec-opts"] = ["native.cgroupdriver=cgroupfs"];
  await writeFile("/run/atelier-system/daemon.json", JSON.stringify(config));
  return result;
}
