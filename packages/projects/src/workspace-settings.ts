import { validateProjectEnvironmentName } from "./environment.ts";
import { projectSecretPlaceholder } from "./secrets.ts";
import { createHash, randomUUID } from "node:crypto";
import { AtelierCoreError, invalidArguments } from "@atelier/core";
import { Value } from "typebox/value";
import { findProjectRecord, validateProjectDockerfile, validateProjectPreloadImage, projectWorkspaceInit, projectConfigurationFingerprint, projectWorkspaceSettingsSchema, projectsFile, readProjectStore, updateProjectStore, type GitProjectInitInstruction, type ProjectRecord, type ProjectWorkspaceSettings } from "./project.ts";

function settingsRevision(project: ProjectRecord): string {
  const { lastWorkspaceCreatedAt: _, ...configuration } = project;
  return createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
}

export function validateProjectWorkspaceSettings(settings: ProjectWorkspaceSettings): void {
  if (!Value.Check(projectWorkspaceSettingsSchema, settings)) throw invalidArguments("A complete project workspace configuration is required; repository and secret fields cannot be supplied");
  validateProjectDockerfile(settings.dockerfile);
  settings.preloadImages.forEach(validateProjectPreloadImage);
  const names = new Set<string>();
  for (const variable of settings.environment) {
    validateProjectEnvironmentName(variable.name);
    if (names.has(variable.name)) throw invalidArguments(`Duplicate environment variable: ${variable.name}`);
    names.add(variable.name);
  }
}

function checkRevision(project: ProjectRecord, expectedRevision: string): void {
  if (settingsRevision(project) !== expectedRevision) throw new AtelierCoreError("project_settings_conflict", "Project configuration changed. Read project settings again before continuing.");
}

function assertNoSecretEnvironment(project: ProjectRecord, settings: ProjectWorkspaceSettings): void {
  for (const variable of settings.environment) {
    if (project.secrets?.some((secret) => secret.envName === variable.name)) throw invalidArguments(`Environment variable ${variable.name} is managed as a secret; use request_secret_value`);
  }
}

function settingsResult(project: ProjectRecord) {
  return {
    settingsRevision: settingsRevision(project),
    settings: {
      dockerfile: project.dockerfile ?? "",
      preloadImages: project.preloadImages ?? [],
      environment: (project.environment ?? []).map(({ name, value }) => ({ name, value })),
    } satisfies ProjectWorkspaceSettings,
  };
}

export async function readProjectWorkspaceSettings(projectId: string, file = projectsFile()) {
  const project = findProjectRecord(await readProjectStore(file), projectId);
  // Public configuration contains no encrypted or plaintext credentials.
  return {
    project: { id: project.id, name: project.name, gitUrl: project.gitUrl, branch: project.branch },
    ...settingsResult(project),
    secrets: (project.secrets ?? []).map(({ envName, hostPattern, placeholder, encryptedSecret }) => ({
      envName, hostPattern, placeholder: placeholder ?? projectSecretPlaceholder(envName), configured: !!encryptedSecret,
    })),
  };
}

export async function writeProjectWorkspaceSettings(projectId: string, expectedRevision: string, settings: ProjectWorkspaceSettings, file = projectsFile()) {
  validateProjectWorkspaceSettings(settings);
  return updateProjectStore(file, (store) => {
    const project = findProjectRecord(store, projectId);
    checkRevision(project, expectedRevision);
    assertNoSecretEnvironment(project, settings);
    if (settings.dockerfile.trim()) project.dockerfile = settings.dockerfile;
    else delete project.dockerfile;
    project.preloadImages = [...settings.preloadImages];
    const now = new Date().toISOString();
    project.environment = settings.environment.map(({ name, value }) => {
      const existing = project.environment?.find((variable) => variable.name === name);
      return { id: existing?.id ?? randomUUID(), projectId: project.id, name, value, createdAt: existing?.createdAt ?? now, updatedAt: existing?.value === value ? existing.updatedAt : now };
    });
    return { ...settingsResult(project), appliesTo: "future_workspaces" as const };
  });
}

export async function projectWorkspaceInitWithSettings(projectId: string, expectedRevision: string, settings: ProjectWorkspaceSettings, createdBy?: GitProjectInitInstruction["createdBy"], file = projectsFile()): Promise<GitProjectInitInstruction> {
  validateProjectWorkspaceSettings(settings);
  const project = findProjectRecord(await readProjectStore(file), projectId);
  checkRevision(project, expectedRevision);
  assertNoSecretEnvironment(project, settings);
  // Derive identity from the checked snapshot, never from tool arguments.
  const configuredProject = { ...project, ...settings };
  return { ...projectWorkspaceInit({ ...configuredProject, configurationFingerprint: projectConfigurationFingerprint(configuredProject) }), settings: structuredClone(settings), createdBy };
}
