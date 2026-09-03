import { AtelierCoreError, gitHubCredentialHelperCommand, invalidArguments, readJsonObject, requestAcceptsJson, type JsonObject } from "@atelier/core";
import { actionItemHtml } from "@atelier/design-system/action-item";
import { actionLinkHtml } from "@atelier/design-system/action-link";
import { buttonHtml } from "@atelier/design-system/button";
import { dialogHtml } from "@atelier/design-system/dialog";
import { destructiveConfirmationHtml } from "@atelier/design-system/destructive-confirmation";
import { Icons } from "@atelier/design-system/icons";
import { transientFeedbackHtml } from "@atelier/design-system/transient-feedback";
import { discoverHostGitHubToken, hasWorkspaceGitHubToken } from "@atelier/proxy-egress";
import {
  addProject, createProjectEnvironmentVariable, createProjectSshKey, createProjectSecret,
  deleteProject, deleteProjectEnvironmentVariable, deleteProjectSecret, deleteProjectSshKey,
  formatProjectSpec, listProjectEnvironmentVariables, listProjectSecrets,
  listProjectSshKeys, listProjects, parseProjectSpec, updateProject,
  updateProjectEnvironmentVariable, updateProjectSecret,
  type ProjectEnvironmentVariable, type ProjectSecretSummary, type ProjectSshKeySummary, type ProjectSummary,
} from "@atelier/projects";
import { domId, escapeHtml, providerBrandColor, providerBrandIconHtml, turboStreamResponse } from "@atelier/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { GitHubRepositorySearchRateLimitError, renderGitHubRepositorySearchMenu, renderGitHubRepositorySearchRateLimitMenu, searchGitHubRepositories, shouldSearchGitHubRepositories } from "./github-repo-search.ts";
import { jsonResponse, response, turboReplaceStream, turboUpdateStream, wantsTurboStream } from "./http-responses.ts";

const jsonStringSchema = Type.String();

export interface ProjectRoutes {
  handle(request: Request, url: URL): Promise<Response | undefined>;
  byReference(reference: string): Promise<ProjectSummary>;
  editorModal(options?: { kind: "settings"; projectId: string; section?: string } | { kind: "new" }): Promise<string>;
}

interface ProjectWorkspaceReference {
  workspaceId: string;
  title: string;
}

export function createProjectRoutes(deps: {
  referencingWorkspaces(projectId: string): ProjectWorkspaceReference[];
  refreshWorkspacePaneCollections(): Promise<string>;
  renderLaunchComposer(project: ProjectSummary): Promise<string>;
  createAgentWorkspace(project: ProjectSummary, request: Request): Promise<Response>;
  workspaceCommandModalHostId: string;
}): ProjectRoutes {
  function projectEnvironmentRow(project: ProjectSummary, variable: ProjectEnvironmentVariable): string {
    const removeButton = destructiveConfirmationHtml({
      trigger: {
        type: "button",
        variant: "danger",
        content: { kind: "icon-only", iconHtml: Icons.Close, label: "Remove environment variable" },
      },
      confirmCaption: "Remove variable",
      cancelCaption: "Cancel",
      confirmFormAction: `/projects/${encodeURIComponent(project.id)}/environment/${encodeURIComponent(variable.id)}/delete`,
    });
    return `<form class="project-configuration-row project-environment-row" method="post" action="/projects/${encodeURIComponent(project.id)}/environment/${encodeURIComponent(variable.id)}" data-turbo="true" data-controller="settings-autosave" data-action="focusout->settings-autosave#saveWhenLeaving">
    <input class="text-field" name="name" value="${escapeHtml(variable.name)}" aria-label="Name" autocomplete="off">
    <input class="text-field" name="value" value="${escapeHtml(variable.value)}" aria-label="Value" autocomplete="off">
    <span class="project-configuration-actions">${removeButton}</span>
  </form>`;
  }

  function projectEnvironmentFields(project: ProjectSummary, environment: ProjectEnvironmentVariable[]): string {
    return `<div class="project-configuration-grid" id="${domId("project_environment_fields", project.id)}" aria-label="Environment variables">
      ${environment.map((variable) => projectEnvironmentRow(project, variable)).join("")}
      <form class="project-configuration-row project-environment-row new" method="post" action="/projects/${encodeURIComponent(project.id)}/environment" data-turbo="true" data-controller="settings-autosave" data-action="focusout->settings-autosave#saveWhenLeaving submit->settings-autosave#submit">
        <input class="text-field" name="name" placeholder="TELEGRAM_CHANNEL_ID" aria-label="Name" autocomplete="off" required>
        <input class="text-field" name="value" placeholder="-1001234567890" aria-label="Value" autocomplete="off">
        <span></span>
      </form>
    </div>`;
  }

  function projectConfigurationDisclosure(label: string, fieldsHtml: string, open = false): string {
    const summary = actionItemHtml({ kind: "single", label: { kind: "text", text: label }, leadingHtml: Icons.Disclosure, element: { tag: "summary" } });
    return `<details class="project-configuration-disclosure"${open ? " open" : ""}>${summary}${fieldsHtml}</details>`;
  }

  function revealSection(section: ProjectSettingsSection | undefined, current: ProjectSettingsSection): string {
    return section === current ? ' data-controller="scroll-into-view"' : "";
  }

  function projectEnvironmentEditor(project: ProjectSummary, environment: ProjectEnvironmentVariable[], section?: ProjectSettingsSection): string {
    return `<section class="project-configuration-list project-environment" id="${domId("project_environment", project.id)}"${revealSection(section, "environment")}>
      <div class="project-configuration-head"><h3>Environment variables</h3><p>These variables are added to every new workspace container created for this project.</p></div>
      ${projectConfigurationDisclosure("Configure environment variables", projectEnvironmentFields(project, environment), section === "environment")}
    </section>`;
  }

  function projectSecretRow(project: ProjectSummary, secret: ProjectSecretSummary): string {
    const secretPath = `/projects/${encodeURIComponent(project.id)}/secrets/${encodeURIComponent(secret.id)}`;
    const deleteButton = destructiveConfirmationHtml({
      trigger: { type: "button", variant: "danger", content: { kind: "caption", caption: "Delete secret" } },
      confirmCaption: "Delete secret",
      cancelCaption: "Cancel",
      confirmFormAction: `${secretPath}/delete`,
    });
    return `<form class="project-secret" aria-label="Secret" method="post" action="${secretPath}" data-turbo="true" data-controller="settings-autosave" data-action="focusout->settings-autosave#saveWhenLeaving">
      <label><span>Environment variable</span><input class="text-field" name="envName" value="${escapeHtml(secret.envName)}" autocomplete="off"></label>
      <label><span>Host</span><input class="text-field" name="hostPattern" value="${escapeHtml(secret.hostPattern)}" autocomplete="off"></label>
      <label><span>Secret</span><input class="text-field" name="secretValue" type="password" placeholder="Unchanged" autocomplete="new-password"></label>
      <label><span>Placeholder</span><input class="text-field" name="placeholder" value="${escapeHtml(secret.placeholder ?? "")}" placeholder="You rarely need to fill this in" autocomplete="off"></label>
      <div class="project-secret-actions">${deleteButton}</div>
    </form>`;
  }

  function projectSecretFields(project: ProjectSummary, secrets: ProjectSecretSummary[]): string {
    return `<div class="project-secrets-list" id="${domId("project_secret_fields", project.id)}" aria-label="Secrets">
      ${secrets.map((secret) => projectSecretRow(project, secret)).join("")}
      <form class="project-secret new" aria-label="Add secret" method="post" action="/projects/${encodeURIComponent(project.id)}/secrets" data-turbo="true" data-controller="settings-autosave" data-action="focusout->settings-autosave#saveWhenLeaving submit->settings-autosave#submit">
        <label><span>Environment variable</span><input class="text-field" name="envName" placeholder="GOOGLE_MAPS_API_KEY" autocomplete="off" required></label>
        <label><span>Host</span><input class="text-field" name="hostPattern" placeholder="maps.googleapis.com" autocomplete="off" required></label>
        <label><span>Secret</span><input class="text-field" name="secretValue" type="password" placeholder="AIzaSyExampleKey1234567890" autocomplete="new-password" required></label>
        <label><span>Placeholder</span><input class="text-field" name="placeholder" placeholder="You rarely need to fill this in" autocomplete="off"></label>
      </form>
    </div>`;
  }

  function projectSecretEditor(project: ProjectSummary, secrets: ProjectSecretSummary[], section?: ProjectSettingsSection): string {
    return `<section class="project-configuration-list project-secrets" id="${domId("project_secrets", project.id)}"${revealSection(section, "secrets")}>
      <div class="project-configuration-head"><h3>Secrets</h3><p>Atelier lets you use secrets without exposing them to agents. Your encrypted secret stays outside agent sandboxes. Agents receive a placeholder that Atelier replaces with the real secret in matching network requests.</p></div>
      ${projectConfigurationDisclosure("Configure secrets", projectSecretFields(project, secrets), section === "secrets")}
    </section>`;
  }

  function projectSshKeyFields(project: ProjectSummary, keys: ProjectSshKeySummary[]): string {
    const projectPath = `/projects/${encodeURIComponent(project.id)}`;
    const configuredKeys = keys.map((key) => {
      const removeButton = destructiveConfirmationHtml({
        trigger: { type: "button", variant: "danger", content: { kind: "caption", caption: "Remove SSH key" } },
        confirmCaption: "Remove SSH key",
        cancelCaption: "Cancel",
      });
      return `<form class="project-ssh-key-configured" method="post" action="${projectPath}/ssh-keys/${encodeURIComponent(key.id)}/delete" data-turbo="true"><span title="${escapeHtml(`${key.keyType} ${key.fingerprint}`)}"><code>${escapeHtml(key.keyType)}</code> <code>${escapeHtml(key.fingerprint)}</code></span>${removeButton}</form>`;
    }).join("");
    return `<div class="project-ssh-key-fields" id="${domId("project_ssh_key_fields", project.id)}">${configuredKeys}<form class="project-ssh-key-form" method="post" action="${projectPath}/ssh-keys" data-turbo="true" data-controller="settings-autosave" data-action="focusout->settings-autosave#saveWhenLeaving submit->settings-autosave#submit">
      <label><span>Private key</span><textarea class="textarea" name="privateKey" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA…\n-----END OPENSSH PRIVATE KEY-----" autocomplete="off" required></textarea></label>
    </form></div>`;
  }

  function projectSshKeyEditor(project: ProjectSummary, keys: ProjectSshKeySummary[], section?: ProjectSettingsSection): string {
    return `<section class="project-configuration-list project-ssh-key" id="${domId("project_ssh_key", project.id)}"${revealSection(section, "ssh-keys")}>
      <div class="project-configuration-head"><h3>SSH key</h3><p>If you want to have your agent ssh into a remote machine, but you do not want to expose the required ssh key to the agent, you can paste your private ssh key below. It will be stored and encrypted outside of the agent sandbox. The agent will be given an ssh socket that they can use to do their work, without getting access to the private key.</p></div>
      ${projectConfigurationDisclosure(keys.length === 0 ? "Add SSH key" : "Configure SSH keys", projectSshKeyFields(project, keys), section === "ssh-keys")}
    </section>`;
  }

  function projectDeleteControl(projectId: string, references: ProjectWorkspaceReference[] = []): string {
    const confirmation = destructiveConfirmationHtml({
      trigger: { type: "button", variant: "danger", content: { kind: "caption", caption: "Delete project" } },
      confirmCaption: "Delete project",
      cancelCaption: "Cancel",
    });
    const form = `<form method="post" action="/projects/${encodeURIComponent(projectId)}/delete" data-turbo="true" data-action="turbo:submit-end->dialog#submitted">${confirmation}</form>`;
    const feedback = references.length === 1
      ? `Delete workspace “${references[0]!.title}” first`
      : `Delete ${references.length} workspaces first`;
    return transientFeedbackHtml({
      element: { tag: "div", attributesHtml: `id="${domId("project_delete_control", projectId)}"` },
      initialContent: { kind: "html", html: form },
      feedbackContent: { kind: "html", html: `<span class="transient-feedback__status">${escapeHtml(feedback)}</span>` },
      state: references.length > 0 ? "feedback" : "initial",
    });
  }

  type ProjectSettingsSection = "repository" | "secrets" | "ssh-keys" | "environment" | "danger";
  const projectSettingsSections: readonly ProjectSettingsSection[] = ["repository", "secrets", "ssh-keys", "environment", "danger"];

  function parseProjectSettingsSection(value: string | undefined): ProjectSettingsSection | undefined {
    if (value === undefined) return undefined;
    if (value === "repository" || value === "secrets" || value === "ssh-keys" || value === "environment" || value === "danger") return value;
    throw invalidArguments(`section must be one of: ${projectSettingsSections.join(", ")}`);
  }

  async function projectEditorFrame(project: ProjectSummary, section?: ProjectSettingsSection): Promise<string> {
    const [environment, secrets, sshKeys] = await Promise.all([listProjectEnvironmentVariables(project.id), listProjectSecrets(project.id), listProjectSshKeys(project.id)]);
    return `<turbo-frame id="project_editor_frame" class="project-editor-frame">
      <div class="project-editor-page project-editor-detail-page">
        <div class="project-editor-detail-body">
          <section class="project-edit-section"${revealSection(section, "repository")}><form class="project-edit-form" aria-label="Repository" method="post" action="/projects/${encodeURIComponent(project.id)}" data-controller="settings-autosave" data-action="change->settings-autosave#save"><label class="project-edit-field"><span>Display name</span><input class="text-field" name="name" value="${escapeHtml(project.name)}" required></label><label class="project-edit-field"><span>Repository</span><input class="text-field" name="gitUrl" value="${escapeHtml(formatProjectSpec(project))}" required></label></form></section>
          <div class="project-edit-config">${projectSecretEditor(project, secrets, section)}${projectSshKeyEditor(project, sshKeys, section)}${projectEnvironmentEditor(project, environment, section)}</div>
          <section class="project-edit-danger-zone"${revealSection(section, "danger")}><h3>Danger zone</h3><div class="project-edit-danger">${projectDeleteControl(project.id)}</div></section>
        </div>
      </div>
    </turbo-frame>`;
  }

  function newProjectEditorFrame(): string {
    const cancelButton = buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Cancel" }, attributesHtml: 'data-action="dialog#close"' });
    const addButton = buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Add project" }, attributesHtml: 'data-turbo-submits-with="Adding…"' });
    return `<turbo-frame id="project_editor_frame" class="project-editor-frame"><div class="project-editor-page project-editor-detail-page"><form class="project-editor-new-form" aria-label="Add project" method="post" action="/projects" data-turbo="true" data-action="turbo:submit-end->dialog#submitted"><div><h3>Repository source</h3><p>Save a remote URL, local path, or search for a GitHub repository.</p><div class="project-github-search" data-controller="project-github-search" data-project-github-search-url-value="/projects/github-search"><input class="text-field" name="gitUrl" placeholder="github.com/org/repo, or /path/to/repo#branch" required autofocus data-project-github-search-target="input" data-action="keydown->project-github-search#keydown input->project-github-search#input"><div class="agent-completion-menu-host project-github-search-menu" data-project-github-search-target="menu" hidden></div></div></div><footer>${cancelButton}${addButton}</footer></form></div></turbo-frame>`;
  }

  async function projectEditorModal(options?: { kind: "settings"; projectId: string; section?: string } | { kind: "new" }): Promise<string> {
    const project = options?.kind === "settings" ? await projectById(options.projectId) : undefined;
    const section = parseProjectSettingsSection(options?.kind === "settings" ? options.section : undefined);
    const title = options?.kind === "new" ? "Add project" : "Project settings";
    const bodyHtml = options?.kind === "new"
      ? newProjectEditorFrame()
      : project
        ? await projectEditorFrame(project, section)
        : '<turbo-frame id="project_editor_frame" class="project-editor-frame"></turbo-frame>';
    return dialogHtml({
      element: {
        id: "project-editor-modal",
        className: "dialog--sheet project-editor-modal",
        attributesHtml: `aria-label="${title}"${options ? " data-dialog-auto-show" : ""}`,
      },
      iconHtml: Icons.Settings,
      titleCaption: title,
      bodyHtml,
      bodyLayout: "full-bleed",
      closeLabel: `Close ${title.toLowerCase()}`,
    });
  }

  function isGitHubRemoteUrl(gitUrl: string): boolean {
    return /(^|@|\/)github\.com[:/]/i.test(gitUrl.trim());
  }

  async function canReadRemoteWithConfiguredToken(gitUrl: string): Promise<boolean> {
    const token = discoverHostGitHubToken();
    interface GitProcessEnvironment {
      [name: string]: string | undefined;
    }
    const env: GitProcessEnvironment = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    if (token) env.GH_TOKEN = token;
    const proc = Bun.spawn(["git", "-c", `credential.helper=${gitHubCredentialHelperCommand}`, "ls-remote", "--exit-code", gitUrl, "HEAD"], {
      stdout: "ignore",
      stderr: "pipe",
      env,
    });
    await new Response(proc.stderr).text().catch(() => "");
    return await proc.exited === 0;
  }

  async function githubRepoAccessProblem(project: ProjectSummary): Promise<"missing-token" | "token-denied" | undefined> {
    if (process.env.NODE_ENV === "test" || !isGitHubRemoteUrl(project.gitUrl)) return undefined;
    if (await canReadRemoteWithConfiguredToken(project.gitUrl).catch(() => false)) return undefined;
    return hasWorkspaceGitHubToken() ? "token-denied" : "missing-token";
  }

  function githubRepoAccessProblemModal(project: ProjectSummary, problem: "missing-token" | "token-denied"): string {
    const title = problem === "missing-token" ? "Connect GitHub to clone this project" : "GitHub token cannot access this project";
    const body = problem === "missing-token"
      ? `<p><b>${escapeHtml(project.name)}</b> looks private, and Atelier does not have a GitHub token yet.</p><p>Connect GitHub in workspace settings, then try creating this workspace again.</p>`
      : `<p>Atelier has a GitHub token, but GitHub would not allow it to read <b>${escapeHtml(project.name)}</b>.</p><p>Reconnect GitHub with a token that has access to this project, then try again.</p>`;
    const cancelButton = buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "Cancel" } });
    const settingsLink = actionLinkHtml({
      href: "/settings?section=github",
      variant: "primary",
      content: { kind: "caption", caption: "Open GitHub settings" },
      attributesHtml: 'data-turbo-frame="_top" data-turbo-stream="true"',
    });
    return dialogHtml({
      element: {
        className: "dialog--compact",
        attributesHtml: "data-dialog-auto-show",
      },
      iconHtml: `<span class="settings-provider-icon" style="--provider-color:${providerBrandColor("github")}">${providerBrandIconHtml("github", "GitHub")}</span>`,
      titleCaption: title,
      bodyHtml: body,
      footerHtml: `<form method="dialog">${cancelButton}</form>${settingsLink}`,
    });
  }

  async function projectById(id: string): Promise<ProjectSummary> {
    const { projects } = await listProjects();
    const project = projects.find((candidate) => candidate.id === id);
    if (!project) throw new AtelierCoreError("project_not_found", `project not found: ${id}`);
    return project;
  }

  function jsonString(body: JsonObject, field: string): string {
    const value = body[field];
    if (!Value.Check(jsonStringSchema, value)) throw invalidArguments(`${field} is required`);
    return value;
  }

  function requiredJsonString(body: JsonObject, field: string): string {
    const value = jsonString(body, field);
    if (!value.trim()) throw invalidArguments(`${field} is required`);
    return value;
  }

  function optionalJsonString(body: JsonObject, field: string): string | undefined {
    const value = body[field];
    if (value === undefined) return undefined;
    if (!Value.Check(jsonStringSchema, value)) throw invalidArguments(`${field} must be a string`);
    return value;
  }

  async function projectDetailEndpoint(projectId: string): Promise<Response> {
    const project = await projectById(projectId);
    const [environment, secrets] = await Promise.all([
      listProjectEnvironmentVariables(projectId),
      listProjectSecrets(projectId),
    ]);
    return jsonResponse({ project: { ...project, environment, secrets } });
  }

  async function createProjectEndpoint(request: Request, url: URL): Promise<Response> {
    const json = requestAcceptsJson(request);
    const gitUrl = json
      ? requiredJsonString(await readJsonObject(request), "gitUrl")
      : String((await request.formData()).get("gitUrl") ?? "");
    let project: ProjectSummary;
    try {
      project = (await addProject(gitUrl)).project;
    } catch (error) {
      if (!(error instanceof AtelierCoreError && error.code === "project_exists")) throw error;
      const specification = parseProjectSpec(gitUrl);
      const projects = (await listProjects()).projects;
      project = projects.find((candidate) => candidate.gitUrl === specification.gitUrl && candidate.branch === specification.branch)!;
    }
    const paneStream = await deps.refreshWorkspacePaneCollections();
    if (json) return jsonResponse({ project });
    if (wantsTurboStream(request)) return turboStreamResponse(`${turboUpdateStream("project_editor_frame", "")}${paneStream}`);
    return Response.redirect(new URL("/", url).toString(), 303);
  }

  async function updateProjectEndpoint(projectId: string, request: Request): Promise<Response> {
    const json = requestAcceptsJson(request);
    let name: string;
    let spec: string;
    if (json) {
      const body = await readJsonObject(request);
      name = requiredJsonString(body, "name");
      spec = requiredJsonString(body, "gitUrl");
    } else {
      const formData = await request.formData();
      name = String(formData.get("name") ?? "");
      spec = String(formData.get("gitUrl") ?? "");
    }
    const { project } = await updateProject(projectId, { name, spec });
    const paneStream = await deps.refreshWorkspacePaneCollections();
    return json ? jsonResponse({ project }) : turboStreamResponse(paneStream);
  }

  async function renderProjectEnvironmentStreams(projectId: string): Promise<string> {
    const project = await projectById(projectId);
    return turboReplaceStream(domId("project_environment_fields", projectId), projectEnvironmentFields(project, await listProjectEnvironmentVariables(projectId)));
  }

  async function projectEnvironmentVariableValues(request: Request): Promise<{ name: string; value: string }> {
    if (!requestAcceptsJson(request)) {
      const formData = await request.formData();
      return { name: String(formData.get("name") ?? ""), value: String(formData.get("value") ?? "") };
    }
    const body = await readJsonObject(request);
    return { name: requiredJsonString(body, "name"), value: jsonString(body, "value") };
  }

  async function createProjectEnvironmentVariableEndpoint(projectId: string, request: Request): Promise<Response> {
    const json = requestAcceptsJson(request);
    const environmentVariable = await createProjectEnvironmentVariable(projectId, await projectEnvironmentVariableValues(request));
    return json ? jsonResponse({ environmentVariable }) : turboStreamResponse(await renderProjectEnvironmentStreams(projectId));
  }

  async function updateProjectEnvironmentVariableEndpoint(projectId: string, variableId: string, request: Request): Promise<Response> {
    const json = requestAcceptsJson(request);
    const environmentVariable = await updateProjectEnvironmentVariable(projectId, variableId, await projectEnvironmentVariableValues(request));
    return json ? jsonResponse({ environmentVariable }) : turboStreamResponse(await renderProjectEnvironmentStreams(projectId));
  }

  async function deleteProjectEnvironmentVariableEndpoint(projectId: string, variableId: string, request: Request): Promise<Response> {
    const json = requestAcceptsJson(request);
    if (json) await readJsonObject(request);
    const environmentVariable = await deleteProjectEnvironmentVariable(projectId, variableId);
    return json ? jsonResponse({ deleted: true, environmentVariable }) : turboStreamResponse(await renderProjectEnvironmentStreams(projectId));
  }

  async function renderProjectSecretStreams(projectId: string): Promise<string> {
    const project = await projectById(projectId);
    return turboReplaceStream(domId("project_secret_fields", projectId), projectSecretFields(project, await listProjectSecrets(projectId)));
  }

  type ProjectSecretValues = { envName: string; hostPattern: string; placeholder?: string; secretValue?: string };

  async function projectSecretValues(request: Request, secretValueRequired: boolean): Promise<ProjectSecretValues> {
    if (!requestAcceptsJson(request)) {
      const formData = await request.formData();
      return {
        envName: String(formData.get("envName") ?? ""),
        hostPattern: String(formData.get("hostPattern") ?? ""),
        placeholder: String(formData.get("placeholder") ?? ""),
        secretValue: String(formData.get("secretValue") ?? "") || undefined,
      };
    }
    const body = await readJsonObject(request);
    return {
      envName: requiredJsonString(body, "envName"),
      hostPattern: requiredJsonString(body, "hostPattern"),
      placeholder: optionalJsonString(body, "placeholder"),
      secretValue: secretValueRequired ? requiredJsonString(body, "secretValue") : optionalJsonString(body, "secretValue"),
    };
  }

  async function createProjectSecretEndpoint(projectId: string, request: Request): Promise<Response> {
    const json = requestAcceptsJson(request);
    const values = await projectSecretValues(request, true);
    const secret = await createProjectSecret(projectId, { ...values, secretValue: values.secretValue! });
    return json ? jsonResponse({ secret }) : turboStreamResponse(await renderProjectSecretStreams(projectId));
  }

  async function updateProjectSecretEndpoint(projectId: string, secretId: string, request: Request): Promise<Response> {
    const json = requestAcceptsJson(request);
    const secret = await updateProjectSecret(projectId, secretId, await projectSecretValues(request, false));
    return json ? jsonResponse({ secret }) : turboStreamResponse(await renderProjectSecretStreams(projectId));
  }

  async function deleteProjectSecretEndpoint(projectId: string, secretId: string, request: Request): Promise<Response> {
    const json = requestAcceptsJson(request);
    if (json) await readJsonObject(request);
    const secret = await deleteProjectSecret(projectId, secretId);
    return json ? jsonResponse({ deleted: true, secret }) : turboStreamResponse(await renderProjectSecretStreams(projectId));
  }

  async function renderProjectSshKeyStreams(projectId: string): Promise<string> {
    const project = await projectById(projectId);
    return turboReplaceStream(domId("project_ssh_key_fields", projectId), projectSshKeyFields(project, await listProjectSshKeys(projectId)));
  }

  async function createProjectSshKeyFromForm(projectId: string, request: Request): Promise<Response> {
    const formData = await request.formData();
    await createProjectSshKey(projectId, String(formData.get("privateKey") ?? ""));
    return turboStreamResponse(await renderProjectSshKeyStreams(projectId));
  }

  async function deleteProjectSshKeyFromForm(projectId: string, keyId: string): Promise<Response> {
    await deleteProjectSshKey(projectId, keyId);
    return turboStreamResponse(await renderProjectSshKeyStreams(projectId));
  }

  async function deleteProjectEndpoint(projectId: string, request: Request): Promise<Response> {
    const json = requestAcceptsJson(request);
    const project = await projectById(projectId);
    if (json) await readJsonObject(request);
    const references = deps.referencingWorkspaces(projectId);
    if (references.length > 0) {
      if (json) return jsonResponse({
        deleted: false,
        blocked: true,
        references,
      });
      return turboStreamResponse(turboReplaceStream(domId("project_delete_control", project.id), projectDeleteControl(project.id, references)), { status: 422 });
    }
    await deleteProject(projectId);
    const paneStream = await deps.refreshWorkspacePaneCollections();
    if (json) return jsonResponse({ deleted: true, blocked: false, project });
    return turboStreamResponse(`${turboUpdateStream("project_editor_frame", "")}${paneStream}`);
  }

  async function githubRepositorySearchEndpoint(url: URL): Promise<Response> {
    const query = url.searchParams.get("q") ?? "";
    try {
      const repositories = shouldSearchGitHubRepositories(query) ? await searchGitHubRepositories(query) : [];
      return new Response(renderGitHubRepositorySearchMenu(repositories, query), { headers: { "content-type": "text/html; charset=utf-8" } });
    } catch (error) {
      if (error instanceof GitHubRepositorySearchRateLimitError) return new Response(renderGitHubRepositorySearchRateLimitMenu(error), { status: 429, headers: { "content-type": "text/html; charset=utf-8" } });
      throw error;
    }
  }


  async function byReference(reference: string): Promise<ProjectSummary> {
    const { projects } = await listProjects();
    const byId = projects.find((project) => project.id === reference);
    if (byId) return byId;
    const byName = projects.filter((project) => project.name === reference);
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) throw invalidArguments(`project name is ambiguous: ${reference}`);
    throw new AtelierCoreError("project_not_found", `project not found: ${reference}`);
  }

  async function createProjectAgentWorkspaceEndpoint(projectId: string, request: Request): Promise<Response> {
    const project = await projectById(projectId);
    const accessProblem = await githubRepoAccessProblem(project);
    if (accessProblem) return turboStreamResponse(turboUpdateStream(deps.workspaceCommandModalHostId, githubRepoAccessProblemModal(project, accessProblem)));
    return await deps.createAgentWorkspace(project, request);
  }

  async function handle(request: Request, url: URL): Promise<Response | undefined> {
    if (url.pathname === "/projects" && request.method === "GET" && requestAcceptsJson(request)) return jsonResponse(await listProjects());
    if (url.pathname === "/projects" && request.method === "POST") return await createProjectEndpoint(request, url);
    if (url.pathname === "/projects/new/editor" && request.method === "GET") return response(newProjectEditorFrame());
    if (url.pathname === "/projects/github-search" && request.method === "GET") return await githubRepositorySearchEndpoint(url);

    const match = (pattern: RegExp): string[] | undefined => {
      const result = url.pathname.match(pattern);
      return result ? result.slice(1).map(decodeURIComponent) : undefined;
    };
    let params: string[] | undefined;
    if ((params = match(/^\/projects\/([^/]+)\/editor$/)) && request.method === "GET") return response(await projectEditorFrame(await projectById(params[0]!)));
    if ((params = match(/^\/projects\/([^/]+)\/launch-composer$/)) && request.method === "GET") return response(await deps.renderLaunchComposer(await projectById(params[0]!)));
    if ((params = match(/^\/projects\/([^/]+)$/)) && request.method === "GET" && requestAcceptsJson(request)) return await projectDetailEndpoint(params[0]!);
    if ((params = match(/^\/projects\/([^/]+)$/)) && request.method === "POST") return await updateProjectEndpoint(params[0]!, request);
    if ((params = match(/^\/projects\/([^/]+)\/environment$/)) && request.method === "POST") return await createProjectEnvironmentVariableEndpoint(params[0]!, request);
    if ((params = match(/^\/projects\/([^/]+)\/environment\/([^/]+)$/)) && request.method === "POST") return await updateProjectEnvironmentVariableEndpoint(params[0]!, params[1]!, request);
    if ((params = match(/^\/projects\/([^/]+)\/environment\/([^/]+)\/delete$/)) && request.method === "POST") return await deleteProjectEnvironmentVariableEndpoint(params[0]!, params[1]!, request);
    if ((params = match(/^\/projects\/([^/]+)\/secrets$/)) && request.method === "POST") return await createProjectSecretEndpoint(params[0]!, request);
    if ((params = match(/^\/projects\/([^/]+)\/secrets\/([^/]+)$/)) && request.method === "POST") return await updateProjectSecretEndpoint(params[0]!, params[1]!, request);
    if ((params = match(/^\/projects\/([^/]+)\/secrets\/([^/]+)\/delete$/)) && request.method === "POST") return await deleteProjectSecretEndpoint(params[0]!, params[1]!, request);
    if ((params = match(/^\/projects\/([^/]+)\/ssh-keys$/)) && request.method === "POST") return await createProjectSshKeyFromForm(params[0]!, request);
    if ((params = match(/^\/projects\/([^/]+)\/ssh-keys\/([^/]+)\/delete$/)) && request.method === "POST") return await deleteProjectSshKeyFromForm(params[0]!, params[1]!);
    if ((params = match(/^\/projects\/([^/]+)\/delete$/)) && request.method === "POST") return await deleteProjectEndpoint(params[0]!, request);
    if ((params = match(/^\/project-agent-workspaces\/([^/]+)$/)) && request.method === "POST") return await createProjectAgentWorkspaceEndpoint(params[0]!, request);
    return undefined;
  }

  return { handle, byReference, editorModal: projectEditorModal };
}
