import { randomUUID } from "node:crypto";
import { AtelierCoreError } from "@atelier/core";
import { findProjectRecord, projectsFile, readProjectStore, writeProjectStore, type ProjectEnvironmentVariable, type ProjectRecord } from "./project.ts";

function normalizeName(value: string): string {
  const name = value.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new AtelierCoreError("invalid_arguments", "NAME must be an environment variable name");
  return name;
}

function findVariable(project: ProjectRecord, variableId: string): ProjectEnvironmentVariable {
  const variable = project.environment?.find((candidate) => candidate.id === variableId);
  if (!variable) throw new AtelierCoreError("project_environment_variable_not_found", `project environment variable not found: ${variableId}`);
  return variable;
}

function assertNameAvailable(project: ProjectRecord, name: string, exceptVariableId?: string): void {
  if (project.environment?.some((variable) => variable.id !== exceptVariableId && variable.name === name)) throw new AtelierCoreError("project_environment_variable_exists", "project environment variable already exists");
}

export async function listProjectEnvironmentVariables(projectId: string, file = projectsFile()): Promise<ProjectEnvironmentVariable[]> {
  const project = findProjectRecord(await readProjectStore(file), projectId);
  return [...(project.environment ?? [])].sort((a, b) => a.name.localeCompare(b.name));
}

export async function projectEnvironment(projectId: string, file = projectsFile()): Promise<Record<string, string>> {
  const project = (await readProjectStore(file)).projects.find((candidate) => candidate.id === projectId);
  return Object.fromEntries((project?.environment ?? []).map((variable) => [variable.name, variable.value]));
}

export async function createProjectEnvironmentVariable(projectId: string, values: { name: string; value: string }, file = projectsFile()): Promise<ProjectEnvironmentVariable> {
  const name = normalizeName(values.name);
  const store = await readProjectStore(file);
  const project = findProjectRecord(store, projectId);
  project.environment ??= [];
  assertNameAvailable(project, name);
  const now = new Date().toISOString();
  const variable: ProjectEnvironmentVariable = { id: randomUUID(), projectId, name, value: values.value, createdAt: now, updatedAt: now };
  project.environment!.push(variable);
  await writeProjectStore(file, store);
  return variable;
}

export async function updateProjectEnvironmentVariable(projectId: string, variableId: string, values: { name: string; value: string }, file = projectsFile()): Promise<ProjectEnvironmentVariable> {
  const name = normalizeName(values.name);
  const store = await readProjectStore(file);
  const project = findProjectRecord(store, projectId);
  const variable = findVariable(project, variableId);
  assertNameAvailable(project, name, variableId);
  variable.name = name;
  variable.value = values.value;
  variable.updatedAt = new Date().toISOString();
  await writeProjectStore(file, store);
  return variable;
}

export async function deleteProjectEnvironmentVariable(projectId: string, variableId: string, file = projectsFile()): Promise<ProjectEnvironmentVariable> {
  const store = await readProjectStore(file);
  const project = findProjectRecord(store, projectId);
  const variable = findVariable(project, variableId);
  project.environment = project.environment!.filter((candidate) => candidate !== variable);
  await writeProjectStore(file, store);
  return variable;
}

