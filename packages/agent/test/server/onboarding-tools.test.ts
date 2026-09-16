import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { addProject, projectWorkspaceInit, readProjectWorkspaceSettings, type GitProjectInitInstruction } from "@atelier/projects";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createOnboardingTools, createRegisteredOnboardingTools, configureOnboardingTools, type OnboardingToolDependencies } from "../../src/server/onboarding-tools.ts";
import { createTmuxBashTool } from "../../src/server/bash-tmux.ts";
import { createWorkspaceAgentTools } from "../../src/server/tools.ts";

async function execute(tool: ToolDefinition<any, any>, args: any, update?: (result: any) => void) {
  // SAFETY: These tools and the concrete tmux executor do not inspect Pi's ExtensionContext.
  return tool.execute("call", args, undefined, update, undefined as never);
}

describe("onboarding tool capabilities", () => {
  let dir: string;
  let previous: string | undefined;
  let source: GitProjectInitInstruction;
  let destination: GitProjectInitInstruction;
  let deps: OnboardingToolDependencies;
  const shell = mock(async (_workspaceId: string, command: string) => ({ stdout: command.includes(".exit") && command.startsWith("cat ") ? "0\n" : command.includes("capture-pane") ? "hello\n" : "", stderr: "", exitCode: 0, durationMs: 0 }));
  const create = mock<OnboardingToolDependencies["createWorkspace"]>(async () => ({ workspaceId: "child", url: "/workspaces/child", status: "ready", timings: { totalMs: 10, phases: [] } }));
  const remove = mock<OnboardingToolDependencies["deleteWorkspace"]>(async () => ({ deleted: true, blocked: false }));
  const secret = mock<OnboardingToolDependencies["requestSecretValue"]>(async (_projectId, request) => ({ status: "cancelled", envName: request.envName }));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atelier-onboarding-tools-"));
    previous = process.env.ATELIER_DATA_DIR;
    process.env.ATELIER_DATA_DIR = dir;
    source = projectWorkspaceInit((await addProject("https://github.com/example/app.git")).project);
    destination = { ...source, createdBy: { workspaceId: "parent", conversationId: "conversation" } };
    shell.mockClear(); create.mockClear(); secret.mockClear(); remove.mockClear();
    deps = {
      createWorkspace: create, requestSecretValue: secret, deleteWorkspace: remove,
      getWorkspaceInit: async (id) => id === "parent" ? source : id === "child" ? destination : undefined,
      createBashTool: (workspaceId) => createTmuxBashTool(workspaceId, shell),
    };
  });
  afterEach(async () => {
    if (previous === undefined) delete process.env.ATELIER_DATA_DIR;
    else process.env.ATELIER_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  function tool(name: string, conversationId = "conversation") {
    return createOnboardingTools("parent", conversationId, deps).find((tool) => tool.name === name)!;
  }

  test("all six tools are registered but absent from the default active set", () => {
    const createBashTool = mock(deps.createBashTool!);
    configureOnboardingTools({ ...deps, createBashTool });
    try {
      const group = createRegisteredOnboardingTools("parent", "conversation");
      expect(group.map((tool) => tool.name)).toEqual(["read_project_settings", "write_project_settings", "request_secret_value", "bash_in_other_workspace", "delete_workspace", "create_workspace"]);
      expect(createBashTool).toHaveBeenCalledTimes(1);
      const defaults = createWorkspaceAgentTools("parent").map((tool) => tool.name);
      for (const tool of group) expect(defaults).not.toContain(tool.name);
      expect(defaults).toContain("bash");
    } finally { configureOnboardingTools(undefined); }
    expect(createRegisteredOnboardingTools("parent", "conversation")).toEqual([]);
  });

  test("read and write use only the current workspace's project", async () => {
    const read = await execute(tool("read_project_settings"), {});
    expect(read.details.project.id).toBe(source.projectId);
    const settings = { dockerfile: "", preloadImages: ["redis:7"], environment: [] };
    const saved = await execute(tool("write_project_settings"), { expectedRevision: read.details.settingsRevision, settings });
    expect(saved.details.settings).toEqual(settings);
    await expect(execute(tool("write_project_settings"), { expectedRevision: read.details.settingsRevision, settings })).rejects.toThrow("configuration changed");
  });

  test("creation uses fixed repository identity, complete settings and durable creator identity", async () => {
    const initial = await readProjectWorkspaceSettings(source.projectId);
    const settings = { dockerfile: "", preloadImages: ["postgres:17"], environment: [] };
    const result = await execute(tool("create_workspace"), { title: "Comparison", expectedRevision: initial.settingsRevision, settings });
    expect(result.details.workspaceId).toBe("child");
    expect(create.mock.calls[0]?.[0]).toMatchObject({ projectId: source.projectId, gitUrl: source.gitUrl, settings, createdBy: { workspaceId: "parent", conversationId: "conversation" } });
    expect(create.mock.calls[0]?.[1]).toBe("Comparison");
    expect(await readProjectWorkspaceSettings(source.projectId)).toEqual(initial);
    expect(Value.Check(tool("create_workspace").parameters, { title: "Bad", expectedRevision: initial.settingsRevision, settings: { ...settings, gitUrl: "https://other.example/repo" } })).toBe(false);
    expect(Value.Check(tool("create_workspace").parameters, { title: "Bad", expectedRevision: initial.settingsRevision, settings: { preloadImages: [] } })).toBe(false);
  });

  test("remote bash shares normal bash instructions, arguments, execution and result details", async () => {
    const remote = tool("bash_in_other_workspace");
    const normal = createTmuxBashTool("parent", shell);
    expect(remote.description).toContain(normal.description);
    expect(remote.parameters.properties.command).toEqual(normal.parameters.properties.command);
    expect(remote.parameters.properties.timeout).toEqual(normal.parameters.properties.timeout);
    expect(Value.Check(remote.parameters, { command: "pwd" })).toBe(false);
    const updates: any[] = [];
    const result = await execute(remote, { workspace_id: "child", command: "printf hello", timeout: 20 }, (update) => updates.push(update));
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
    expect(result.details).toMatchObject({ workspaceId: "child", exitCode: 0, aborted: false, timedOut: false, displayAnsi: "hello" });
    expect(updates[0]?.details.workspaceId).toBe("child");
    expect(updates[0]?.details.tmuxSession).toStartWith("atelier-agent-");
    expect(shell.mock.calls.every(([id]) => id === "child")).toBe(true);
    expect(shell.mock.calls.find(([, command]) => command.includes("new-session"))?.[1]).toContain("unset NO_COLOR");
  });

  test("remote bash rejects self, unknown workspaces, other conversations and other projects before execution", async () => {
    for (const id of ["parent", "unknown"]) await expect(execute(tool("bash_in_other_workspace"), { workspace_id: id, command: "touch /work/oops" })).rejects.toThrow("only execute bash");
    await expect(execute(tool("bash_in_other_workspace", "other-agent"), { workspace_id: "child", command: "pwd" })).rejects.toThrow("only execute bash");
    destination = { ...destination, projectId: "other-project" };
    await expect(execute(tool("bash_in_other_workspace"), { workspace_id: "child", command: "pwd" })).rejects.toThrow("only execute bash");
    expect(shell).not.toHaveBeenCalled();
  });

  test("deletion delegates safety checks and returns the host result", async () => {
    destination = JSON.parse(JSON.stringify(destination));
    for (const force of [false, true]) {
      const response = await execute(tool("delete_workspace"), { workspace_id: "child", force });
      expect(remove).toHaveBeenLastCalledWith("child", force);
      expect(response.details).toEqual({ deleted: true, blocked: false });
    }
    expect(Value.Check(tool("delete_workspace").parameters, { force: false })).toBe(false);
  });

  test("deletion rejects targets not created by this conversation for this project", async () => {
    for (const id of ["parent", "unknown"]) await expect(execute(tool("delete_workspace"), { workspace_id: id, force: true })).rejects.toThrow("only delete");
    await expect(execute(tool("delete_workspace", "other-agent"), { workspace_id: "child", force: true })).rejects.toThrow("only delete");
    for (const target of [
      { ...destination, projectId: "other-project" },
      { ...destination, createdBy: { workspaceId: "other-parent", conversationId: "conversation" } },
      { ...destination, createdBy: undefined },
    ]) {
      destination = target;
      await expect(execute(tool("delete_workspace"), { workspace_id: "child", force: true })).rejects.toThrow("only delete");
    }
    deps.getWorkspaceInit = async () => undefined;
    await expect(execute(tool("delete_workspace"), { workspace_id: "child", force: true })).rejects.toThrow("does not belong to a project");
    expect(remove).not.toHaveBeenCalled();
  });

  test("a recreated tool instance retains access via persisted workspace creator metadata", async () => {
    destination = JSON.parse(JSON.stringify(destination));
    await execute(tool("bash_in_other_workspace"), { workspace_id: "child", command: "pwd" });
    await execute(tool("bash_in_other_workspace"), { workspace_id: "child", command: "pwd" });
    expect(shell).toHaveBeenCalled();
  });

  test("secret input is delegated to the secure project flow and never accepts a value", async () => {
    const request = { envName: "TOKEN", hostPattern: "api.example.com", purpose: "Run integration checks" };
    const result = await execute(tool("request_secret_value"), request);
    expect(secret.mock.calls[0]?.slice(0, 2)).toEqual([source.projectId, request]);
    expect(result.details.status).toBe("cancelled");
    expect(Value.Check(tool("request_secret_value").parameters, { ...request, secretValue: "oops" })).toBe(false);
  });

  test("projectless callers are rejected before any host operation", async () => {
    deps.getWorkspaceInit = async () => undefined;
    await expect(execute(tool("read_project_settings"), {})).rejects.toThrow("does not belong to a project");
    await expect(execute(tool("request_secret_value"), { envName: "TOKEN", hostPattern: "api.example.com", purpose: "test" })).rejects.toThrow("does not belong to a project");
    expect(secret).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
