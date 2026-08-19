#!/usr/bin/env bun

import { resolve } from "node:path";
import type { JsonObject } from "@atelier/core";

const previewNamespace = "atelier-redesign-preview";
const previewTitle = "Atelier redesign preview";
const retiredPreviewFile = "/work/preview/atelier-redesign.md";
const previewTerminalTitle = "Terminal";
const baseUrl = "http://127.0.0.1:3000";
const repoRoot = resolve(new URL("..", import.meta.url).pathname);

interface WorkspaceSummary { id: string; title: string; phase: string }
interface WorkView { reference: { type: string; path?: string; browserId?: string; terminalId?: string; title?: string }; attention: boolean }
interface WorkspaceState {
  id: string;
  title: string;
  phase: string;
  url: string;
  agentConversations?: Array<{ id: string; title: string }>;
  workViews?: WorkView[];
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers({ Accept: "application/json" });
  if (init?.body) headers.set("Content-Type", "application/json");
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed (${response.status}): ${await response.text()}`);
  // SAFETY: The module boundary validates or constructs this value with the asserted domain shape.
  return await response.json() as T;
}

async function post<T>(path: string, body: JsonObject = {}): Promise<T> {
  return await api<T>(path, { method: "POST", body: JSON.stringify(body) });
}

async function waitForServer(server?: ReturnType<typeof Bun.spawn>): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server && server.exitCode !== null) throw new Error(`Atelier dev server exited with code ${server.exitCode}`);
    if ((await fetch(`${baseUrl}/up`).catch(() => undefined))?.ok) return;
    await Bun.sleep(250);
  }
  throw new Error(`Atelier did not become ready at ${baseUrl} within 120 seconds`);
}

async function workspace(): Promise<WorkspaceState> {
  const summaries = (await api<{ workspaces: WorkspaceSummary[] }>("/workspaces")).workspaces;
  const summary = summaries.find((candidate) => candidate.title === previewTitle && candidate.phase !== "failed")
    ?? (await post<{ workspace: WorkspaceState }>("/workspaces", { source: { type: "empty" }, title: previewTitle })).workspace;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const state = (await api<{ workspace: WorkspaceState }>(`/workspaces/${summary.id}`)).workspace;
    if (state.phase === "ready") return state;
    if (state.phase === "failed") throw new Error("preview workspace failed to start");
    await Bun.sleep(500);
  }
  throw new Error("preview workspace did not become ready within 120 seconds");
}

async function state(workspaceId: string): Promise<WorkspaceState> {
  return (await api<{ workspace: WorkspaceState }>(`/workspaces/${workspaceId}`)).workspace;
}

async function preparePreview(): Promise<string> {
  const previewWorkspace = await workspace();
  let current = await state(previewWorkspace.id);
  const retiredFixtureOpen = current.workViews?.some((view) => view.reference.type === "file" && view.reference.path === retiredPreviewFile) ?? false;
  if (retiredFixtureOpen) {
    for (const view of current.workViews?.filter((candidate) => candidate.reference.type === "file" || candidate.reference.type === "terminal") ?? []) {
      await post(`/workspaces/${current.id}/work-views/close`, { reference: view.reference });
    }
    current = await state(current.id);
  }
  const has = (type: string) => current.workViews?.some((view) => view.reference.type === type) ?? false;

  if (!has("browser")) await post(`/workspaces/${current.id}/commands/browser.create`, { url: "https://github.com/lucasmeijer/atelier" });
  if (!has("terminal")) await post(`/workspaces/${current.id}/commands/terminal.create`, { title: previewTerminalTitle });
  if (!has("files")) await post(`/workspaces/${current.id}/commands/files.open`);
  if (!has("vscode")) await post(`/workspaces/${current.id}/commands/vscode.open`);

  current = await state(current.id);
  const browser = current.workViews?.find((view) => view.reference.type === "browser");
  if (!browser?.reference.browserId) throw new Error("preview Browser Work view was not opened");
  const destination = `browser:${browser.reference.browserId}`;
  return `${baseUrl}${current.url}?${new URLSearchParams({ workView: destination })}`;
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
