import { createHash } from "node:crypto";
import { isGitProjectInit, secretNeedsValue, type ProjectConfiguration } from "@atelier/projects";
import type { WorkspaceEntry } from "./workspace-registry.ts";

export interface WorkspaceWarning {
  kind: string;
  state: string;
  title: string;
  message: string;
  action?: { href: string; caption: string };
}

/** Current warning conditions. Stable state tokens scope acknowledgement to the specific problem. */
export function workspaceWarnings(entry: WorkspaceEntry, project: ProjectConfiguration | undefined): WorkspaceWarning[] {
  const warnings: WorkspaceWarning[] = [];
  function add(kind: string, title: string, message: string, state: string, action?: WorkspaceWarning["action"]): void {
    warnings.push({ kind, title, message, state: createHash("sha256").update(state).digest("hex"), action });
  }
  if (isGitProjectInit(entry.init)) {
    const projectId = entry.init.projectId;
    const configuration = project!;
    const missing = configuration.secrets.filter(secretNeedsValue);
    if (missing.length) add("missing-secrets", "Required secrets need values", `${missing.map((secret) => secret.envName).join(", ")}. Your workspace can run, but features needing these secrets may not work.`, JSON.stringify(missing.map(({ id, envName, updatedAt }) => ({ id, envName, updatedAt }))), { href: `/projects/${encodeURIComponent(projectId)}/settings?section=secrets`, caption: "Configure secrets" });
    // Older workspaces have no creation snapshot; do not claim to know whether their settings changed.
    if (entry.init.configurationFingerprint && entry.init.configurationFingerprint !== configuration.configurationFingerprint) {
      add("project-settings-changed", "Project settings have changed", "Your project settings have changed since you created this workspace. They will only apply to new workspaces.", configuration.configurationFingerprint!, { href: `/projects/${encodeURIComponent(projectId)}/settings`, caption: "Project settings" });
    }
  }
  for (const issue of entry.issues ?? []) add(issue.kind, issue.kind === "gateway" ? "Workspace gateway needs attention" : "Workspace image needs attention", issue.message, issue.message);
  if (entry.imageOutdated && !warnings.some((warning) => warning.kind === "image")) add("image", "Workspace image is outdated", "This workspace was created with an older version of Atelier. Some newer features may require a new workspace.", "outdated");
  return warnings;
}
