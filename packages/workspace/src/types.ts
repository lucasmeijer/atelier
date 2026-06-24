export type WorkspaceCreationContext = Record<string, unknown>;

export interface WorkspaceDockerMount {
  type: "bind" | "volume";
  source: string;
  target: string;
  readonly?: boolean;
}

export interface WorkspaceDockerPlan {
  image?: string;
  labels: Record<string, string>;
  env: Record<string, string>;
  mounts: WorkspaceDockerMount[];
  publishes: number[];
  extraArgs: string[];
  initScripts: string[];
  cleanup: Array<() => Promise<void> | void>;
}
