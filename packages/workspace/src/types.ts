import type { SharedDockerRuntime } from "./shared-docker.ts";
export type { WorkspaceCreationContext } from "@atelier/shared";

export interface WorkspaceInitInstructionMap {}

export type WorkspaceInitInstruction = WorkspaceInitInstructionMap[keyof WorkspaceInitInstructionMap];

export type WorkspaceDockerMount = ({ type: "bind"; source: string } | { type: "volume"; source?: string }) & {
  target: string;
  readonly?: boolean;
};

export interface WorkspaceDockerContainerFile {
  source: string;
  target: string;
}

export interface WorkspaceDockerPlan {
  image?: string;
  sharedDocker?: SharedDockerRuntime;
  labels: Record<string, string>;
  env: Record<string, string>;
  mounts: WorkspaceDockerMount[];
  publishes: number[];
  extraArgs: string[];
  initScripts: string[];
  containerFiles: WorkspaceDockerContainerFile[];
  cleanup: Array<() => Promise<void> | void>;
}
