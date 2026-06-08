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
} from "./helpers.ts";

setDefaultTimeout(120_000);

let sharedWorkspaceId: string;

async function newWorkspace(): Promise<string> {
  return expectSuccess<WorkspaceNewResult>(await runAtelier(["workspace", "new"])).id;
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
    mkdir -p /workspace/.test-remotes /workspace/.test-clones
    git init --bare /workspace/.test-remotes/${repo}.git >/dev/null
    git clone /workspace/.test-remotes/${repo}.git /workspace/${repo} >/dev/null 2>&1
    cd /workspace/${repo}
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
    cd /workspace/${repo}
    printf '%s\\n' ${JSON.stringify(content)} > ${file}
    git add ${file}
    git commit -m ${JSON.stringify(message)} >/dev/null
  `;
}

function addRemoteCommitScript(repo: string, file: string, content: string, message = "remote change"): string {
  return `
    set -e
    ${gitIdentityScript()}
    rm -rf /workspace/.test-clones/${repo}-updater
    git clone /workspace/.test-remotes/${repo}.git /workspace/.test-clones/${repo}-updater >/dev/null 2>&1
    cd /workspace/.test-clones/${repo}-updater
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
    await execScript(sharedWorkspaceId, "find /workspace -mindepth 1 -maxdepth 1 -exec rm -rf {} +");
  });

  afterAll(async () => {
    if (sharedWorkspaceId) {
      expectSuccess<null>(await runAtelier(["workspace", "delete", sharedWorkspaceId]));
    }
  });

  test("workspace <id> repo list returns an empty repo list when /workspace has no git repos", async () => {
    const workspaceId = getWorkspaceId();

    const result = expectSuccess<WorkspaceRepoListResult>(
      await runAtelier(["workspace", workspaceId, "repo", "list"]),
    );

    expect(result).toEqual({ repos: [] });
  });

  test("workspace <id> repo list returns direct child git repos under /workspace", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `${setupBaseRepoScript("alpha")} ${setupBaseRepoScript("beta")}`);

    const result = expectSuccess<WorkspaceRepoListResult>(
      await runAtelier(["workspace", workspaceId, "repo", "list"]),
    );

    expect(result.repos).toEqual(["alpha", "beta"]);
  });

  test("workspace <id> repo list ignores non-git directories under /workspace", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `${setupBaseRepoScript("alpha")} mkdir -p /workspace/not-a-repo`);

    const result = expectSuccess<WorkspaceRepoListResult>(
      await runAtelier(["workspace", workspaceId, "repo", "list"]),
    );

    expect(result.repos).toEqual(["alpha"]);
  });

  test("workspace <id> repo list ignores hidden test/helper directories under /workspace", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `
      ${setupBaseRepoScript("alpha")}
      mkdir -p /workspace/.hidden
      git init /workspace/.hidden >/dev/null
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

    expect(result).toEqual({ state: "nothing_to_push", behind: 0 });
  });

  test("workspace <id> repo mergeability <repo> returns can_push for local commits and no upstream changes", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `${setupBaseRepoScript("local-only")} ${addLocalCommitScript("local-only", "local.txt", "local")}`);

    const result = expectSuccess<WorkspaceRepoMergeabilityResult>(
      await runAtelier(["workspace", workspaceId, "repo", "mergeability", "local-only"]),
    );

    expect(result).toEqual({ state: "can_push", ahead: 1, behind: 0 });
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

    expect(result).toEqual({ state: "can_push", ahead: 1, behind: 1 });
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

    expect(result).toEqual({ state: "has_conflicts", ahead: 1, behind: 1, conflictCount: 1 });
  });

  test("workspace <id> repo mergeability <repo> returns fetch_failed when git fetch cannot fetch upstream", async () => {
    const workspaceId = getWorkspaceId();
    await execScript(workspaceId, `
      ${setupBaseRepoScript("broken-fetch")}
      cd /workspace/broken-fetch
      git remote set-url origin /workspace/.test-remotes/missing.git
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
    const count = await execScript(workspaceId, "git --git-dir=/workspace/.test-remotes/push-local.git rev-list --count main");

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
    const count = await execScript(workspaceId, "git --git-dir=/workspace/.test-remotes/push-rebase.git rev-list --count main");

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
      cd /workspace/push-fetch-failed
      git remote set-url origin /workspace/.test-remotes/missing.git
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
