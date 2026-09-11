import { describe, expect, setDefaultTimeout, test, beforeAll, afterAll } from "bun:test";
import { AtelierCoreError, atelierDataPath, getAtelierRuntimeContext, createAtelierEventBus } from "@atelier/core";
import {
  checkWorkspaceGateway,
  setWorkspaceContainerRunning,
  createWorkspace,
  workspacePortBackend,
  deleteWorkspace,
  execWorkspaceCommand,
  execWorkspaceCommandBuffer,
  execWorkspaceShell,
  generateWorkspaceId,
  listWorkspaces,
  runWorkspaceSetupScript,
  setWorkspaceParked,
  setWorkspaceTitle,
  getWorkspaceTitle,
  workspaceContainerName,
  getWorkspaceInit,
  type WorkspaceExecResult,
  type WorkspaceInitInstruction,
} from "@atelier/workspace";
import { workspaceGatewayPort, workspaceGatewayTokenHeader, workspaceGatewayPortHeader, workspaceGatewayProtocolHeader, workspaceGatewayHostHeader } from "@atelier/shared";
import { repositoryWorkspaceImageTag, resolveWorkspaceImage } from "@atelier/workspace-image";
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
const dockerHost = await docker(["info", "--format", "{{.OperatingSystem}}|{{.OSType}}"]);
expect(dockerHost.exitCode, dockerHost.stderr).toBe(0);
const [operatingSystem, osType] = dockerHost.stdout.trim().split("|");
const nativeDockerTest = osType === "linux" && !/docker desktop/i.test(operatingSystem!) ? test : test.skip;
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

  test("startup failure waits for confirmation and preserves the container for repair", async () => {
    const events = createAtelierEventBus();
    const id = generateWorkspaceId();
    const paused = Promise.withResolvers<void>();
    const continuation = Promise.withResolvers<void>();
    const observed: Array<{ id: string; awaitingContinue?: boolean; error?: string; status?: string }> = [];
    events.on("workspace_plan_prepare", ({ plan }) => {
      plan.initScripts.push("echo 'intentional startup failure' >&2; exit 23");
    });
    events.on("workspace_provision_step", (event) => {
      observed.push(event);
      if (event.id === "workspace.startup" && event.awaitingContinue) paused.resolve();
    });
    let completed = false;
    const creation = createWorkspace({ id, events, waitForContinue(stepId) {
      expect(stepId).toBe("workspace.startup");
      return continuation.promise;
    } }).then((result) => { completed = true; return result; });
    try {
      await Promise.race([paused.promise, creation.then(() => { throw new Error("creation did not pause"); })]);
      expect(completed).toBe(false);
      const running = await docker(["inspect", "--format", "{{.State.Running}}", workspaceContainerName(id)]);
      expect(running.stdout.trim()).toBe("true");
      expect(observed).toContainEqual(expect.objectContaining({ id: "workspace.startup", status: "failed", awaitingContinue: true, error: expect.stringContaining("intentional startup failure") }));
      continuation.resolve();
      expect((await creation).startupError).toContain("intentional startup failure");
      expect(observed).toContainEqual(expect.objectContaining({ id: "workspace.startup", status: "failed", awaitingContinue: false }));
      expect((await execWorkspaceShell(id, "printf repair-shell")).stdout).toBe("repair-shell");
    } finally {
      continuation.resolve();
      await creation;
      await deleteWorkspace(id, { force: true });
    }
  });

  test("publishes only the gateway and reaches loopback-only apps on arbitrary ports", async () => {
    const id = await getReusableWorkspaceId();
    const published = await docker(["port", workspaceContainerName(id)]);
    expect(published.exitCode).toBe(0);
    expect(published.stdout.trim()).toMatch(new RegExp(`^${workspaceGatewayPort}/tcp -> 127\\.0\\.0\\.1:[0-9]+$`));
    const startApp = () => execWorkspaceShell(id, `printf 'gateway proof' > /tmp/gateway-proof.txt
      tmux new-session -d -s gateway-proof 'python3 -m http.server 5173 --bind 127.0.0.1 --directory /tmp'
      for attempt in $(seq 1 100); do
        if curl -fsS http://127.0.0.1:5173/gateway-proof.txt; then exit 0; fi
        sleep 0.05
      done
      exit 1`);
    const started = await startApp();
    expect(started.exitCode, started.stderr).toBe(0);
    try {
      const backend = await workspacePortBackend(id, 5173, "/gateway-proof.txt");
      expect(backend.target.toString()).toBe("http://127.0.0.1:5173/gateway-proof.txt");
      const gateway = backend.gateway!;
      const response = await fetch(new URL(backend.target.pathname, gateway.url), {
        proxy: gateway.url.toString(),
        headers: {
          [workspaceGatewayTokenHeader]: gateway.token,
          [workspaceGatewayPortHeader]: "5173",
          [workspaceGatewayProtocolHeader]: "http",
          [workspaceGatewayHostHeader]: "preview.example",
        },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("gateway proof");
      const denied = await fetch(gateway.url, { proxy: gateway.url.toString() });
      expect(denied.status).toBe(401);
      await denied.text();
      const credentialMode = await execWorkspaceShell(id, "stat -c '%U:%a' /etc/atelier-workspace-gateway-token", { user: "root" });
      expect(credentialMode.stdout.trim()).toBe("root:600");
      const init = await docker(["inspect", "--format", "{{.HostConfig.Init}}", workspaceContainerName(id)]);
      expect(init.stdout.trim()).toBe("true");
      await setWorkspaceParked(id, true);
      await setWorkspaceParked(id, false);
      const restarted = await startApp();
      expect(restarted.exitCode, restarted.stderr).toBe(0);
      const resumed = await workspacePortBackend(id, 5173, "/gateway-proof.txt");
      expect(resumed.gateway!.token).toBe(gateway.token);
      expect(resumed.gateway!.url.toString()).toBe(gateway.url.toString());
      const liveBinding = await docker(["port", workspaceContainerName(id), `${workspaceGatewayPort}/tcp`]);
      expect(resumed.gateway!.url.host).toBe(liveBinding.stdout.trim());
      await checkWorkspaceGateway(id);
      const resumedResponse = await fetch(new URL(resumed.target.pathname, resumed.gateway!.url), {
        proxy: resumed.gateway!.url.toString(),
        headers: {
          [workspaceGatewayTokenHeader]: resumed.gateway!.token,
          [workspaceGatewayPortHeader]: "5173",
          [workspaceGatewayProtocolHeader]: "http",
          [workspaceGatewayHostHeader]: "preview.example",
        },
      });
      expect(resumedResponse.status).toBe(200);
      expect(await resumedResponse.text()).toBe("gateway proof");
      // An unplanned gateway exit must not change the host port behind the cache.
      const stoppedGateway = await execWorkspaceShell(id, "pkill -TERM -x atelier-workspa", { user: "root" });
      expect(stoppedGateway.exitCode).toBe(0);
      let running = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const state = await docker(["inspect", "--format", "{{.RestartCount}} {{.State.Running}}", workspaceContainerName(id)]);
        if (state.stdout.trim() === "1 true") { running = true; break; }
        await Bun.sleep(100);
      }
      expect(running).toBe(true);
      const afterCrash = await docker(["port", workspaceContainerName(id), `${workspaceGatewayPort}/tcp`]);
      expect(afterCrash.stdout.trim()).toBe(gateway.url.host);
      const configured = await docker(["inspect", "--format", `{{(index .HostConfig.PortBindings "${workspaceGatewayPort}/tcp" 0).HostPort}}`, workspaceContainerName(id)]);
      expect(configured.stdout.trim()).toBe(gateway.url.port);
      const readyAgain = await execWorkspaceShell(id, `for attempt in $(seq 1 100); do
        if test -f /.atelier/ready && test "$(curl --noproxy '*' --silent --max-time 1 --output /dev/null --write-out '%{http_code}' http://127.0.0.1:${workspaceGatewayPort}/)" = 401; then exit 0; fi
        sleep 0.05
      done
      exit 1`, { user: "root" });
      expect(readyAgain.exitCode, readyAgain.stderr).toBe(0);
      const appAgain = await startApp();
      expect(appAgain.exitCode, appAgain.stderr).toBe(0);
      const afterCrashResponse = await fetch(new URL(backend.target.pathname, gateway.url), {
        proxy: gateway.url.toString(),
        headers: {
          [workspaceGatewayTokenHeader]: gateway.token,
          [workspaceGatewayPortHeader]: "5173",
          [workspaceGatewayProtocolHeader]: "http",
          [workspaceGatewayHostHeader]: "preview.example",
        },
      });
      expect(afterCrashResponse.status).toBe(200);
      expect(await afterCrashResponse.text()).toBe("gateway proof");
    } finally {
      await execWorkspaceShell(id, "tmux kill-session -t gateway-proof");
    }
  });

  test("default workspaces let the aligned user write VS Code extension metadata", async () => {
    const id = await getReusableWorkspaceId();
    const result = await execWorkspaceShell(id, `set -eu
      git --version
      manifest=$(mktemp /opt/atelier/vscode-extensions/atelier-write-check.XXXXXX)
      printf '[]\\n' > "$manifest"
      rm "$manifest"`, { user: "atelier" });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  });

  test("default workspaces include Compose and start a private Docker daemon", async () => {
    const id = await getReusableWorkspaceId();
    const info = await execWorkspaceCommand(id, ["docker", "info", "--format", "{{.Driver}}"]);
    expect(info.exitCode).toBe(0);
    expect(info.stdout.trim()).toBe("fuse-overlayfs");
    const compose = await execWorkspaceCommand(id, ["docker", "compose", "version"]);
    expect(compose.exitCode, compose.stderr).toBe(0);
    expect(compose.stdout).toContain("Docker Compose version");
  });

  // LinuxKit can reject security.capability reads on FUSE executables before
  // fuse-overlayfs receives the request. Verify builds on a native Linux host.
  nativeDockerTest("default workspaces build and run Compose services and retain Docker data across parking", async () => {
    const { id } = await createDisposableWorkspace();
    const build = await execWorkspaceShell(id, `set -eu
mkdir -p /tmp/compose-test
cd /tmp/compose-test
cat > Dockerfile <<'DOCKERFILE'
FROM alpine:3.22
RUN printf 'nested build works' > /message
DOCKERFILE
cat > compose.yaml <<'COMPOSE'
services:
  app:
    build: .
    image: atelier-default-docker-test
    volumes:
      - data:/data
volumes:
  data:
COMPOSE
docker compose build`);
    expect(build.exitCode, build.stdout + build.stderr).toBe(0);
    const run = await execWorkspaceShell(id, "cd /tmp/compose-test && docker compose run --rm app sh -c 'cat /message; echo persisted > /data/message'");
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe("nested build works");

    const otherId = await getReusableWorkspaceId();
    const isolated = await execWorkspaceCommand(otherId, ["docker", "image", "inspect", "atelier-default-docker-test"]);
    expect(isolated.exitCode).not.toBe(0);

    // Force a stale PID that is guaranteed to name an unrelated process on resume.
    const stalePid = await docker(["exec", "--user", "root", workspaceContainerName(id), "sh", "-c", "echo 1 > /var/run/docker/containerd/containerd.pid"]);
    expect(stalePid.exitCode, stalePid.stderr).toBe(0);
    await setWorkspaceParked(id, true);
    expect((await docker(["inspect", "--format", "{{.State.Running}}", workspaceContainerName(id)])).stdout.trim()).toBe("false");
    await setWorkspaceParked(id, false);
    const resumed = await execWorkspaceShell(id, `set -eu
for i in $(seq 1 300); do docker info >/dev/null 2>&1 && break; sleep .1; done
cd /tmp/compose-test
docker compose run --rm app cat /data/message`);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expect(resumed.stdout.trim()).toBe("persisted");
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

  test("discovery and container start are immediate; a missing gateway times out independently", async () => {
    const id = generateWorkspaceId();
    const image = await docker(["inspect", "--format", "{{.Image}}", workspaceContainerName(await getReusableWorkspaceId())]);
    const created = await docker(["create", "--name", workspaceContainerName(id), "-p", `127.0.0.1::${workspaceGatewayPort}`,
      "--label", "com.atelier.type=workspace", "--label", `com.atelier.namespace=${testNamespace}`,
      "--label", `com.atelier.workspace-id=${id}`, image.stdout.trim(), "sleep", "infinity"]);
    expect(created.exitCode).toBe(0);
    expect((await listWorkspaces({ inspectImages: false })).workspaces).toContainEqual({ id, title: null });
    await setWorkspaceContainerRunning(id, true);
    await docker(["exec", workspaceContainerName(id), "mkdir", "-p", "/.atelier", "/work"]);
    const running = await docker(["inspect", "--format", "{{.State.Running}}", workspaceContainerName(id)]);
    expect(running.stdout.trim()).toBe("true");
    await Bun.write(atelierDataPath(getAtelierRuntimeContext(), "workspaces", id, "gateway-token"), "test-token");
    const startedAt = Date.now();
    await expect(checkWorkspaceGateway(id)).rejects.toMatchObject({ code: "workspace_gateway_unavailable", message: "Workspace gateway did not become ready within 15 seconds." });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(14_000);
  }, 25_000);

  test("setWorkspaceTitle sets the workspace title and listWorkspaces reflects it", async () => {
    const workspaceId = await getReusableWorkspaceId();

    expect(await getWorkspaceTitle(workspaceId)).toBeNull();
    expect(await setWorkspaceTitle(workspaceId, "Add dark mode toggle")).toBeNull();
    expect(await getWorkspaceTitle(workspaceId)).toBe("Add dark mode toggle");
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
