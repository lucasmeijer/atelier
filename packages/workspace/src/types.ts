import type { AgentWorkspaceParameters } from "@atelier/shared";

export interface WorkspaceCreationForkContext {
  sourceWorkspaceId: string;
}

export interface WorkspaceCreationContext extends Record<string, unknown> {
  agent?: AgentWorkspaceParameters;
  fork?: WorkspaceCreationForkContext;
}

export interface WorkspaceInitInstructionMap {}

export type WorkspaceInitInstruction = WorkspaceInitInstructionMap[keyof WorkspaceInitInstructionMap];

export interface WorkspaceDockerMount {
  type: "bind" | "volume";
  source: string;
  target: string;
  readonly?: boolean;
}

export interface WorkspaceDockerContainerFile {
  source: string;
  target: string;
}

export interface WorkspaceDockerPlan {
  image?: string;
  labels: Record<string, string>;
  env: Record<string, string>;
  mounts: WorkspaceDockerMount[];
  publishes: number[];
  extraArgs: string[];
  initScripts: string[];
  containerFiles: WorkspaceDockerContainerFile[];
  cleanup: Array<() => Promise<void> | void>;
}
