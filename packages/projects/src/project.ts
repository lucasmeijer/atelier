import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { AtelierCoreError, getAtelierRuntimeContext } from "@atelier/core";
import type { WorkspaceInitInstruction } from "@atelier/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const gitProjectInitSchema = Type.Object({
  type: Type.Literal("project.git"),
  projectId: Type.String(),
  name: Type.String(),
  gitUrl: Type.String(),
  branch: Type.Union([Type.String(), Type.Null()]),
  sessionShareKey: Type.String(),
});

export type GitProjectInitInstruction = Static<typeof gitProjectInitSchema>;

declare module "@atelier/workspace" {
  interface WorkspaceInitInstructionMap {
    "project.git": GitProjectInitInstruction;
  }
}

export type ProjectSummary = Omit<ProjectRecord, "secrets" | "sshKeys" | "environment">;
export type StoredProjectSecret = Static<typeof storedProjectSecretSchema>;
export type ProjectSecretSummary = Omit<StoredProjectSecret, "encryptedSecret">;
export type StoredProjectSshKey = Static<typeof storedProjectSshKeySchema>;
export type ProjectSshKeySummary = Omit<StoredProjectSshKey, "encryptedPrivateKey">;
export type ProjectEnvironmentVariable = Static<typeof projectEnvironmentVariableSchema>;
export type ProjectRecord = Static<typeof projectRecordSchema>;
export type ProjectStore = Static<typeof projectStoreSchema>;

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

const storedProjectSecretSchema = Type.Object({
  id: Type.String(),
  projectId: Type.String(),
  envName: Type.String(),
  hostPattern: Type.String(),
  placeholder: Type.Optional(Type.String()),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  encryptedSecret: Type.String(),
});

const projectEnvironmentVariableSchema = Type.Object({
  id: Type.String(),
  projectId: Type.String(),
  name: Type.String(),
  value: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

const storedProjectSshKeySchema = Type.Object({
  id: Type.String(),
  projectId: Type.String(),
  keyType: Type.String(),
  fingerprint: Type.String(),
  createdAt: Type.String(),
  encryptedPrivateKey: Type.String(),
});

const projectRecordSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  gitUrl: Type.String(),
  branch: Type.Union([Type.String(), Type.Null()]),
  sessionShareKey: Type.String(),
  secrets: Type.Optional(Type.Array(storedProjectSecretSchema)),
  sshKeys: Type.Optional(Type.Array(storedProjectSshKeySchema)),
  environment: Type.Optional(Type.Array(projectEnvironmentVariableSchema)),
});

const projectStoreSchema = Type.Object({
  projects: Type.Array(projectRecordSchema),
});

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
    return Value.Parse(projectStoreSchema, JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return { projects: [] };
    throw error;
  }
}

export async function writeProjectStore(file: string, store: ProjectStore): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tempFile = `${file}.${randomUUID()}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(tempFile, file);
}

export function findProjectRecord(store: ProjectStore, projectId: string): ProjectRecord {
  const project = store.projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new AtelierCoreError("project_not_found", `project not found: ${projectId}`);
  return project;
}

function projectSummary(project: ProjectRecord): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    gitUrl: project.gitUrl,
    branch: project.branch,
    sessionShareKey: project.sessionShareKey,
  };
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

export function isGitProjectInit(init: unknown): init is GitProjectInitInstruction {
  return Value.Check(gitProjectInitSchema, init);
}
