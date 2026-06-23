import { homedir, platform } from "node:os";
import { isAbsolute, join } from "node:path";

function xdgDataHome(): string {
  const configured = process.env.XDG_DATA_HOME;
  if (configured && isAbsolute(configured)) return configured;
  return join(homedir(), ".local", "share");
}

export function defaultDataDir(): string {
  if (process.env.ATELIER_DATA_DIR) return process.env.ATELIER_DATA_DIR;
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "atelier");
  if (platform() === "linux") return join(xdgDataHome(), "atelier");
  return "/var/lib/atelier";
}
