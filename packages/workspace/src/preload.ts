import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { requireDocker, workloadCommand } from "@atelier/core";
import { ensureDefaultWorkspaceImage } from "@atelier/workspace-image";

export const defaultWorkspacePreload = "atelier:default-workspace";

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
export function createImagePreloader(run: Command = command, docker: typeof requireDocker = requireDocker, cacheDirectory = "/data/erofs-cache", defaultWorkspace: () => Promise<string> = ensureDefaultWorkspaceImage) {
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
      task = cacheQueue.then(async () => {
        const image = await docker(["image", "inspect", reference, "--format", "{{json .RootFS.Layers}}"]);
        const diffIDs: string[] = JSON.parse(image.stdout) ?? [];
        // ctr atomically publishes final cache files but rebuilds them even when
        // present. Readiness after an app restart must reuse a complete cache.
        const present = await Promise.all(diffIDs.map(async (diffID) => {
          const match = /^sha256:([a-f0-9]{64})$/.exec(diffID);
          if (!match) throw new Error(`Unsupported image layer digest: ${diffID}`);
          const hash = match[1]!;
          try {
            const file = await stat(join(cacheDirectory, "sha256", hash.slice(0, 2), `${hash}.erofs`));
            if (!file.isFile() || file.size < 4096) throw new Error(`Invalid cached EROFS layer: ${diffID}`);
            return true;
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
            throw error;
          }
        }));
        if (present.every(Boolean)) return;
        await run(await workloadCommand(["ctr", "--namespace", "moby", "images", "build-erofs-cache", reference, cacheDirectory]));
      });
      cacheQueue = task.then(() => {}, () => {});
      preparing.set(reference, task);
      task.catch(() => preparing.delete(reference));
    }
    return task;
  }
  return {
    async snapshot(images: string[], directory: string): Promise<string | undefined> {
      await mkdir(directory, { recursive: true });
      const prepared: PreparedImage[] = [...new Set(images)].map((requested) => ({ requested }));
      const workspace = prepared.find((image) => image.requested === defaultWorkspacePreload);
      let referenceFile: string | undefined;
      if (workspace) {
        workspace.reference = await resolve(await defaultWorkspace());
        await mkdir(join(directory, "atelier"), { recursive: true });
        referenceFile = join(directory, "atelier", "default-workspace-image");
        await writeFile(referenceFile, `${workspace.reference}\n`);
      }
      await writeFile(join(directory, "preloads.json"), JSON.stringify(prepared));
      return referenceFile;
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
        const imported = await docker(["exec", "--user", "root", "-i", container, "atelier-image-transfer", "import"], { stdin: archive.stdout });
        if (image.requested === defaultWorkspacePreload) {
          // Transfer selects the native manifest from a multi-platform index.
          // FROM must name that installed manifest, not the source index digest.
          const reference = imported.stdout.trim();
          if (!/^[^\s]+@sha256:[a-f0-9]{64}$/.test(reference)) throw new Error("Image transfer did not return an installed image reference");
          await docker(["exec", "--user", "root", "-i", container, "tee", "/etc/atelier/default-workspace-image"], { stdin: `${reference}\n` });
        }
      }
    },
  };
}
export const workspaceImagePreloader = createImagePreloader();
