import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  expectFailure,
  expectSuccess,
  runAtelier,
  testNamespace,
  type WorkspaceExecResult,
  type WorkspaceNewResult,
  type WorkspaceRepoListResult,
  type WorkspaceRepoMergeabilityResult,
  type WorkspaceRepoPushResult,
  type WorkspaceRepoWorkingTreeStatus,
} from "./helpers.ts";

setDefaultTimeout(120_000);

const emptyWorkingTree: WorkspaceRepoWorkingTreeStatus = {
  stagedFiles: [],
  addedFiles: [],
  modifiedFiles: [],
  removedFiles: [],
  untrackedFiles: [],
};

let sharedWorkspaceId: string;

interface WorkspaceCloneResult {
  repo: string;
  path: string;
  remoteUrl: string;
  referencePath: string;
}

async function newWorkspace(): Promise<string> {
  return expectSuccess<WorkspaceNewResult>(await runAtelier(["workspace", "new"])).id;
}

async function hostGit(args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed\n${stdout}\n${stderr}`);
}

function getWorkspaceId(): string {
  if (!sharedWorkspaceId) throw new Error("shared workspace has not been created");
  return sharedWorkspaceId;
}

async function execScript(workspaceId: string, script: string): Promise<WorkspaceExecResult> {
  const result = expectSuccess<WorkspaceExecResult>(
    await runAtelier(["workspace", "exec", workspaceId, "--", "sh", "-lc", script]),
  );
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
    mkdir -p /tmp/atelier-test-remotes /tmp/atelier-test-clones /repos
    git init --bare /tmp/atelier-test-remotes/${repo}.git >/dev/null
    git clone /tmp/atelier-test-remotes/${repo}.git /repos/${repo} >/dev/null 2>&1
    cd /repos/${repo}
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
    cd /repos/${repo}
    printf '%s\\n' ${JSON.stringify(content)} > ${file}
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
    printf '%s\\n' ${JSON.stringify(content)} > ${file}
    git add ${file}
    git commit -m ${JSON.stringify(message)} >/dev/null
    git push origin main >/dev/null 2>&1
  `;
}

describe("atelier workspace repo", () => {
  beforeAll(async () => {
    sharedWorkspaceId = await newWorkspace();
  });

  beforeEach(async () => {
    await execScript(sharedWorkspaceId, "find /repos -mindepth 1 -maxdepth 1 -exec rm -rf {} +; rm -rf /tmp/atelier-test-remotes /tmp/atelier-test-clones; mkdir -p /repos");
  });

  afterAll(async () => {
    if (sharedWorkspaceId) {
      expectSuccess<null>(await runAtelier(["workspace", "delete", sharedWorkspaceId]));
    }
  });

  test("workspace <id> repo list returns an empty repo list when /repos has no git repos", async () => {
    const workspaceId = getWorkspaceId();

    const result = expectSuccess<WorkspaceRepoListResult>(
      await runAtelier(["workspace", workspaceId, "repo", "list"]),
    );

    expect(result).toEqual({ repos: [] });
  });

  test("workspace <id> repo list returns direct child git repos under /repos", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `${setupBaseRepoScript("alpha")} ${setupBaseRepoScript("beta")}`);

    const result = expectSuccess<WorkspaceRepoListResult>(
      await runAtelier(["workspace", workspaceId, "repo", "list"]),
    );

    expect(result.repos).toEqual(["alpha", "beta"]);
  });

  test("workspace <id> repo list ignores non-git directories under /repos", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `${setupBaseRepoScript("alpha")} mkdir -p /repos/not-a-repo`);

    const result = expectSuccess<WorkspaceRepoListResult>(
      await runAtelier(["workspace", workspaceId, "repo", "list"]),
    );

    expect(result.repos).toEqual(["alpha"]);
  });

  test("workspace <id> clone <repo> clones a managed repo into /repos", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atelier-clone-data-"));
    const reposDir = join(dataDir, "repos");
    const barePath = join(reposDir, "alpha.git");
    await mkdir(reposDir, { recursive: true });
    await hostGit(["init", "--bare", barePath]);
    await hostGit(["--git-dir", barePath, "symbolic-ref", "HEAD", "refs/heads/main"]);
    await hostGit(["--git-dir", barePath, "config", "remote.origin.url", "/atelier/repos/alpha.git"]);

    const workspace = expectSuccess<WorkspaceNewResult>(await runAtelier(["workspace", "new"], { dataDir }));
    try {
      const cloned = expectSuccess<WorkspaceCloneResult>(
        await runAtelier(["workspace", workspace.id, "clone", "alpha"], { dataDir }),
      );
      expect(cloned.repo).toBe("alpha");
      expect(cloned.path).toBe("/repos/alpha");
      expect(cloned.remoteUrl).toBe("/atelier/repos/alpha.git");
      expect(cloned.referencePath).toBe("/atelier/repos/alpha.git");

      const origin = await execScript(workspace.id, "git -C /repos/alpha remote get-url origin");
      expect(origin.stdout.trim()).toBe("/atelier/repos/alpha.git");

      await execScript(workspace.id, `
        ${gitIdentityScript()}
        cd /repos/alpha
        echo hello > README.md
        git add README.md
        git commit -m initial >/dev/null
        git push -u origin main >/dev/null 2>&1
      `);

      const listed = expectSuccess<WorkspaceRepoListResult>(
        await runAtelier(["workspace", workspace.id, "repo", "list"], { dataDir }),
      );
      expect(listed.repos).toEqual(["alpha"]);
    } finally {
      await runAtelier(["workspace", "delete", workspace.id], { dataDir });
    }
  });

  test("workspace <id> repo list ignores hidden test/helper directories under /repos", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `
      ${setupBaseRepoScript("alpha")}
      mkdir -p /repos/.hidden
      git init /repos/.hidden >/dev/null
    `);

    const result = expectSuccess<WorkspaceRepoListResult>(
      await runAtelier(["workspace", workspaceId, "repo", "list"]),
    );

    expect(result.repos).toEqual(["alpha"]);
  });

  test("workspace <id> repo list unexpected returns invalid_arguments", async () => {
    const workspaceId = getWorkspaceId();

    const error = expectFailure(await runAtelier(["workspace", workspaceId, "repo", "list", "unexpected"]));

    expect(error.code).toBe("invalid_arguments");
  });

  test("workspace <id> repo mergeability <repo> returns nothing_to_push for a repo equal to its upstream", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, setupBaseRepoScript("equal"));

    const result = expectSuccess<WorkspaceRepoMergeabilityResult>(
      await runAtelier(["workspace", workspaceId, "repo", "mergeability", "equal"]),
    );

    expect(result).toEqual({ state: "nothing_to_push", behind: 0, workingTree: emptyWorkingTree });
  });

  test("workspace <id> repo mergeability <repo> returns can_push for local commits and no upstream changes", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `${setupBaseRepoScript("local-only")} ${addLocalCommitScript("local-only", "local.txt", "local")}`);

    const result = expectSuccess<WorkspaceRepoMergeabilityResult>(
      await runAtelier(["workspace", workspaceId, "repo", "mergeability", "local-only"]),
    );

    expect(result).toEqual({ state: "can_push", ahead: 1, behind: 0, workingTree: emptyWorkingTree });
  });

  test("workspace <id> repo mergeability <repo> includes staged, added, modified, removed, and untracked files", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `
      ${setupBaseRepoScript("dirty")}
      cd /repos/dirty
      printf 'tracked\n' > modified.txt
      git add modified.txt
      git commit -m 'add modified fixture' >/dev/null
      printf 'staged\n' > staged.txt
      git add staged.txt
      printf 'modified\n' > modified.txt
      rm file.txt
      printf 'untracked\n' > untracked.txt
    `);

    const result = expectSuccess<WorkspaceRepoMergeabilityResult>(
      await runAtelier(["workspace", workspaceId, "repo", "mergeability", "dirty"]),
    );

    expect(result.workingTree).toEqual({
      stagedFiles: ["staged.txt"],
      addedFiles: ["staged.txt"],
      modifiedFiles: ["modified.txt"],
      removedFiles: ["file.txt"],
      untrackedFiles: ["untracked.txt"],
    });
  });

  test("workspace <id> repo mergeability <repo> returns can_push for local deletion with no upstream changes", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `
      ${setupBaseRepoScript("local-delete")}
      cd /repos/local-delete
      git rm tsconfig.json >/dev/null 2>&1 || git rm file.txt >/dev/null
      git commit -m 'delete file' >/dev/null
    `);

    const result = expectSuccess<WorkspaceRepoMergeabilityResult>(
      await runAtelier(["workspace", workspaceId, "repo", "mergeability", "local-delete"]),
    );

    expect(result).toEqual({ state: "can_push", ahead: 1, behind: 0, workingTree: emptyWorkingTree });
  });

  test("workspace <id> repo mergeability <repo> returns can_push for local commits plus non-conflicting upstream commits", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `
      ${setupBaseRepoScript("no-conflict")}
      ${addRemoteCommitScript("no-conflict", "remote.txt", "remote")}
      ${addLocalCommitScript("no-conflict", "local.txt", "local")}
    `);

    const result = expectSuccess<WorkspaceRepoMergeabilityResult>(
      await runAtelier(["workspace", workspaceId, "repo", "mergeability", "no-conflict"]),
    );

    expect(result).toEqual({ state: "can_push", ahead: 1, behind: 1, workingTree: emptyWorkingTree });
  });

  test("workspace <id> repo mergeability <repo> returns has_conflicts for local and upstream commits changing the same line", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `
      ${setupBaseRepoScript("conflict")}
      ${addRemoteCommitScript("conflict", "file.txt", "remote")}
      ${addLocalCommitScript("conflict", "file.txt", "local")}
    `);

    const result = expectSuccess<WorkspaceRepoMergeabilityResult>(
      await runAtelier(["workspace", workspaceId, "repo", "mergeability", "conflict"]),
    );

    expect(result).toEqual({ state: "has_conflicts", ahead: 1, behind: 1, conflictCount: 1, workingTree: emptyWorkingTree });
  });

  test("workspace <id> repo mergeability <repo> returns fetch_failed when git fetch cannot fetch upstream", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `
      ${setupBaseRepoScript("broken-fetch")}
      cd /repos/broken-fetch
      git remote set-url origin /tmp/atelier-test-remotes/missing.git
    `);

    const result = expectSuccess<WorkspaceRepoMergeabilityResult>(
      await runAtelier(["workspace", workspaceId, "repo", "mergeability", "broken-fetch"]),
    );

    expect(result.state).toBe("fetch_failed");
    if (result.state !== "fetch_failed") throw new Error("expected fetch_failed");
    expect(result.message.length).toBeGreaterThan(0);
  });

  test("workspace <id> repo mergeability missing-repo returns repo_not_found", async () => {
    const workspaceId = getWorkspaceId();

    const error = expectFailure(await runAtelier(["workspace", workspaceId, "repo", "mergeability", "missing-repo"]));

    expect(error.code).toBe("repo_not_found");
  });

  test("workspace <id> repo mergeability without repo name returns invalid_arguments", async () => {
    const workspaceId = getWorkspaceId();

    const error = expectFailure(await runAtelier(["workspace", workspaceId, "repo", "mergeability"]));

    expect(error.code).toBe("invalid_arguments");
  });

  test("workspace <id> repo mergeability <repo> unexpected returns invalid_arguments", async () => {
    const workspaceId = getWorkspaceId();

    const error = expectFailure(await runAtelier(["workspace", workspaceId, "repo", "mergeability", "repo", "unexpected"]));

    expect(error.code).toBe("invalid_arguments");
  });

  test("workspace <id> repo push <repo> returns skipped nothing_to_push for a repo equal to its upstream", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, setupBaseRepoScript("push-equal"));

    const result = expectSuccess<WorkspaceRepoPushResult>(
      await runAtelier(["workspace", workspaceId, "repo", "push", "push-equal"]),
    );

    expect(result).toEqual({ state: "skipped", reason: "nothing_to_push" });
  });

  test("workspace <id> repo push <repo> pushes a local commit when mergeability is can_push", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `${setupBaseRepoScript("push-local")} ${addLocalCommitScript("push-local", "local.txt", "local")}`);

    const result = expectSuccess<WorkspaceRepoPushResult>(
      await runAtelier(["workspace", workspaceId, "repo", "push", "push-local"]),
    );
    const count = await execScript(workspaceId, "git --git-dir=/tmp/atelier-test-remotes/push-local.git rev-list --count main");

    expect(result).toEqual({ state: "pushed" });
    expect(count.stdout.trim()).toBe("2");
  });

  test("workspace <id> repo push <repo> rebases then pushes when upstream has non-conflicting commits", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `
      ${setupBaseRepoScript("push-rebase")}
      ${addRemoteCommitScript("push-rebase", "remote.txt", "remote")}
      ${addLocalCommitScript("push-rebase", "local.txt", "local")}
    `);

    const result = expectSuccess<WorkspaceRepoPushResult>(
      await runAtelier(["workspace", workspaceId, "repo", "push", "push-rebase"]),
    );
    const count = await execScript(workspaceId, "git --git-dir=/tmp/atelier-test-remotes/push-rebase.git rev-list --count main");

    expect(result).toEqual({ state: "pushed" });
    expect(count.stdout.trim()).toBe("3");
  });

  test("workspace <id> repo push <repo> returns skipped has_conflicts when mergeability has conflicts", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `
      ${setupBaseRepoScript("push-conflict")}
      ${addRemoteCommitScript("push-conflict", "file.txt", "remote")}
      ${addLocalCommitScript("push-conflict", "file.txt", "local")}
    `);

    const result = expectSuccess<WorkspaceRepoPushResult>(
      await runAtelier(["workspace", workspaceId, "repo", "push", "push-conflict"]),
    );

    expect(result).toEqual({ state: "skipped", reason: "has_conflicts" });
  });

  test("workspace <id> repo push <repo> returns skipped fetch_failed when fetch fails", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `
      ${setupBaseRepoScript("push-fetch-failed")}
      cd /repos/push-fetch-failed
      git remote set-url origin /tmp/atelier-test-remotes/missing.git
    `);

    const result = expectSuccess<WorkspaceRepoPushResult>(
      await runAtelier(["workspace", workspaceId, "repo", "push", "push-fetch-failed"]),
    );

    expect(result).toEqual({ state: "skipped", reason: "fetch_failed" });
  });

  test("workspace <id> repo push missing-repo returns repo_not_found", async () => {
    const workspaceId = getWorkspaceId();

    const error = expectFailure(await runAtelier(["workspace", workspaceId, "repo", "push", "missing-repo"]));

    expect(error.code).toBe("repo_not_found");
  });

  test("workspace <id> repo push without repo name returns invalid_arguments", async () => {
    const workspaceId = getWorkspaceId();

    const error = expectFailure(await runAtelier(["workspace", workspaceId, "repo", "push"]));

    expect(error.code).toBe("invalid_arguments");
  });

  test("workspace <id> repo push <repo> unexpected returns invalid_arguments", async () => {
    const workspaceId = getWorkspaceId();

    const error = expectFailure(await runAtelier(["workspace", workspaceId, "repo", "push", "repo", "unexpected"]));

    expect(error.code).toBe("invalid_arguments");
  });

  test("repo commands on a deleted workspace return workspace_not_found", async () => {
    const deletedWorkspaceId = await newWorkspace();
    expectSuccess<null>(await runAtelier(["workspace", "delete", deletedWorkspaceId]));

    const error = expectFailure(await runAtelier(["workspace", deletedWorkspaceId, "repo", "list"]));

    expect(error.code).toBe("workspace_not_found");
  });

  test("repo commands respect ATELIER_NAMESPACE and cannot see same workspace ID from another namespace", async () => {
    const otherNamespace = `${testNamespace}-repo-other`;
    const workspaceId = expectSuccess<WorkspaceNewResult>(
      await runAtelier(["workspace", "new"], { namespace: otherNamespace }),
    ).id;

    const error = expectFailure(await runAtelier(["workspace", workspaceId, "repo", "list"]));
    expect(error.code).toBe("workspace_not_found");

    expectSuccess<null>(await runAtelier(["workspace", "delete", workspaceId], { namespace: otherNamespace }));
  });
});
