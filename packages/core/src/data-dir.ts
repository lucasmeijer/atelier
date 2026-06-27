import { homedir, platform } from "node:os";
import { isAbsolute, join } from "node:path";

function xdgDataHome(): string {
  const configured = process.env.XDG_DATA_HOME;
  if (configured && isAbsolute(configured)) return configured;
  return join(homedir(), ".local", "share");
}

export function defaultDataDir(): string {
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "atelier-host");
  if (platform() === "linux") return join(xdgDataHome(), "atelier-host");
  return "/var/lib/atelier-host";
}
