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
  sessionShareKey: string;
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
  sessionShareKey: string;
}

export interface ProjectSecretSummary {
  id: string;
  projectId: string;
  envName: string;
  hostPattern: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredProjectSecret extends ProjectSecretSummary {
  encryptedSecret: string;
}

export interface ProjectRecord extends ProjectSummary {
  secrets?: StoredProjectSecret[];
}

export interface ProjectListResult {
  projects: ProjectSummary[];
}

export interface AddProjectResult {
  project: ProjectSummary;
}

export interface DeleteProjectResult {
  project: ProjectSummary;
}

export interface UpdateProjectResult {
  project: ProjectSummary;
}

export interface ProjectStore {
  projects: ProjectRecord[];
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

export async function readProjectStore(file: string): Promise<ProjectStore> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as ProjectStore;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return { projects: [] };
    throw error;
  }
}

export async function writeProjectStore(file: string, store: ProjectStore): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function projectSummary(project: ProjectRecord): ProjectSummary {
  const { secrets: _secrets, ...summary } = project;
  return summary;
}

export async function listProjects(file = projectsFile()): Promise<ProjectListResult> {
  const store = await readProjectStore(file);
  const projects = [...store.projects].sort((a, b) => a.name.localeCompare(b.name) || (a.branch ?? "").localeCompare(b.branch ?? "") || a.gitUrl.localeCompare(b.gitUrl)).map(projectSummary);
  return { projects };
}

export async function addProject(spec: string, file = projectsFile()): Promise<AddProjectResult> {
  const { gitUrl, branch } = parseProjectSpec(spec);
  const id = projectId(gitUrl, branch);
  const store = await readProjectStore(file);
  if (store.projects.some((project) => project.id === id || (project.gitUrl === gitUrl && project.branch === branch))) {
    throw new AtelierCoreError("project_exists", `project already exists: ${formatProjectSpec({ gitUrl, branch })}`);
  }
  const name = projectNameFromGitUrl(gitUrl);
  const project = { id, name, gitUrl, branch, sessionShareKey: name };
  store.projects.push(project);
  await writeProjectStore(file, store);
  return { project: projectSummary(project) };
}

export async function updateProject(id: string, values: { name: string; spec: string }, file = projectsFile()): Promise<UpdateProjectResult> {
  const store = await readProjectStore(file);
  const project = store.projects.find((candidate) => candidate.id === id);
  if (!project) throw new AtelierCoreError("project_not_found", `project not found: ${id}`);
  const name = values.name.trim();
  if (!name) throw new AtelierCoreError("invalid_arguments", "project name is required");
  const { gitUrl, branch } = parseProjectSpec(values.spec);
  if (store.projects.some((candidate) => candidate.id !== id && candidate.gitUrl === gitUrl && candidate.branch === branch)) {
    throw new AtelierCoreError("project_exists", `project already exists: ${formatProjectSpec({ gitUrl, branch })}`);
  }
  project.name = name;
  project.gitUrl = gitUrl;
  project.branch = branch;
  project.sessionShareKey = name;
  await writeProjectStore(file, store);
  return { project: projectSummary(project) };
}

export async function deleteProject(id: string, file = projectsFile()): Promise<DeleteProjectResult> {
  const store = await readProjectStore(file);
  const project = store.projects.find((candidate) => candidate.id === id);
  if (!project) throw new AtelierCoreError("project_not_found", `project not found: ${id}`);
  store.projects = store.projects.filter((candidate) => candidate.id !== id);
  await writeProjectStore(file, store);
  return { project: projectSummary(project) };
}

export function projectWorkspaceInit(project: ProjectSummary): WorkspaceInitInstruction {
  return { type: "project.git", projectId: project.id, name: project.name, gitUrl: project.gitUrl, branch: project.branch, sessionShareKey: project.sessionShareKey };
}

export function isGitProjectInit(init: WorkspaceInitInstruction | undefined): init is GitProjectInitInstruction {
  return init?.type === "project.git";
}
