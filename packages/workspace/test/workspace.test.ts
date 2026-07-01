import { describe, expect, setDefaultTimeout, test, beforeAll, afterAll } from "bun:test";
import { AtelierCoreError, createAtelierEventBus } from "@atelier/core";
import {
  createWorkspace,
  deleteWorkspace,
  execWorkspaceCommand,
  execWorkspaceCommandBuffer,
  execWorkspaceShell,
  generateWorkspaceId,
  listWorkspaces,
  setWorkspaceParked,
  setWorkspaceTitle,
  workspaceContainerName,
  getWorkspaceInit,
  type WorkspaceExecResult,
  type WorkspaceInitInstruction,
} from "@atelier/workspace";
import { resolveWorkspaceImage } from "@atelier/workspace-image";
import { registerProjectWorkspaceEvents, setGitIdentity } from "@atelier/projects";
import { cleanupNamespace, createTestNamespace, docker } from "./helpers.ts";

// The first workspace-image build is intentionally heavy: it installs VS Code,
// prewarms the VS Code server, and installs large extensions. On a cold Docker
// cache this regularly takes several minutes, so keep the integration-test
// timeout above the image build's own 120s VS Code prewarm watchdog.
setDefaultTimeout(300_000);

const testNamespace = createTestNamespace("test-workspace");
let reusableWorkspaceId: string | undefined;

async function getReusableWorkspaceId(): Promise<string> {
  reusableWorkspaceId ??= (await createWorkspace()).id;
  return reusableWorkspaceId;
}

async function expectCoreError(action: () => Promise<unknown>): Promise<AtelierCoreError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(AtelierCoreError);
    return error as AtelierCoreError;
  }
  throw new Error("expected AtelierCoreError");
}

beforeAll(async () => {
  process.env.ATELIER_NAMESPACE = testNamespace;
  await cleanupNamespace(testNamespace);
  // Build/resolve the deterministic workspace image once for this namespace.
  // Without this warm-up, the first createWorkspace() assertion races the cold
  // image build and can hit the per-test timeout, which cancels Docker buildx
  // and causes cascading failures that look like Docker hangs.
  await resolveWorkspaceImage({ workspaceId: "test-suite-bootstrap" });
});

afterAll(async () => {
  if (reusableWorkspaceId) await deleteWorkspace(reusableWorkspaceId, { force: true }).catch(() => null);
  await cleanupNamespace(testNamespace);
});

describe("core workspaces", () => {
  test("listWorkspaces returns an empty list in a clean namespace", async () => {
    expect(await listWorkspaces()).toEqual({ workspaces: [] });
  });

  test("createWorkspace creates a workspace and listWorkspaces includes it with no title", async () => {
    const created = await createWorkspace();

    expect(created.id).toMatch(/^[0-9a-f]{8}$/);
    expect((await listWorkspaces()).workspaces).toContainEqual({ id: created.id, title: null });
  });

  test("setWorkspaceTitle sets the workspace title and listWorkspaces reflects it", async () => {
    const workspaceId = await getReusableWorkspaceId();

    expect(await setWorkspaceTitle(workspaceId, "Add dark mode toggle")).toBeNull();
    expect((await listWorkspaces()).workspaces).toContainEqual({ id: workspaceId, title: "Add dark mode toggle" });
  });

  test("setWorkspaceParked sets parked state and listWorkspaces reflects it", async () => {
    const created = await createWorkspace();

    expect(await setWorkspaceParked(created.id, true)).toBeNull();
    expect((await listWorkspaces()).workspaces).toContainEqual({ id: created.id, title: null, parked: true });

    expect(await setWorkspaceParked(created.id, false)).toBeNull();
    expect((await listWorkspaces()).workspaces).toContainEqual({ id: created.id, title: null });
  });

  test("createWorkspace persists init instructions", async () => {
    const init = { type: "test.init", value: "atelier" } as unknown as WorkspaceInitInstruction;
    const created = await createWorkspace({ init });

    expect((await listWorkspaces()).workspaces).toContainEqual({ id: created.id, title: null, init });
    expect(await getWorkspaceInit(created.id)).toEqual(init);
  });

  test("execWorkspaceCommand captures stdout, stderr, exit code, and duration", async () => {
    const workspaceId = await getReusableWorkspaceId();

    const exec = await execWorkspaceCommand(workspaceId, ["sh", "-c", "printf hello && printf error >&2"]);

    expect(exec.exitCode).toBe(0);
    expect(exec.stdout).toBe("hello");
    expect(exec.stderr).toBe("error");
    expect(exec.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("execWorkspaceCommandBuffer captures stdout bytes", async () => {
    const created = await createWorkspace();

    const exec = await execWorkspaceCommandBuffer(created.id, ["sh", "-c", "printf '\\000\\377'"]);

    expect(exec.exitCode).toBe(0);
    expect([...exec.stdout]).toEqual([0, 255]);
    expect(exec.stderr).toBe("");
    expect(exec.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("execWorkspaceCommand runs commands as the non-root atelier user", async () => {
    const workspaceId = await getReusableWorkspaceId();

    const exec = await execWorkspaceCommand(workspaceId, ["whoami"]);

    expect(exec.exitCode).toBe(0);
    expect(exec.stdout.trim()).toBe("atelier");
    expect(exec.stderr).toBe("");
  });

  test("execWorkspaceShell passes stdin into docker exec commands", async () => {
    const workspaceId = await getReusableWorkspaceId();

    const write = await execWorkspaceShell(workspaceId, "cat > /work/stdin.txt", { stdin: "hello from stdin" });
    const read = await execWorkspaceCommand(workspaceId, ["cat", "/work/stdin.txt"]);

    expect(write.exitCode).toBe(0);
    expect(read.exitCode).toBe(0);
    expect(read.stdout).toBe("hello from stdin");
  });

  test("createWorkspace can fork /work into a new container from the source image", async () => {
    const source = await createWorkspace();
    const init = { type: "test.init", value: "fork" } as unknown as WorkspaceInitInstruction;
    const write = await execWorkspaceShell(source.id, "printf forked > /work/copied.txt");
    expect(write.exitCode).toBe(0);
    const sourceImage = (await docker(["inspect", "--format", "{{.Image}}", workspaceContainerName(source.id)])).stdout.trim();

    const events = createAtelierEventBus();
    let sourcePrepareEmitted = false;
    let planContextFork: string | undefined;
    events.on("workspace_source_prepare", () => { sourcePrepareEmitted = true; });
    events.on("workspace_plan_prepare", ({ context }) => { planContextFork = context?.fork?.sourceWorkspaceId; });

    const fork = await createWorkspace({ init, context: { fork: { sourceWorkspaceId: source.id } }, fork: { sourceWorkspaceId: source.id }, events });
    const read = await execWorkspaceCommand(fork.id, ["cat", "/work/copied.txt"]);
    const forkImage = (await docker(["inspect", "--format", "{{.Image}}", workspaceContainerName(fork.id)])).stdout.trim();

    expect(read.exitCode).toBe(0);
    expect(read.stdout).toBe("forked");
    expect(sourcePrepareEmitted).toBe(false);
    expect(planContextFork).toBe(source.id);
    expect(forkImage).toBe(sourceImage);
    expect(await getWorkspaceInit(fork.id)).toEqual(init);
  });

  test("createWorkspace configures saved git identity", async () => {
    await setGitIdentity({ name: "Test User", email: "test@example.com" });
    const events = createAtelierEventBus();
    registerProjectWorkspaceEvents(events);
    const created = await createWorkspace({ events });

    const exec = await execWorkspaceCommand(created.id, ["git", "config", "--global", "--get-regexp", "^user\\."]);

    expect(exec.exitCode).toBe(0);
    expect(exec.stdout).toContain("user.name Test User");
    expect(exec.stdout).toContain("user.email test@example.com");
  });

  test("execWorkspaceCommand returns child command failure as a successful exec result", async () => {
    const workspaceId = await getReusableWorkspaceId();

    const exec = await execWorkspaceCommand(workspaceId, ["sh", "-c", "exit 7"]);

    expect(exec.exitCode).toBe(7);
    expect(exec.stdout).toBe("");
    expect(exec.stderr).toBe("");
    expect(exec.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("deleteWorkspace removes the workspace", async () => {
    const created = await createWorkspace();

    expect(await deleteWorkspace(created.id)).toBeNull();
    expect((await listWorkspaces()).workspaces.some((workspace) => workspace.id === created.id)).toBe(false);
  });

  test("workspace user matches the host user configured for the bind mount", async () => {
    const created = await createWorkspace();
    const setup = await execWorkspaceCommand(created.id, ["sh", "-lc", "test \"$(id -u)\" = \"$ATELIER_HOST_UID\" && test \"$(id -g)\" = \"$ATELIER_HOST_GID\" && printf hello > owned-by-workspace-user.txt"]);
    expect(setup.exitCode).toBe(0);

    expect(await deleteWorkspace(created.id)).toBeNull();
    expect((await listWorkspaces()).workspaces.some((workspace) => workspace.id === created.id)).toBe(false);
  });

  test("deleteWorkspace fails with uncommitted changes unless forced", async () => {
    const created = await createWorkspace();
    const setup = await execWorkspaceCommand(created.id, ["sh", "-lc", "cd /work && git init && printf hello > changed.txt"]);
    expect(setup.exitCode).toBe(0);

    const events = createAtelierEventBus();
    registerProjectWorkspaceEvents(events);
    const error = await expectCoreError(() => deleteWorkspace(created.id, { events }));
    expect(error.code).toBe("workspace_delete_blocked");
    expect(error.message).toContain("changed.txt");

    expect(await deleteWorkspace(created.id, { force: true })).toBeNull();
  });

  test("execWorkspaceCommand on a deleted workspace throws workspace_not_found", async () => {
    const created = await createWorkspace();
    await deleteWorkspace(created.id);

    const error = await expectCoreError(() => execWorkspaceCommand(created.id, ["echo", "hello"]));
    expect(error.code).toBe("workspace_not_found");
  });

  test("workspace ids are scoped to ATELIER_NAMESPACE", async () => {
    const currentNamespace = process.env.ATELIER_NAMESPACE;
    const otherNamespace = `${testNamespace}-other`;
    process.env.ATELIER_NAMESPACE = otherNamespace;
    const created = await createWorkspace();

    try {
      process.env.ATELIER_NAMESPACE = currentNamespace;
      expect((await listWorkspaces()).workspaces.some((workspace) => workspace.id === created.id)).toBe(false);

      process.env.ATELIER_NAMESPACE = otherNamespace;
      expect((await listWorkspaces()).workspaces).toContainEqual({ id: created.id, title: null });

      process.env.ATELIER_NAMESPACE = currentNamespace;
      const error = await expectCoreError(() => deleteWorkspace(created.id));
      expect(error.code).toBe("workspace_not_found");
    } finally {
      process.env.ATELIER_NAMESPACE = otherNamespace;
      await deleteWorkspace(created.id).catch(() => null);
      await cleanupNamespace(otherNamespace);
      process.env.ATELIER_NAMESPACE = currentNamespace;
    }
  });

  test("execWorkspaceCommand rejects an empty command", async () => {
    const workspaceId = await getReusableWorkspaceId();

    const error = await expectCoreError(() => execWorkspaceCommand(workspaceId, []));
    expect(error.code).toBe("invalid_arguments");
  });

  test("createWorkspace uses the supplied app-generated id for container name and label", async () => {
    const id = generateWorkspaceId();

    const created = await createWorkspace({ id });
    expect(created.id).toBe(id);

    const inspected = await docker(["inspect", "--format", `{{.Name}}\t{{index .Config.Labels "com.atelier.workspace-id"}}`, workspaceContainerName(id)]);
    expect(inspected.exitCode).toBe(0);
    expect(inspected.stdout.trim()).toBe(`/${workspaceContainerName(id)}\t${id}`);

    expect((await listWorkspaces()).workspaces).toContainEqual({ id, title: null });
  });

  test("listWorkspaces falls back to the container id prefix for legacy containers without a workspace-id label", async () => {
    const image = await resolveWorkspaceImage();
    const run = await docker([
      "run", "-d",
      "--label", "com.atelier.type=workspace",
      "--label", `com.atelier.namespace=${testNamespace}`,
      image,
      "sleep", "infinity",
    ]);
    expect(run.exitCode).toBe(0);
    const fullId = run.stdout.trim();
    const legacyId = fullId.slice(0, 8);
    // Legacy createWorkspace renamed containers to atelier-<id prefix>.
    expect((await docker(["rename", fullId, workspaceContainerName(legacyId)])).exitCode).toBe(0);

    expect((await listWorkspaces()).workspaces).toContainEqual({ id: legacyId, title: null });
    // And the legacy workspace stays operable through the container-name convention.
    expect(await setWorkspaceTitle(legacyId, "Legacy")).toBeNull();
    expect((await listWorkspaces()).workspaces).toContainEqual({ id: legacyId, title: "Legacy" });
  });
});
