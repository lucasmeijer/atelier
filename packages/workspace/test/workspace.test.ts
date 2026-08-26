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
  runWorkspaceSetupScript,
  setWorkspaceParked,
  setWorkspaceTitle,
  workspaceContainerName,
  getWorkspaceInit,
  type WorkspaceExecResult,
  type WorkspaceInitInstruction,
} from "@atelier/workspace";
import { nativeLinuxDockerPlatform, repositoryWorkspaceImageTag, resolveWorkspaceImage } from "@atelier/workspace-image";
import { registerProjectWorkspaceEvents, setGitIdentity } from "@atelier/projects";
import { cleanupNamespace, createTestNamespace, docker } from "./helpers.ts";

interface TestWorkspaceInitInstruction {
  type: "test.init";
  value: string;
}

declare module "@atelier/workspace" {
  interface WorkspaceInitInstructionMap {
    "test.init": TestWorkspaceInitInstruction;
  }
}

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

async function createDisposableWorkspace(options: Parameters<typeof createWorkspace>[0] = {}): Promise<Awaited<ReturnType<typeof createWorkspace>>> {
  return await createWorkspace(options);
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- The action's fulfillment value is intentionally discarded.
async function expectCoreError(action: () => Promise<unknown>): Promise<AtelierCoreError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(AtelierCoreError);
    if (error instanceof AtelierCoreError) return error;
    throw error;
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
  await cleanupNamespace(testNamespace);
});

describe("core workspaces", () => {
  test("listWorkspaces returns an empty list in a clean namespace", async () => {
    expect(await listWorkspaces()).toEqual({ workspaces: [] });
  });

  test("createWorkspace creates a workspace and listWorkspaces includes it with no title", async () => {
    const created = { id: await getReusableWorkspaceId() };

    expect(created.id).toMatch(/^[0-9a-f]{8}$/);
    expect((await listWorkspaces()).workspaces).toContainEqual({ id: created.id, title: null });
  });

  test("listWorkspaces marks a workspace when its project now resolves to a different image", async () => {
    const created = { id: await getReusableWorkspaceId() };
    const dockerfile = "FROM atelier-workspace\nENV ATELIER_IMAGE_TEST=" + crypto.randomUUID() + "\n";
    const expectedImage = repositoryWorkspaceImageTag(await resolveWorkspaceImage(), dockerfile);
    expect((await docker(["image", "inspect", expectedImage])).exitCode).not.toBe(0);
    await execWorkspaceCommand(created.id, ["sh", "-c", "mkdir -p .atelier && cat > .atelier/Dockerfile"], { stdin: dockerfile });

    expect((await listWorkspaces()).workspaces).toContainEqual({ id: created.id, title: null, imageOutdated: true });
    expect((await docker(["image", "inspect", expectedImage])).exitCode).not.toBe(0);

    await execWorkspaceShell(created.id, "rm .atelier/Dockerfile");
    expect((await listWorkspaces()).workspaces).toContainEqual({ id: created.id, title: null });
  });

  test("listWorkspaces does not build a missing carrier image", async () => {
    const created = { id: await getReusableWorkspaceId() };
    const defaultImage = await resolveWorkspaceImage();
    const preloadRef = "atelier-list-preload:" + crypto.randomUUID();
    expect((await docker(["tag", defaultImage, preloadRef])).exitCode).toBe(0);
    try {
      if (!await nativeLinuxDockerPlatform()) return;
      const carriersBefore = (await docker(["image", "ls", "--filter", "label=com.atelier.workspace-image.kind=carrier", "--quiet"])).stdout.trim();
      const manifest = JSON.stringify({ version: 1, docker: { privileged: true, preloadImages: [preloadRef] } });
      await execWorkspaceCommand(created.id, ["sh", "-c", "mkdir -p .atelier && cat > .atelier/workspace.json"], { stdin: manifest });

      expect((await listWorkspaces()).workspaces).toContainEqual({ id: created.id, title: null, imageOutdated: true });
      expect((await docker(["image", "ls", "--filter", "label=com.atelier.workspace-image.kind=carrier", "--quiet"])).stdout.trim()).toBe(carriersBefore);
    } finally {
      await execWorkspaceShell(created.id, "rm -f .atelier/workspace.json");
      await docker(["image", "rm", preloadRef]);
    }
  });

  test("setWorkspaceTitle sets the workspace title and listWorkspaces reflects it", async () => {
    const workspaceId = await getReusableWorkspaceId();

    expect(await setWorkspaceTitle(workspaceId, "Add dark mode toggle")).toBeNull();
    expect((await listWorkspaces()).workspaces).toContainEqual({ id: workspaceId, title: "Add dark mode toggle" });
  });

  test("setWorkspaceParked persists parked state and stops or starts the container", async () => {
    const created = { id: await getReusableWorkspaceId() };

    expect(await setWorkspaceParked(created.id, true)).toBeNull();
    expect((await listWorkspaces()).workspaces).toContainEqual({ id: created.id, title: "Add dark mode toggle", parked: true });
    expect((await docker(["inspect", "--format", "{{.State.Running}}", workspaceContainerName(created.id)])).stdout.trim()).toBe("false");

    expect(await setWorkspaceParked(created.id, false)).toBeNull();
    expect((await listWorkspaces()).workspaces).toContainEqual({ id: created.id, title: "Add dark mode toggle" });
    expect((await docker(["inspect", "--format", "{{.State.Running}}", workspaceContainerName(created.id)])).stdout.trim()).toBe("true");
  });

  test("createWorkspace persists init instructions", async () => {
    const init = { type: "test.init", value: "atelier" } satisfies WorkspaceInitInstruction;
    const created = await createDisposableWorkspace({ init });

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
    const created = { id: await getReusableWorkspaceId() };

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

  test("runWorkspaceSetupScript runs repository setup in an observable tmux session", async () => {
    const workspaceId = await getReusableWorkspaceId();
    const events = createAtelierEventBus();
    const steps: Array<{ terminal?: { kind: string; session: string }; output?: string }> = [];
    events.on("workspace_provision_step", (event) => { steps.push(event); });
    await execWorkspaceShell(workspaceId, "mkdir -p .atelier && printf '%s\\n' 'printf setup-visible-output' 'printf setup-ran > setup-marker' > .atelier/setup.sh");

    try {
      expect(await runWorkspaceSetupScript(workspaceId, { events })).toBe(true);
      expect((await execWorkspaceShell(workspaceId, "cat setup-marker")).stdout).toBe("setup-ran");
      expect(steps.some((step) => step.terminal?.kind === "host-tmux" && step.terminal.session.startsWith("atelier-provision-setup-"))).toBe(true);
      expect(steps.some((step) => step.output?.includes("setup-visible-output"))).toBe(true);
    } finally {
      await execWorkspaceShell(workspaceId, "rm -f .atelier/setup.sh setup-marker");
    }
  });

  test("createWorkspace can fork /work into a new container from the source image", async () => {
    const source = { id: await getReusableWorkspaceId() };
    const init = { type: "test.init", value: "fork" } satisfies WorkspaceInitInstruction;
    const write = await execWorkspaceShell(source.id, "printf forked > /work/copied.txt");
    expect(write.exitCode).toBe(0);
    const sourceImage = (await docker(["inspect", "--format", "{{.Image}}", workspaceContainerName(source.id)])).stdout.trim();

    const events = createAtelierEventBus();
    let sourcePrepareEmitted = false;
    let planContextFork: string | undefined;
    events.on("workspace_source_prepare", () => { sourcePrepareEmitted = true; });
    events.on("workspace_plan_prepare", ({ context }) => { planContextFork = context?.fork?.sourceWorkspaceId; });

    const fork = await createDisposableWorkspace({ init, context: { fork: { sourceWorkspaceId: source.id } }, fork: { sourceWorkspaceId: source.id }, events });
    const read = await execWorkspaceCommand(fork.id, ["cat", "/work/copied.txt"]);
    const forkImage = (await docker(["inspect", "--format", "{{.Image}}", workspaceContainerName(fork.id)])).stdout.trim();

    expect(read.exitCode).toBe(0);
    expect(read.stdout).toBe("forked");
    expect(sourcePrepareEmitted).toBe(false);
    expect(planContextFork).toBe(source.id);
    expect(forkImage).toBe(sourceImage);
    expect(await getWorkspaceInit(fork.id)).toEqual(init);
    await execWorkspaceShell(source.id, "rm copied.txt");
  });

  test("createWorkspace configures saved git identity", async () => {
    await setGitIdentity({ name: "Test User", email: "test@example.com" });
    const events = createAtelierEventBus();
    registerProjectWorkspaceEvents(events);
    const created = await createDisposableWorkspace({ events });

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

  test("deleteWorkspace removes the workspace and leaves its id inoperable", async () => {
    const created = await createDisposableWorkspace();
    const setup = await execWorkspaceCommand(created.id, ["sh", "-lc", "test \"$(id -u)\" = \"$ATELIER_HOST_UID\" && test \"$(id -g)\" = \"$ATELIER_HOST_GID\" && printf hello > owned-by-workspace-user.txt"]);
    expect(setup.exitCode).toBe(0);

    expect(await deleteWorkspace(created.id)).toBeNull();
    expect((await listWorkspaces()).workspaces.some((workspace) => workspace.id === created.id)).toBe(false);
    const error = await expectCoreError(() => execWorkspaceCommand(created.id, ["echo", "hello"]));
    expect(error.code).toBe("workspace_not_found");
  });

  test("deleteWorkspace fails with uncommitted changes unless forced", async () => {
    const created = await createDisposableWorkspace();
    const setup = await execWorkspaceCommand(created.id, ["sh", "-lc", "cd /work && git init && printf hello > changed.txt"]);
    expect(setup.exitCode).toBe(0);

    const events = createAtelierEventBus();
    registerProjectWorkspaceEvents(events);
    const error = await expectCoreError(() => deleteWorkspace(created.id, { events }));
    expect(error.code).toBe("workspace_delete_blocked");
    expect(error.message).toContain("changed.txt");

    expect(await deleteWorkspace(created.id, { force: true })).toBeNull();
  });

  test("deleteWorkspace reports changes inside initialized submodules", async () => {
    const created = await createDisposableWorkspace();
    const setup = await execWorkspaceShell(created.id, `set -eu
rm -rf /tmp/atelier-submodule-seed /tmp/atelier-submodule.git
mkdir /tmp/atelier-submodule-seed
git -C /tmp/atelier-submodule-seed init -b main
git -C /tmp/atelier-submodule-seed config user.name Test
git -C /tmp/atelier-submodule-seed config user.email test@example.com
printf original > /tmp/atelier-submodule-seed/tracked.txt
git -C /tmp/atelier-submodule-seed add tracked.txt
git -C /tmp/atelier-submodule-seed commit -m initial
git clone --bare /tmp/atelier-submodule-seed /tmp/atelier-submodule.git
git -C /work init -b main
git -C /work config user.name Test
git -C /work config user.email test@example.com
git -c protocol.file.allow=always -C /work submodule add /tmp/atelier-submodule.git deps/sub
git -C /work commit -m 'add submodule'
git -C /work/deps/sub config user.name Test
git -C /work/deps/sub config user.email test@example.com
printf committed > /work/deps/sub/tracked.txt
git -C /work/deps/sub add tracked.txt
git -C /work/deps/sub commit -m 'submodule work'
printf changed > /work/deps/sub/tracked.txt`);
    expect(setup.exitCode).toBe(0);

    const events = createAtelierEventBus();
    registerProjectWorkspaceEvents(events);
    const error = await expectCoreError(() => deleteWorkspace(created.id, { events }));
    expect(error.code).toBe("workspace_delete_blocked");
    expect(error.details).toEqual(expect.objectContaining({
      issues: expect.arrayContaining([expect.objectContaining({
        repo: "deps/sub",
        uncommittedPaths: ["tracked.txt"],
        outgoingCommits: [expect.objectContaining({ subject: "submodule work" })],
      })]),
    }));

    expect(await deleteWorkspace(created.id, { force: true })).toBeNull();
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

    const created = await createDisposableWorkspace({ id });
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
