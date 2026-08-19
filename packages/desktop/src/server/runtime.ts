import { execWorkspaceCommand, workspaceDesktopPort } from "@atelier/workspace";

export const desktopAppKey = "desktop";
export const desktopDisplay = ":99";

export async function isWorkspaceDesktopEnabled(workspaceId: string): Promise<boolean> {
  try {
    const result = await execWorkspaceCommand(workspaceId, ["sh", "-lc", `test -f /.atelier/desktop/enabled && pgrep -f 'websockify.*${workspaceDesktopPort}' >/dev/null && pgrep -f 'Xvfb ${desktopDisplay}' >/dev/null`]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export async function ensureWorkspaceDesktop(workspaceId: string): Promise<void> {
  const result = await execWorkspaceCommand(workspaceId, ["atelier-start-desktop"], { user: "atelier" });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "could not start workspace desktop");
}
