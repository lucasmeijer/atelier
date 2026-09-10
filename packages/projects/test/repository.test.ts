import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { addProject, createProjectEnvironmentVariable, createProjectSecret, deleteProject, deleteProjectEnvironmentVariable, getGitIdentity, getStoredGitIdentity, gitIdentitySettingsFile, hasGitIdentity, createProjectSshKey, listProjectEnvironmentVariables, listProjectSecrets, listProjectSshKeys, listProjects, parseProjectSpec, revealProjectSecrets, revealProjectSshKeys, setGitIdentity, updateProject, updateProjectEnvironmentVariable, updateProjectSecret } from "@atelier/projects";

describe("projects", () => {
  test("parseProjectSpec supports an optional #branch suffix", () => {
    expect(parseProjectSpec("https://github.com/org/repo.git#main")).toEqual({ gitUrl: "https://github.com/org/repo.git", branch: "main" });
    expect(parseProjectSpec("git@github.com:org/repo.git")).toEqual({ gitUrl: "git@github.com:org/repo.git", branch: null });
  });

  test("rejects malformed persisted projects", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "atelier-projects-")), "projects.json");
    await writeFile(file, JSON.stringify({ projects: [{ id: 42 }] }));

    expect(listProjects(file)).rejects.toThrow();
  });

  test("addProject records a remote URL without cloning it", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "atelier-projects-")), "projects.json");

    const result = await addProject("https://github.com/org/repo.git#feature", file);
    expect(result.project.name).toBe("repo");
    expect(result.project.gitUrl).toBe("https://github.com/org/repo.git");
    expect(result.project.branch).toBe("feature");

    expect(await listProjects(file)).toEqual({ projects: [result.project] });
  });

  test("updateProject edits project fields without changing id", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "atelier-projects-")), "projects.json");
    const project = (await addProject("https://github.com/org/repo.git", file)).project;

    const result = await updateProject(project.id, { name: "Renamed", spec: "https://github.com/org/renamed.git#main" }, file);

    expect(result.project).toMatchObject({ id: project.id, name: "Renamed", gitUrl: "https://github.com/org/renamed.git", branch: "main", sessionShareKey: "Renamed" });
  });

  test("project secrets are encrypted at rest and decryptable by the host", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atelier-project-secrets-"));
    const file = join(dir, "projects.json");
    const keyFile = join(dir, "project-secrets.key");
    const project = (await addProject("https://github.com/org/secret-project.git", file)).project;

    const created = await createProjectSecret(project.id, { envName: "API_TOKEN", hostPattern: "api.example.com", placeholder: "sk-test-placeholder", secretValue: "real-secret" }, file, keyFile);
    await updateProjectSecret(project.id, created.id, { envName: "API_TOKEN", hostPattern: "*.example.com" }, file, keyFile);

    const rawStore = await readFile(file, "utf8");
    expect(rawStore).toContain("API_TOKEN");
    expect(rawStore).toContain("sk-test-placeholder");
    expect(rawStore).not.toContain("real-secret");
    expect(await revealProjectSecrets(project.id, file, keyFile)).toMatchObject([{ id: created.id, envName: "API_TOKEN", hostPattern: "*.example.com", placeholder: "sk-test-placeholder", secretValue: "real-secret" }]);

    await updateProjectSecret(project.id, created.id, { envName: "API_TOKEN", hostPattern: "*.example.com", placeholder: "" }, file, keyFile);
    expect((await revealProjectSecrets(project.id, file, keyFile))[0]).not.toHaveProperty("placeholder");
  });

  test("secret environment names accept and preserve lowercase and mixed case", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "atelier-secret-names-")), "projects.json");
    const { project } = await addProject("https://github.com/org/repo.git", file);
    const secret = await createProjectSecret(project.id, { envName: " api_token ", hostPattern: "api.example.com" }, file);
    expect(secret.envName).toBe("api_token");
    const updated = await updateProjectSecret(project.id, secret.id, { envName: "apiToken_2", hostPattern: "api.example.com" }, file);
    expect(updated.envName).toBe("apiToken_2");
    expect((await listProjectSecrets(project.id, file))[0]?.envName).toBe("apiToken_2");
    for (const envName of ["2token", "api-token", "api token", ""]) {
      await expect(createProjectSecret(project.id, { envName, hostPattern: "api.example.com" }, file)).rejects.toThrow("environment variable name");
      await expect(updateProjectSecret(project.id, secret.id, { envName, hostPattern: "api.example.com" }, file)).rejects.toThrow("environment variable name");
    }
  });

  test("secret requirements can be saved, annotated, made optional, and filled later", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atelier-secret-requirements-"));
    const file = join(dir, "projects.json");
    const keyFile = join(dir, "key");
    const project = (await addProject("https://github.com/org/requirements.git", file)).project;
    const values = { envName: "API_TOKEN", hostPattern: "api.example.com" };
    const secret = await createProjectSecret(project.id, { ...values, annotation: " Integration tests " }, file, keyFile);
    expect(secret).toMatchObject({ annotation: "Integration tests", optional: false, configured: false });
    expect(await revealProjectSecrets(project.id, file, keyFile)).toEqual([]);
    expect(await updateProjectSecret(project.id, secret.id, { ...values, optional: true, annotation: "Upload reports" }, file, keyFile))
      .toMatchObject({ optional: true, configured: false, annotation: "Upload reports" });
    expect(await updateProjectSecret(project.id, secret.id, { ...values, secretValue: "real-value" }, file, keyFile))
      .toMatchObject({ optional: true, configured: true, annotation: "Upload reports" });
    await updateProjectSecret(project.id, secret.id, { ...values, annotation: "", optional: false, secretValue: "" }, file, keyFile);
    expect(await listProjectSecrets(project.id, file)).toMatchObject([{ annotation: "", optional: false, configured: true }]);
    expect(await revealProjectSecrets(project.id, file, keyFile)).toMatchObject([{ secretValue: "real-value" }]);
    expect(await readFile(file, "utf8")).not.toContain("real-value");
  });

  test("older persisted secrets remain configured and default to required with no annotation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atelier-old-secrets-"));
    const file = join(dir, "projects.json");
    const keyFile = join(dir, "key");
    const project = (await addProject("https://github.com/org/old.git", file)).project;
    await createProjectSecret(project.id, { envName: "TOKEN", hostPattern: "example.com", secretValue: "value" }, file, keyFile);
    const store = JSON.parse(await readFile(file, "utf8"));
    delete store.projects[0].secrets[0].annotation;
    delete store.projects[0].secrets[0].optional;
    await writeFile(file, JSON.stringify(store));
    expect(await listProjectSecrets(project.id, file)).toMatchObject([{ annotation: "", optional: false, configured: true }]);
  });

  test("project SSH private keys are encrypted at rest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atelier-project-ssh-key-"));
    const file = join(dir, "projects.json");
    const keyFile = join(dir, "project-secrets.key");
    const project = (await addProject("git@example.com:org/repo.git", file)).project;
    const privateKeyPath = join(dir, "id_ed25519");
    expect(await Bun.spawn(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", privateKeyPath]).exited).toBe(0);
    const privateKey = await readFile(privateKeyPath, "utf8");

    const first = await createProjectSshKey(project.id, privateKey, file, keyFile);
    const second = await createProjectSshKey(project.id, privateKey, file, keyFile);

    expect(await listProjectSshKeys(project.id, file)).toEqual([first, second]);
    expect(await readFile(file, "utf8")).not.toContain("OPENSSH PRIVATE KEY");
    expect(await revealProjectSshKeys(project.id, file, keyFile)).toEqual([privateKey, privateKey]);
    expect((await listProjects(file)).projects[0]).toEqual({ ...project, configurationFingerprint: expect.any(String) });
    expect((await listProjects(file)).projects[0]!.configurationFingerprint).not.toBe(project.configurationFingerprint);
  });

  test("project environment variables support empty values", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "atelier-project-environment-")), "projects.json");
    const project = (await addProject("https://github.com/org/environment-project.git", file)).project;

    const created = await createProjectEnvironmentVariable(project.id, { name: "API_URL", value: "https://api.example.com" }, file);
    await createProjectEnvironmentVariable(project.id, { name: "EMPTY", value: "" }, file);
    await updateProjectEnvironmentVariable(project.id, created.id, { name: "SERVICE_URL", value: "https://service.example.com" }, file);

    expect(await listProjectEnvironmentVariables(project.id, file)).toMatchObject([
      { name: "EMPTY", value: "" },
      { name: "SERVICE_URL", value: "https://service.example.com" },
    ]);
    expect((await listProjects(file)).projects[0]).toEqual({ ...project, configurationFingerprint: expect.any(String) });
    expect((await listProjects(file)).projects[0]!.configurationFingerprint).not.toBe(project.configurationFingerprint);

    await deleteProjectEnvironmentVariable(project.id, created.id, file);
    expect(await listProjectEnvironmentVariables(project.id, file)).toHaveLength(1);
  });

  test("deleteProject removes a project by id", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "atelier-projects-")), "projects.json");
    const first = (await addProject("https://github.com/org/first.git", file)).project;
    const second = (await addProject("https://github.com/org/second.git", file)).project;

    expect(await deleteProject(first.id, file)).toEqual({ project: first });

    expect(await listProjects(file)).toEqual({ projects: [second] });
  });

  test("git identity settings are stored by the projects module", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "atelier-project-settings-")), "project-settings.json");

    expect(await hasGitIdentity(file)).toBe(false);
    await setGitIdentity({ name: " Ada Lovelace ", email: " ada@example.com " }, file);

    expect(await hasGitIdentity(file)).toBe(true);
    expect(await getGitIdentity(file)).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
  });

  test("git identity adopts the host global git config when app settings are empty", async () => {
    const previousDataDir = process.env.ATELIER_DATA_DIR;
    const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    const dataDir = await mkdtemp(join(tmpdir(), "atelier-project-settings-"));
    const gitConfig = join(await mkdtemp(join(tmpdir(), "atelier-git-config-")), ".gitconfig");
    process.env.ATELIER_DATA_DIR = dataDir;
    process.env.GIT_CONFIG_GLOBAL = gitConfig;
    try {
      await writeFile(gitConfig, "[user]\n\tname = Grace Hopper\n\temail = grace@example.com\n", "utf8");

      expect(await getStoredGitIdentity()).toBeUndefined();
      expect(await getGitIdentity()).toEqual({ name: "Grace Hopper", email: "grace@example.com" });
      expect(JSON.parse(await readFile(gitIdentitySettingsFile(), "utf8"))).toEqual({ gitIdentity: { name: "Grace Hopper", email: "grace@example.com" } });
    } finally {
      if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
      else process.env.ATELIER_DATA_DIR = previousDataDir;
      if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
    }
  });
});
