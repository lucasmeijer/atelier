import { homedir, platform } from "node:os";
import { join } from "node:path";

export function defaultDataDir(): string {
  if (process.env.ATELIER_DATA_DIR) return process.env.ATELIER_DATA_DIR;
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "atelier");
  return "/var/lib/atelier";
}
