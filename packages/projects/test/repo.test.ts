import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { AtelierCoreError } from "@atelier/core";
import { createWorkspace, deleteWorkspace, execWorkspaceCommand, type WorkspaceExecResult } from "@atelier/workspace";
import { getWorkspaceRepoSlopometer, listWorkspaceRepos } from "@atelier/projects";
import { cleanupNamespace, createTestNamespace } from "../../workspace/test/helpers.ts";

setDefaultTimeout(120_000);

const testNamespace = createTestNamespace("test-repository-workspace");
let sharedWorkspaceId: string;

async function expectCoreError(action: () => Promise<unknown>): Promise<AtelierCoreError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(AtelierCoreError);
    return error as AtelierCoreError;
  }
  throw new Error("expected AtelierCoreError");
}

async function execScript(workspaceId: string, script: string): Promise<WorkspaceExecResult> {
  const result = await execWorkspaceCommand(workspaceId, ["sh", "-lc", script]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  return result;
}

function getWorkspaceId(): string {
  if (!sharedWorkspaceId) throw new Error("shared workspace has not been created");
  return sharedWorkspaceId;
}

beforeAll(async () => {
  process.env.ATELIER_NAMESPACE = testNamespace;
  await cleanupNamespace(testNamespace);
  sharedWorkspaceId = (await createWorkspace()).id;
});

beforeEach(async () => {
  await execScript(sharedWorkspaceId, "find /work -mindepth 1 -maxdepth 1 -exec rm -rf {} +; mkdir -p /work");
});

afterAll(async () => {
  if (sharedWorkspaceId) await deleteWorkspace(sharedWorkspaceId).catch(() => null);
  await cleanupNamespace(testNamespace);
});

describe("core workspace repos", () => {
  test("listWorkspaceRepos returns an empty repo list when /work has no git repo", async () => {
    expect(await listWorkspaceRepos(getWorkspaceId())).toEqual({ repos: [] });
  });

  test("listWorkspaceRepos returns the git repo at /work", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, "git -c init.defaultBranch=main init /work >/dev/null");

    expect((await listWorkspaceRepos(workspaceId)).repos).toEqual(["work"]);
  });

  test("listWorkspaceRepos ignores a non-git /work", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, "mkdir -p /work/not-a-repo");

    expect((await listWorkspaceRepos(workspaceId)).repos).toEqual([]);
  });

  test("listWorkspaceRepos ignores hidden directories under /work", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `
      mkdir -p /work/.hidden
      git -c init.defaultBranch=main init /work/.hidden >/dev/null
    `);

    expect((await listWorkspaceRepos(workspaceId)).repos).toEqual([]);
  });

  test("getWorkspaceRepoSlopometer separates net implementation and test lines", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `
      git -c init.defaultBranch=main init /work >/dev/null
      cd /work
      git config user.email test@example.com
      git config user.name Test
      printf 'one\ntwo\nthree\n' > app.ts
      mkdir -p test
      printf 'one\ntwo\n' > test/app.test.ts
      git add .
      git commit -m initial >/dev/null
      printf 'one\ntwo changed\n' > app.ts
      printf 'one\ntwo\nthree\nfour\n' > test/app.test.ts
      mkdir -p src/__tests__
      printf 'new\ncovered\n' > src/__tests__/feature.ts
      printf 'helper\n' > helper.ts
    `);

    expect(await getWorkspaceRepoSlopometer(workspaceId, "work")).toEqual({ netImplementationLines: 0, netTestLines: 4 });
  });

  test("getWorkspaceRepoSlopometer applies additional test path patterns from workspace.json", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `
      git -c init.defaultBranch=main init /work >/dev/null
      cd /work
      git config user.email test@example.com
      git config user.name Test
      mkdir -p .atelier src/e2e
      cat > .atelier/workspace.json <<'JSON'
{"version":1,"slopometer":{"testPathPatterns":["(^|/)e2e(/|$)"]}}
JSON
      printf 'app\n' > app.ts
      git add .
      git commit -m initial >/dev/null
      printf 'app\nmore\n' > app.ts
      printf 'flow\nstep\n' > src/e2e/login.ts
    `);

    expect(await getWorkspaceRepoSlopometer(workspaceId, "work")).toEqual({ netImplementationLines: 1, netTestLines: 2 });
  });


  test("repo commands on a deleted workspace throw workspace_not_found", async () => {
    const deletedWorkspaceId = (await createWorkspace()).id;
    await deleteWorkspace(deletedWorkspaceId);

    const error = await expectCoreError(() => listWorkspaceRepos(deletedWorkspaceId));
    expect(error.code).toBe("workspace_not_found");
  });

  test("repo commands respect ATELIER_NAMESPACE and cannot see same workspace ID from another namespace", async () => {
    const currentNamespace = process.env.ATELIER_NAMESPACE;
    const otherNamespace = `${testNamespace}-repo-other`;
    process.env.ATELIER_NAMESPACE = otherNamespace;
    const workspaceId = (await createWorkspace()).id;

    try {
      process.env.ATELIER_NAMESPACE = currentNamespace;
      const error = await expectCoreError(() => listWorkspaceRepos(workspaceId));
      expect(error.code).toBe("workspace_not_found");
    } finally {
      process.env.ATELIER_NAMESPACE = otherNamespace;
      await deleteWorkspace(workspaceId).catch(() => null);
      await cleanupNamespace(otherNamespace);
      process.env.ATELIER_NAMESPACE = currentNamespace;
    }
  });
});
