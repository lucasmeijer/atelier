import { describe, expect, test } from "bun:test";
import { isSshAuthenticationFailure } from "./git-access-failure.ts";

describe("SSH authentication failure", () => {
  test.each([
    "git@github.com: Permission denied (publickey).",
    "git@example.com: Permission denied (publickey,password,keyboard-interactive).\r\nfatal: Could not read from remote repository.",
  ])("recognizes rejected public-key authentication: %s", (message) => {
    expect(isSshAuthenticationFailure(message)).toBe(true);
  });

  test.each([
    "Host key verification failed.",
    "ERROR: Repository not found.",
    "fatal: Authentication failed for 'https://github.com/owner/repo.git/'",
    "ssh: Could not resolve hostname example.com: Name or service not known",
    "ssh: connect to host example.com port 22: Connection refused",
    "ssh: connect to host example.com port 22: Connection timed out",
    "fatal: Could not read from remote repository.",
    "Permission denied (password).",
    "error: could not create work tree dir 'publickey': Permission denied",
  ])("does not misdiagnose another failure: %s", (message) => {
    expect(isSshAuthenticationFailure(message)).toBe(false);
  });
});
