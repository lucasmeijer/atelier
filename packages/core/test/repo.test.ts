import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  AtelierCoreError,
  createWorkspace,
  deleteWorkspace,
  execWorkspace,
  getWorkspaceRepoMergeability,
  listWorkspaceRepos,
  pushWorkspaceRepo,
  workspaceCommand,
  type WorkspaceExecResult,
  type WorkspaceRepoWorkingTreeStatus,
} from "../src/index.ts";
import { cleanupNamespace, createTestNamespace } from "./helpers.ts";

setDefaultTimeout(120_000);

const testNamespace = createTestNamespace("test-core-repo");
const emptyWorkingTree: WorkspaceRepoWorkingTreeStatus = {
  stagedFiles: [],
  addedFiles: [],
  modifiedFiles: [],
  removedFiles: [],
  untrackedFiles: [],
};

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
  const result = await execWorkspace(workspaceId, ["sh", "-lc", script]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  return result;
}

function gitIdentityScript(): string {
  return `
    git config --global init.defaultBranch main
    git config --global user.name Test
    git config --global user.email test@example.com
  `;
}

function setupBaseRepoScript(repo: string): string {
  return `
    set -e
    ${gitIdentityScript()}
    mkdir -p /tmp/atelier-test-remotes /tmp/atelier-test-clones /work
    git init --bare /tmp/atelier-test-remotes/${repo}.git >/dev/null
    git clone /tmp/atelier-test-remotes/${repo}.git /work >/dev/null 2>&1
    cd /work
    echo base > file.txt
    git add file.txt
    git commit -m base >/dev/null
    git branch -M main
    git push -u origin main >/dev/null 2>&1
  `;
}

function addLocalCommitScript(repo: string, file: string, content: string, message = "local change"): string {
  return `
    set -e
    cd /work
    printf '%s\n' ${JSON.stringify(content)} > ${file}
    git add ${file}
    git commit -m ${JSON.stringify(message)} >/dev/null
  `;
}

function addRemoteCommitScript(repo: string, file: string, content: string, message = "remote change"): string {
  return `
    set -e
    ${gitIdentityScript()}
    rm -rf /tmp/atelier-test-clones/${repo}-updater
    git clone /tmp/atelier-test-remotes/${repo}.git /tmp/atelier-test-clones/${repo}-updater >/dev/null 2>&1
    cd /tmp/atelier-test-clones/${repo}-updater
    printf '%s\n' ${JSON.stringify(content)} > ${file}
    git add ${file}
    git commit -m ${JSON.stringify(message)} >/dev/null
    git push origin main >/dev/null 2>&1
  `;
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
  await execScript(sharedWorkspaceId, "find /work -mindepth 1 -maxdepth 1 -exec rm -rf {} +; rm -rf /tmp/atelier-test-remotes /tmp/atelier-test-clones; mkdir -p /work");
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
    await execScript(workspaceId, setupBaseRepoScript("alpha"));

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
      git init /work/.hidden >/dev/null
    `);

    expect((await listWorkspaceRepos(workspaceId)).repos).toEqual([]);
  });

  test("workspaceCommand repo list rejects unexpected arguments", async () => {
    const error = await expectCoreError(() => workspaceCommand([getWorkspaceId(), "repo", "list", "unexpected"]));
    expect(error.code).toBe("invalid_arguments");
  });

  test("getWorkspaceRepoMergeability returns nothing_to_push for a repo equal to its upstream", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, setupBaseRepoScript("equal"));

    expect(await getWorkspaceRepoMergeability(workspaceId, "work")).toEqual({ state: "nothing_to_push", behind: 0, workingTree: emptyWorkingTree });
  });

  test("getWorkspaceRepoMergeability returns can_push for local commits and no upstream changes", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `${setupBaseRepoScript("local-only")} ${addLocalCommitScript("local-only", "local.txt", "local")}`);

    expect(await getWorkspaceRepoMergeability(workspaceId, "work")).toEqual({ state: "can_push", ahead: 1, behind: 0, workingTree: emptyWorkingTree });
  });

  test("getWorkspaceRepoMergeability includes staged, added, modified, removed, and untracked files", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `
      ${setupBaseRepoScript("dirty")}
      cd /work
      printf 'tracked\n' > modified.txt
      git add modified.txt
      git commit -m 'add modified fixture' >/dev/null
      printf 'staged\n' > staged.txt
      git add staged.txt
      printf 'modified\n' > modified.txt
      rm file.txt
      printf 'untracked\n' > untracked.txt
    `);

    const result = await getWorkspaceRepoMergeability(workspaceId, "work");
    expect(result.workingTree).toEqual({
      stagedFiles: ["staged.txt"],
      addedFiles: ["staged.txt"],
      modifiedFiles: ["modified.txt"],
      removedFiles: ["file.txt"],
      untrackedFiles: ["untracked.txt"],
    });
  });

  test("getWorkspaceRepoMergeability returns can_push for local deletion with no upstream changes", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `
      ${setupBaseRepoScript("local-delete")}
      cd /work
      git rm tsconfig.json >/dev/null 2>&1 || git rm file.txt >/dev/null
      git commit -m 'delete file' >/dev/null
    `);

    expect(await getWorkspaceRepoMergeability(workspaceId, "work")).toEqual({ state: "can_push", ahead: 1, behind: 0, workingTree: emptyWorkingTree });
  });

  test("getWorkspaceRepoMergeability returns can_push for local commits plus non-conflicting upstream commits", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `
      ${setupBaseRepoScript("no-conflict")}
      ${addRemoteCommitScript("no-conflict", "remote.txt", "remote")}
      ${addLocalCommitScript("no-conflict", "local.txt", "local")}
    `);

    expect(await getWorkspaceRepoMergeability(workspaceId, "work")).toEqual({ state: "can_push", ahead: 1, behind: 1, workingTree: emptyWorkingTree });
  });

  test("getWorkspaceRepoMergeability returns has_conflicts for local and upstream commits changing the same line", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `
      ${setupBaseRepoScript("conflict")}
      ${addRemoteCommitScript("conflict", "file.txt", "remote")}
      ${addLocalCommitScript("conflict", "file.txt", "local")}
    `);

    expect(await getWorkspaceRepoMergeability(workspaceId, "work")).toEqual({ state: "has_conflicts", ahead: 1, behind: 1, conflictCount: 1, workingTree: emptyWorkingTree });
  });

  test("getWorkspaceRepoMergeability returns fetch_failed when git fetch cannot fetch upstream", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `
      ${setupBaseRepoScript("broken-fetch")}
      cd /work
      git remote set-url origin /tmp/atelier-test-remotes/missing.git
    `);

    const result = await getWorkspaceRepoMergeability(workspaceId, "work");
    expect(result.state).toBe("fetch_failed");
    if (result.state !== "fetch_failed") throw new Error("expected fetch_failed");
    expect(result.message.length).toBeGreaterThan(0);
  });

  test("getWorkspaceRepoMergeability missing repo throws repo_not_found", async () => {
    const error = await expectCoreError(() => getWorkspaceRepoMergeability(getWorkspaceId(), "missing-repo"));
    expect(error.code).toBe("repo_not_found");
  });

  test("workspaceCommand repo mergeability rejects missing repo name", async () => {
    const error = await expectCoreError(() => workspaceCommand([getWorkspaceId(), "repo", "mergeability"]));
    expect(error.code).toBe("invalid_arguments");
  });

  test("workspaceCommand repo mergeability rejects unexpected arguments", async () => {
    const error = await expectCoreError(() => workspaceCommand([getWorkspaceId(), "repo", "mergeability", "repo", "unexpected"]));
    expect(error.code).toBe("invalid_arguments");
  });

  test("pushWorkspaceRepo returns skipped nothing_to_push for a repo equal to its upstream", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, setupBaseRepoScript("push-equal"));

    expect(await pushWorkspaceRepo(workspaceId, "work")).toEqual({ state: "skipped", reason: "nothing_to_push" });
  });

  test("pushWorkspaceRepo pushes a local commit when mergeability is can_push", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `${setupBaseRepoScript("push-local")} ${addLocalCommitScript("push-local", "local.txt", "local")}`);

    const result = await pushWorkspaceRepo(workspaceId, "work");
    const count = await execScript(workspaceId, "git --git-dir=/tmp/atelier-test-remotes/push-local.git rev-list --count main");

    expect(result).toEqual({ state: "pushed" });
    expect(count.stdout.trim()).toBe("2");
  });

  test("pushWorkspaceRepo rebases then pushes when upstream has non-conflicting commits", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `
      ${setupBaseRepoScript("push-rebase")}
      ${addRemoteCommitScript("push-rebase", "remote.txt", "remote")}
      ${addLocalCommitScript("push-rebase", "local.txt", "local")}
    `);

    const result = await pushWorkspaceRepo(workspaceId, "work");
    const count = await execScript(workspaceId, "git --git-dir=/tmp/atelier-test-remotes/push-rebase.git rev-list --count main");

    expect(result).toEqual({ state: "pushed" });
    expect(count.stdout.trim()).toBe("3");
  });

  test("pushWorkspaceRepo returns skipped has_conflicts when mergeability has conflicts", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `
      ${setupBaseRepoScript("push-conflict")}
      ${addRemoteCommitScript("push-conflict", "file.txt", "remote")}
      ${addLocalCommitScript("push-conflict", "file.txt", "local")}
    `);

    expect(await pushWorkspaceRepo(workspaceId, "work")).toEqual({ state: "skipped", reason: "has_conflicts" });
  });

  test("pushWorkspaceRepo returns skipped fetch_failed when fetch fails", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `
      ${setupBaseRepoScript("push-fetch-failed")}
      cd /work
      git remote set-url origin /tmp/atelier-test-remotes/missing.git
    `);

    expect(await pushWorkspaceRepo(workspaceId, "work")).toEqual({ state: "skipped", reason: "fetch_failed" });
  });

  test("pushWorkspaceRepo missing repo throws repo_not_found", async () => {
    const error = await expectCoreError(() => pushWorkspaceRepo(getWorkspaceId(), "missing-repo"));
    expect(error.code).toBe("repo_not_found");
  });

  test("workspaceCommand repo push rejects missing repo name", async () => {
    const error = await expectCoreError(() => workspaceCommand([getWorkspaceId(), "repo", "push"]));
    expect(error.code).toBe("invalid_arguments");
  });

  test("workspaceCommand repo push rejects unexpected arguments", async () => {
    const error = await expectCoreError(() => workspaceCommand([getWorkspaceId(), "repo", "push", "repo", "unexpected"]));
    expect(error.code).toBe("invalid_arguments");
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
