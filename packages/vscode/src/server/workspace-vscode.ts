import type { JsonValue } from "@atelier/core";
import { createWorkspaceMetadataState, execWorkspaceShell } from "@atelier/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { vscodeStartupScript } from "./startup.ts";

const workspaceVSCodeViewSchema = Type.Object({
  title: Type.String({ pattern: "\\S" }),
});
const workspaceVSCodeViewsSchema = Type.Array(workspaceVSCodeViewSchema);

export type WorkspaceVSCodeView = Static<typeof workspaceVSCodeViewSchema>;

function defaultViews(): WorkspaceVSCodeView[] {
  return [];
}

function parseVSCodeViews(value: JsonValue): WorkspaceVSCodeView[] {
  if (!Value.Check(workspaceVSCodeViewsSchema, value)) throw new Error("invalid persisted VS Code Work views");
  return value.map(({ title }) => ({ title }));
}

const vscodeViews = createWorkspaceMetadataState("vscode-work-views.json", parseVSCodeViews, defaultViews);

export function listWorkspaceVSCodeViews(workspaceId: string): WorkspaceVSCodeView[] {
  return vscodeViews.read(workspaceId);
}

export function createWorkspaceVSCodeView(workspaceId: string): WorkspaceVSCodeView {
  const existing = listWorkspaceVSCodeViews(workspaceId);
  const used = new Set(existing.map((view) => view.title));
  let index = 1;
  let title = "VS Code";
  while (used.has(title)) {
    index += 1;
    title = `VS Code ${index}`;
  }
  const view = { title };
  existing.push(view);
  vscodeViews.write(workspaceId, existing);
  return view;
}

export function deleteWorkspaceVSCodeView(workspaceId: string, title: string): void {
  vscodeViews.write(workspaceId, vscodeViews.read(workspaceId).filter((view) => view.title !== title));
}

export function deleteWorkspaceVSCodeState(workspaceId: string): void {
  vscodeViews.delete(workspaceId);
}

export async function ensureWorkspaceVSCodeServer(workspaceId: string): Promise<void> {
  const workspaceFile = `/.atelier/vscode/workspaces/${Buffer.from(workspaceId).toString("base64url")}.code-workspace`;
  const result = await execWorkspaceShell(workspaceId, vscodeStartupScript(workspaceFile), { user: "atelier" });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `could not start VS Code server for ${workspaceId}`);
}
