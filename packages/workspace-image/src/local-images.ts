import { runDocker, type CommandResult } from "@atelier/core";

type DockerCommand = (args: string[]) => Promise<CommandResult>;

export async function dockerServerPlatform(docker: DockerCommand = runDocker): Promise<string> {
  const result = await docker(["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"]);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "could not determine Docker server platform");
  return result.stdout.trim();
}

export async function nativeImageExists(ref: string, docker: DockerCommand = runDocker): Promise<boolean> {
  const platform = await dockerServerPlatform(docker);
  const result = await docker(["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", ref]);
  return result.exitCode === 0 && result.stdout.trim() === platform;
}
