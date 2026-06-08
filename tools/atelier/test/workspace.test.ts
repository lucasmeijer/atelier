import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  expectFailure,
  expectSuccess,
  runAtelier,
  testNamespace,
  type WorkspaceExecResult,
  type WorkspaceListResult,
  type WorkspaceNewResult,
} from "./helpers.ts";

setDefaultTimeout(30_000);

describe("atelier workspace", () => {
  test("list returns an empty list in a clean namespace", async () => {
    const result = expectSuccess<WorkspaceListResult>(await runAtelier(["workspace", "list"]));

    expect(result).toEqual({ workspaces: [] });
  });

  test("new creates a workspace and list includes it with no title", async () => {
    const created = expectSuccess<WorkspaceNewResult>(await runAtelier(["workspace", "new"]));

    expect(typeof created.id).toBe("string");
    expect(created.id).toMatch(/^[0-9a-f]{8}$/);

    const listed = expectSuccess<WorkspaceListResult>(await runAtelier(["workspace", "list"]));
    expect(listed.workspaces).toContainEqual({ id: created.id, title: null });
  });

  test("title sets the workspace title and list reflects it", async () => {
    const created = expectSuccess<WorkspaceNewResult>(await runAtelier(["workspace", "new"]));

    const titleResult = expectSuccess<null>(
      await runAtelier(["workspace", "title", created.id, "Add dark mode toggle"]),
    );
    expect(titleResult).toBeNull();

    const listed = expectSuccess<WorkspaceListResult>(await runAtelier(["workspace", "list"]));
    expect(listed.workspaces).toContainEqual({ id: created.id, title: "Add dark mode toggle" });
  });

  test("exec captures stdout, stderr, exit code, and duration", async () => {
    const created = expectSuccess<WorkspaceNewResult>(await runAtelier(["workspace", "new"]));

    const exec = expectSuccess<WorkspaceExecResult>(
      await runAtelier([
        "workspace",
        "exec",
        created.id,
        "--",
        "sh",
        "-c",
        "printf hello && printf error >&2",
      ]),
    );

    expect(exec.exitCode).toBe(0);
    expect(exec.stdout).toBe("hello");
    expect(exec.stderr).toBe("error");
    expect(typeof exec.durationMs).toBe("number");
    expect(exec.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("exec runs commands as the non-root atelier user", async () => {
    const created = expectSuccess<WorkspaceNewResult>(await runAtelier(["workspace", "new"]));

    const exec = expectSuccess<WorkspaceExecResult>(
      await runAtelier(["workspace", "exec", created.id, "--", "whoami"]),
    );

    expect(exec.exitCode).toBe(0);
    expect(exec.stdout.trim()).toBe("atelier");
    expect(exec.stderr).toBe("");
  });

  test("exec returns child command failure as a successful atelier result", async () => {
    const created = expectSuccess<WorkspaceNewResult>(await runAtelier(["workspace", "new"]));

    const cliResult = await runAtelier(["workspace", "exec", created.id, "--", "sh", "-c", "exit 7"]);
    const exec = expectSuccess<WorkspaceExecResult>(cliResult);

    expect(exec.exitCode).toBe(7);
    expect(exec.stdout).toBe("");
    expect(exec.stderr).toBe("");
    expect(exec.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("delete removes the workspace", async () => {
    const created = expectSuccess<WorkspaceNewResult>(await runAtelier(["workspace", "new"]));

    const deleteResult = expectSuccess<null>(await runAtelier(["workspace", "delete", created.id]));
    expect(deleteResult).toBeNull();

    const listed = expectSuccess<WorkspaceListResult>(await runAtelier(["workspace", "list"]));
    expect(listed.workspaces.some((workspace) => workspace.id === created.id)).toBe(false);
  });

  test("exec on a deleted workspace returns a JSON error", async () => {
    const created = expectSuccess<WorkspaceNewResult>(await runAtelier(["workspace", "new"]));
    expectSuccess<null>(await runAtelier(["workspace", "delete", created.id]));

    const error = expectFailure(await runAtelier(["workspace", "exec", created.id, "--", "echo", "hello"]));
    expect(error.code).toBe("workspace_not_found");
  });

  test("workspace ids are scoped to ATELIER_NAMESPACE", async () => {
    const otherNamespace = `${testNamespace}-other`;
    const created = expectSuccess<WorkspaceNewResult>(
      await runAtelier(["workspace", "new"], { namespace: otherNamespace }),
    );

    const currentList = expectSuccess<WorkspaceListResult>(await runAtelier(["workspace", "list"]));
    expect(currentList.workspaces.some((workspace) => workspace.id === created.id)).toBe(false);

    const otherList = expectSuccess<WorkspaceListResult>(
      await runAtelier(["workspace", "list"], { namespace: otherNamespace }),
    );
    expect(otherList.workspaces).toContainEqual({ id: created.id, title: null });

    const wrongNamespaceError = expectFailure(await runAtelier(["workspace", "delete", created.id]));
    expect(wrongNamespaceError.code).toBe("workspace_not_found");

    expectSuccess<null>(await runAtelier(["workspace", "delete", created.id], { namespace: otherNamespace }));
  });

  test("invalid workspace list arguments return a JSON error", async () => {
    const error = expectFailure(await runAtelier(["workspace", "list", "unexpected"]));

    expect(error.code).toBe("invalid_arguments");
  });

  test("exec without a command separator returns a JSON error", async () => {
    const created = expectSuccess<WorkspaceNewResult>(await runAtelier(["workspace", "new"]));

    const error = expectFailure(await runAtelier(["workspace", "exec", created.id, "echo", "hello"]));
    expect(error.code).toBe("invalid_arguments");
  });

  test("exec with an empty command returns a JSON error", async () => {
    const created = expectSuccess<WorkspaceNewResult>(await runAtelier(["workspace", "new"]));

    const error = expectFailure(await runAtelier(["workspace", "exec", created.id, "--"]));
    expect(error.code).toBe("invalid_arguments");
  });

});
