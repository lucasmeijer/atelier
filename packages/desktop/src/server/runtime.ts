import { execWorkspaceCommand, type WorkspaceExecResult } from "@atelier/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const desktopStatusSchema = Type.Union([
  Type.Object({ phase: Type.Literal("running"), pid: Type.Number(), display: Type.String(), xauthority: Type.String(), cdpUrl: Type.String(), width: Type.Number(), height: Type.Number() }),
  Type.Object({ phase: Type.Literal("starting") }),
  Type.Object({ phase: Type.Literal("stopped") }),
  Type.Object({ phase: Type.Literal("failed"), error: Type.String() }),
]);
export type DesktopStatus = Static<typeof desktopStatusSchema>;
export type RunningDesktop = Extract<DesktopStatus, { phase: "running" }>;

export function createDesktopRuntime(exec: (workspaceId: string, command: string[]) => Promise<WorkspaceExecResult>) {
  async function invoke(workspaceId: string, command: "start" | "status"): Promise<DesktopStatus> {
    const result = await exec(workspaceId, ["atelier-desktop", command]);
    if (result.exitCode === 127) {
      throw new Error(`Desktop runtime unavailable. Recreate this workspace with the current workspace image. ${result.stderr.trim() || result.stdout.trim()}`.trim());
    }
    if (result.exitCode !== 0 && !result.stdout.trim().startsWith("{")) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || "Desktop runtime unavailable.");
    }
    const status = Value.Parse(desktopStatusSchema, JSON.parse(result.stdout));
    if (result.exitCode !== 0 && status.phase !== "failed") throw new Error(`Desktop ${command} failed: ${result.stderr}`);
    return status;
  }
  return {
    async start(workspaceId: string): Promise<RunningDesktop> {
      const status = await invoke(workspaceId, "start");
      if (status.phase !== "running") throw new Error(status.phase === "failed" ? status.error : `Desktop did not start: ${status.phase}`);
      return status;
    },
    status: (workspaceId: string) => invoke(workspaceId, "status"),
  };
}

export const desktopRuntime = createDesktopRuntime(execWorkspaceCommand);
