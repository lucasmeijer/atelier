import { runDocker, type CommandResult } from "@atelier/core";

type DockerCommand = (args: string[]) => Promise<CommandResult>;

export async function dockerServerPlatform(docker: DockerCommand = runDocker): Promise<string> {
  const result = await docker(["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"]);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "could not determine Docker server platform");
  return result.stdout.trim();
}

export async function imageHasPlatforms(ref: string, platforms: string[], docker: DockerCommand = runDocker): Promise<boolean> {
  const result = await docker(["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", ref]);
  return result.exitCode === 0 && platforms.every(platform => platform === result.stdout.trim());
}

export async function nativeImageExists(ref: string, docker: DockerCommand = runDocker): Promise<boolean> {
  return imageHasPlatforms(ref, [await dockerServerPlatform(docker)], docker);
}

/** Discover default images by their embedded signature, independent of the name
 * used to preload them. Restore our local alias for downstream Docker builds. */
export async function reuseDefaultWorkspaceImage(tag: string, docker: DockerCommand = runDocker): Promise<boolean> {
  const signature = tag.slice("atelier-workspace:".length);
  const platform = await dockerServerPlatform(docker);
  const listing = await docker(["image", "ls", "--all", "--quiet", "--no-trunc", "--filter", `label=com.atelier.workspace-image.signature=${signature}`]);
  if (listing.exitCode !== 0) throw new Error(listing.stderr.trim() || "could not list default workspace images");
  const images = new Set(listing.stdout.split(/\s+/).filter(Boolean));
  for (const image of images) {
    const inspected = await docker(["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", image]);
    if (inspected.exitCode !== 0) throw new Error(inspected.stderr.trim() || `could not inspect ${image}`);
    if (inspected.stdout.trim() !== platform) continue;
    const tagged = await docker(["tag", image, tag]);
    if (tagged.exitCode !== 0) throw new Error(tagged.stderr.trim() || `could not tag ${image} as ${tag}`);
    return true;
  }
  return false;
}
