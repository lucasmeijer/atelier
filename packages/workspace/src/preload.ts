import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { requireDocker, workloadCommand } from "@atelier/core";

export interface PreparedImage { requested: string; reference?: string }
type Command = (args: string[]) => Promise<{ stdout: Buffer; stderr: string }>;
async function command(args: string[]) {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${args[0]} ${args[1]} failed: ${stderr.trim()}`);
  return { stdout: Buffer.from(stdout), stderr };
}

export function normalizeImageReference(input: string): string {
  if (!input || /\s|["'\\]/.test(input)) throw new Error(`Invalid image reference: ${input}`);
  let name = input;
  const first = name.split("/")[0]!;
  if (!name.includes("/") || !(first.includes(".") || first.includes(":") || first === "localhost")) name = `docker.io/${name}`;
  if (name.startsWith("docker.io/") && !name.slice(10).includes("/")) name = `docker.io/library/${name.slice(10)}`;
  if (!name.includes("@") && !name.slice(name.lastIndexOf("/") + 1).includes(":")) name += ":latest";
  return name;
}

/** One app owns the shared directory. Image prep is deduplicated; mkfs commands
 * serialize so different manifests sharing a layer cannot replace each other's files. */
export function createImagePreloader(run: Command = command, docker: typeof requireDocker = requireDocker) {
  const resolving = new Map<string, Promise<string>>();
  const preparing = new Map<string, Promise<void>>();
  let cacheQueue = Promise.resolve();
  const ctr = (...args: string[]) => run(["ctr", "--namespace", "moby", ...args]);
  async function resolve(requested: string): Promise<string> {
    const name = normalizeImageReference(requested);
    let task = resolving.get(name);
    if (!task) {
      task = (async () => {
        let listing = await ctr("images", "ls", `name==${name}`);
        if (!listing.stdout.toString().split("\n").some((row) => row.split(/\s+/)[0] === name)) {
          await ctr("content", "fetch", name);
          listing = await ctr("images", "ls", `name==${name}`);
        }
        const row = listing.stdout.toString().split("\n").find((row) => row.split(/\s+/)[0] === name);
        const digest = row?.split(/\s+/)[2];
        if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`containerd did not resolve ${name}`);
        const reference = `${name.split("@")[0]}@${digest}`;
        await ctr("images", "tag", "--force", name, reference);
        return reference;
      })().finally(() => resolving.delete(name));
      resolving.set(name, task);
    }
    return task;
  }
  function prepare(reference: string): Promise<void> {
    let task = preparing.get(reference);
    if (!task) {
      task = cacheQueue.then(async () => { await run(await workloadCommand(["ctr", "--namespace", "moby", "images", "build-erofs-cache", reference, "/data/erofs-cache"])); });
      cacheQueue = task.then(() => {}, () => {});
      preparing.set(reference, task);
      task.catch(() => preparing.delete(reference));
    }
    return task;
  }
  return {
    async snapshot(images: string[], directory: string): Promise<void> {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "preloads.json"), JSON.stringify([...new Set(images)].map((requested) => ({ requested }))));
    },
    async load(directory: string): Promise<PreparedImage[]> {
      const images: PreparedImage[] = JSON.parse(await readFile(join(directory, "preloads.json"), "utf8"));
      for (const image of images) {
        if (image.reference) continue;
        image.reference = await resolve(image.requested);
        const temporary = join(directory, "preloads.json.tmp");
        await writeFile(temporary, JSON.stringify(images));
        await rename(temporary, join(directory, "preloads.json"));
      }
      return images;
    },
    async install(images: PreparedImage[], container: string): Promise<void> {
      if (!images.length) return;
      // containerd is sufficient for importing snapshots; socket activation keeps Docker asleep.
      await docker(["exec", "--user", "root", container, "systemctl", "start", "containerd.service"]);
      for (const image of images) {
        if (!image.reference) throw new Error(`Image has not been resolved: ${image.requested}`);
        await prepare(image.reference);
        const archive = await run(["atelier-image-transfer", "export", image.reference]);
        await docker(["exec", "--user", "root", "-i", container, "atelier-image-transfer", "import"], { stdin: archive.stdout });
      }
    },
  };
}
export const workspaceImagePreloader = createImagePreloader();
