import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { AtelierCoreError, getAtelierRuntimeContext } from "@atelier/core";
import type { WorkspaceInitInstruction } from "@atelier/workspace";

export interface GitProjectInitInstruction {
  type: "project.git";
  projectId: string;
  name: string;
  gitUrl: string;
  branch: string | null;
}

declare module "@atelier/workspace" {
  interface WorkspaceInitInstructionMap {
    "project.git": GitProjectInitInstruction;
  }
}

export interface ProjectSummary {
  id: string;
  name: string;
  gitUrl: string;
  branch: string | null;
}

export interface ProjectListResult {
  projects: ProjectSummary[];
}

export interface AddProjectResult {
  project: ProjectSummary;
}

interface ProjectStore {
  projects: ProjectSummary[];
}

export function projectsFile(dataDir = getAtelierRuntimeContext().atelierDataDir): string {
  return join(dataDir, "projects.json");
}

export function projectNameFromGitUrl(url: string): string {
  const trimmed = url.trim().replace(/[/?#]+$/, "");
  const last = basename(trimmed);
  const withoutGit = last.endsWith(".git") ? last.slice(0, -4) : last;
  const safe = withoutGit.replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!safe || safe === "." || safe === "..") throw new AtelierCoreError("invalid_git_url", `could not derive project name from ${url}`);
  return safe;
}

function projectId(gitUrl: string, branch: string | null): string {
  const base = projectNameFromGitUrl(gitUrl);
  const digest = createHash("sha256").update(`${gitUrl}\0${branch ?? ""}`).digest("hex").slice(0, 8);
  return `${base}-${digest}`;
}

export function formatProjectSpec(project: Pick<ProjectSummary, "gitUrl" | "branch">): string {
  return `${project.gitUrl}${project.branch ? `#${project.branch}` : ""}`;
}

export function parseProjectSpec(spec: string): { gitUrl: string; branch: string | null } {
  const trimmed = spec.trim();
  if (!trimmed) throw new AtelierCoreError("invalid_git_url", "git url is required");

  const [gitUrl, branch] = trimmed.split(/#(.+)/, 2).map((part) => part.trim());
  return gitUrl && branch ? { gitUrl, branch } : { gitUrl: trimmed, branch: null };
}

async function readStore(file: string): Promise<ProjectStore> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as ProjectStore;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return { projects: [] };
    throw error;
  }
}

async function writeStore(file: string, store: ProjectStore): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

export async function listProjects(file = projectsFile()): Promise<ProjectListResult> {
  const store = await readStore(file);
  const projects = [...store.projects].sort((a, b) => a.name.localeCompare(b.name) || (a.branch ?? "").localeCompare(b.branch ?? "") || a.gitUrl.localeCompare(b.gitUrl));
  return { projects };
}

export async function addProject(spec: string, file = projectsFile()): Promise<AddProjectResult> {
  const { gitUrl, branch } = parseProjectSpec(spec);
  const id = projectId(gitUrl, branch);
  const store = await readStore(file);
  if (store.projects.some((project) => project.id === id || (project.gitUrl === gitUrl && project.branch === branch))) {
    throw new AtelierCoreError("project_exists", `project already exists: ${formatProjectSpec({ gitUrl, branch })}`);
  }
  const project = { id, name: projectNameFromGitUrl(gitUrl), gitUrl, branch };
  store.projects.push(project);
  await writeStore(file, store);
  return { project };
}

export function projectWorkspaceInit(project: ProjectSummary): WorkspaceInitInstruction {
  return { type: "project.git", projectId: project.id, name: project.name, gitUrl: project.gitUrl, branch: project.branch };
}

export function isGitProjectInit(init: WorkspaceInitInstruction | undefined): init is GitProjectInitInstruction {
  return init?.type === "project.git";
}
