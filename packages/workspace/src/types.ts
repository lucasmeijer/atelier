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
  preloadImages: string[];
  labels: Record<string, string>;
  env: Record<string, string>;
  mounts: WorkspaceDockerMount[];
  extraArgs: string[];
  initScripts: string[];
  containerFiles: WorkspaceDockerContainerFile[];
  cleanup: Array<() => Promise<void> | void>;
}
