import { Type } from "typebox";
import { Value } from "typebox/value";

const imageConfigSchema = Type.Union([Type.Null(), Type.Object({ os: Type.String(), architecture: Type.String() })]);

// A single-image manifest does not describe its platform; inspect its config
// instead of treating every single-image manifest as a match.
export function registryImageHasPlatforms(ref: string, platforms: string[], inspect: (command: string[]) => string | undefined): boolean {
  const text = inspect(["docker", "buildx", "imagetools", "inspect", ref]);
  if (!text) return false;
  const available = new Set([...text.matchAll(/^\s*Platform:\s*(\S+)/gm)].map((match) => match[1]!));
  if (available.size > 0) return platforms.every((platform) => available.has(platform));
  if (platforms.length !== 1) return false;
  const configText = inspect(["docker", "buildx", "imagetools", "inspect", ref, "--format", "{{json .Image}}"]);
  if (!configText) return false;
  const config = Value.Parse(imageConfigSchema, JSON.parse(configText));
  if (!config) return false;
  return platforms[0] === `${config.os}/${config.architecture}`;
}
