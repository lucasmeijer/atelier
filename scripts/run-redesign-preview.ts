#!/usr/bin/env bun

import { resolve } from "node:path";
import type { JsonObject } from "@atelier/core";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

const previewNamespace = "atelier-redesign-preview";
const previewTitle = "Atelier redesign preview";
const previewFile = "/work/preview/atelier-redesign.md";
const previewTerminalTitle = "Changes · 2 files";
const baseUrl = "http://127.0.0.1:3000";
const repoRoot = resolve(new URL("..", import.meta.url).pathname);

const projectSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  gitUrl: Type.String(),
});

const workspaceSummarySchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  phase: Type.String(),
});

const workspaceStateSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  phase: Type.String(),
  url: Type.String(),
  tabs: Type.Array(Type.Object({
    key: Type.String(),
    label: Type.String(),
  })),
  layout: Type.Object({
    groups: Type.Array(Type.Object({
      id: Type.String(),
      tabs: Type.Array(Type.String()),
      visibleTab: Type.Optional(Type.String()),
    })),
  }),
});

const projectsResponseSchema = Type.Object({ projects: Type.Array(projectSchema) });
const workspaceCreatedResponseSchema = Type.Object({ workspace: Type.Object({ id: Type.String() }) });
const workspaceResponseSchema = Type.Object({ workspace: workspaceStateSchema });
const workspaceStatusResponseSchema = Type.Object({
  workspace: Type.Object({
    id: Type.String(),
    title: Type.String(),
    phase: Type.String(),
    url: Type.String(),
  }),
});
const workspacesResponseSchema = Type.Object({ workspaces: Type.Array(workspaceSummarySchema) });
type Project = Static<typeof projectSchema>;
type WorkspaceState = Static<typeof workspaceStateSchema>;

const fixture = `# Atelier workspace redesign preview

This isolated workspace keeps the current implementation visible while the redesign is developed.

## Destination

- A stable Agent pane on the left.
- A revealable Work pane on the right for terminals, browsers, File views, and Changes.
- File views and the review-only Changes view remain separate view types.
- Mobile gets a purpose-built single-surface navigation model.

## What this preview contains

- An Agent surface in the left group.
- File, browser, terminal, Files, and VS Code surfaces in the right group.
- One modified tracked file and this untracked file, ready for Changes review work.
`;

function gitRemote(): string {
  const result = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: repoRoot, stdout: "pipe", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error("could not determine the Atelier Git remote");
  return result.stdout.toString().trim();
}

async function api<const Schema extends TSchema>(path: string, schema: Schema, init?: RequestInit): Promise<Static<Schema>> {
  const headers = new Headers();
  headers.set("Accept", "application/json");
  if (init?.body) headers.set("Content-Type", "application/json");
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed (${response.status}): ${await response.text()}`);
  return Value.Parse(schema, await response.json());
}

async function postJson<const Schema extends TSchema>(path: string, schema: Schema, body?: JsonObject): Promise<Static<Schema>> {
  const init: RequestInit = { method: "POST" };
  if (body !== undefined) init.body = JSON.stringify(body);
  return await api(path, schema, init);
}

async function post(path: string, body?: JsonObject): Promise<void> {
  await postJson(path, Type.Unknown(), body);
}

async function waitForServer(server?: ReturnType<typeof Bun.spawn>): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server && server.exitCode !== null) throw new Error(`Atelier dev server exited with code ${server.exitCode}`);
    const response = await fetch(`${baseUrl}/up`).catch(() => undefined);
    if (response?.ok) return;
    await Bun.sleep(250);
  }
  throw new Error(`Atelier did not become ready at ${baseUrl} within 120 seconds`);
}

async function project(): Promise<Project> {
  const packageJson = await Bun.file(resolve(repoRoot, "package.json")).json() as { name: string };
  const projects = (await api("/projects", projectsResponseSchema)).projects;
  const existing = projects.find((candidate) => candidate.name === packageJson.name);
  if (existing) return existing;
  return (await postJson("/projects", Type.Object({ project: projectSchema }), { gitUrl: gitRemote() })).project;
}

async function workspace(projectId: string): Promise<WorkspaceState> {
  const summaries = (await api("/workspaces", workspacesResponseSchema)).workspaces;
  let workspaceId = summaries.find((candidate) => candidate.title === previewTitle)?.id;
  if (!workspaceId) {
    workspaceId = (await postJson("/workspaces", workspaceCreatedResponseSchema, {
      source: { type: "project", project: projectId },
      title: previewTitle,
    })).workspace.id;
  }

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const state = (await api(`/workspaces/${workspaceId}`, workspaceStatusResponseSchema)).workspace;
    if (state.phase === "ready") return Value.Parse(workspaceStateSchema, state);
    if (state.phase === "failed") throw new Error(`preview workspace failed to start`);
    await Bun.sleep(500);
  }
  throw new Error("preview workspace did not become ready within 120 seconds");
}

async function state(workspaceId: string): Promise<WorkspaceState> {
  return (await api(`/workspaces/${workspaceId}`, workspaceResponseSchema)).workspace;
}

async function createBrowser(workspaceId: string): Promise<void> {
  await post(`/workspaces/${workspaceId}/commands/browser.create`, { url: "https://github.com/lucasmeijer/atelier" });
}

function fixtureCommand(): string {
  const encoded = Buffer.from(fixture).toString("base64");
  const marker = "Preview fixture: modified for the review-only Changes view.";
  return [
    "mkdir -p preview",
    `printf %s '${encoded}' | base64 -d > preview/atelier-redesign.md`,
    `grep -Fq '${marker}' release_notes/2026-07-30-faster-tabs-and-layouts.md || printf '\\n${marker}\\n' >> release_notes/2026-07-30-faster-tabs-and-layouts.md`,
    "git status --short",
  ].join(" && ");
}

async function ensureWorkGroup(workspaceId: string): Promise<{ agentGroupId: string; workGroupId: string }> {
  let current = await state(workspaceId);
  const agentTab = current.tabs.find((tab) => tab.key.startsWith("agent:"));
  if (!agentTab) throw new Error("preview workspace has no Agent tab");
  let agentGroup = current.layout.groups.find((group) => group.tabs.includes(agentTab.key));
  if (!agentGroup) throw new Error("preview workspace Agent tab is not in a layout group");
  let workGroup = current.layout.groups.find((group) => group.id !== agentGroup!.id && !group.tabs.some((tab) => tab.startsWith("agent:")));

  if (!workGroup) {
    const browser = current.tabs.find((tab) => tab.key.startsWith("browser-"));
    if (browser) await post(`/workspaces/${workspaceId}/layout/move-tab`, { tab: browser.key, newGroup: true });
    else await createBrowser(workspaceId);
    current = await state(workspaceId);
    agentGroup = current.layout.groups.find((group) => group.tabs.includes(agentTab.key));
    workGroup = current.layout.groups.find((group) => group.id !== agentGroup!.id && !group.tabs.some((tab) => tab.startsWith("agent:")));
  }
  if (!agentGroup || !workGroup) throw new Error("could not establish Agent and Work layout groups");
  return { agentGroupId: agentGroup.id, workGroupId: workGroup.id };
}

async function waitForFixture(workspaceId: string): Promise<void> {
  const path = `/workspaces/${workspaceId}/file-editor/content?path=${encodeURIComponent(previewFile)}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}${path}`);
    if (response.ok) return;
    await Bun.sleep(250);
  }
  throw new Error("preview fixture file was not created within 30 seconds");
}

async function preparePreview(): Promise<string> {
  const previewProject = await project();
  const previewWorkspace = await workspace(previewProject.id);
  let current = await state(previewWorkspace.id);

  if (!current.tabs.some((tab) => tab.key.startsWith("browser-"))) await createBrowser(current.id);
  let groups = await ensureWorkGroup(current.id);
  current = await state(current.id);

  if (!current.tabs.some((tab) => tab.label === previewTerminalTitle)) {
    await post(`/workspaces/${current.id}/groups/${groups.workGroupId}/commands/terminal.create`, {
      title: previewTerminalTitle,
      command: fixtureCommand(),
    });
  }
  await waitForFixture(current.id);

  const openResponse = await fetch(`${baseUrl}/workspaces/${current.id}/file-editor/open?path=${encodeURIComponent(previewFile)}`, {
    headers: { Accept: "text/vnd.turbo-stream.html" },
  });
  if (!openResponse.ok) throw new Error(`opening preview file failed (${openResponse.status}): ${await openResponse.text()}`);

  groups = await ensureWorkGroup(current.id);
  current = await state(current.id);
  for (const tab of current.tabs) {
    const targetGroup = tab.key.startsWith("agent:") ? groups.agentGroupId : groups.workGroupId;
    const containingGroup = current.layout.groups.find((group) => group.tabs.includes(tab.key));
    if (containingGroup?.id !== targetGroup) await post(`/workspaces/${current.id}/layout/move-tab`, { tab: tab.key, toGroup: targetGroup });
  }

  current = await state(current.id);
  for (const group of current.layout.groups) {
    if (group.id !== groups.agentGroupId && group.id !== groups.workGroupId && group.tabs.length === 0) {
      await post(`/workspaces/${current.id}/groups/${group.id}/remove`);
    }
  }

  current = await state(current.id);
  const agentTab = current.tabs.find((tab) => tab.key.startsWith("agent:"))!;
  const fileTab = current.tabs.find((tab) => tab.key.startsWith("file-editor:"))!;
  await post(`/workspaces/${current.id}/view-state`, { groupId: groups.agentGroupId, visibleTab: agentTab.key });
  await post(`/workspaces/${current.id}/view-state`, { groupId: groups.workGroupId, visibleTab: fileTab.key });
  await post(`/workspaces/${current.id}/layout/resize`, { sizes: [0.56, 0.44] });
  return `${baseUrl}${current.url}`;
}

const prepareOnly = process.argv.includes("--prepare-only");
const server = prepareOnly ? undefined : Bun.spawn(["bun", "run", "web"], {
  cwd: repoRoot,
  env: { ...process.env, ATELIER_NAMESPACE: previewNamespace },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

try {
  await waitForServer(server);
  const previewUrl = await preparePreview();
  console.log(`\n[redesign-preview] ready: ${previewUrl}`);
  console.log(`[redesign-preview] namespace: ${previewNamespace}`);
  console.log("[redesign-preview] stop with Ctrl-C; rerun this command to restore the fixture\n");
  if (server) process.exit(await server.exited);
} catch (error) {
  server?.kill();
  throw error;
}
