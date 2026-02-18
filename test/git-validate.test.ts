import { describe, expect, it } from "bun:test";

import { normalizeCommitMessage, validateBranchName } from "../src/git/validate.ts";

describe("git/validate", () => {
  it("accepts branch names allowed by the strict allowlist", () => {
    const okNames = [
      "codex/dev-workbench-v1",
      "feature/allowlist_cleanup",
      "release/2026.02.18",
      "fix/workbench-ui",
      "aa",
    ];
    okNames.forEach((name) => {
      const result = validateBranchName(name);
      expect(result.ok).toBe(true);
    });
  });

  it("rejects branch names with forbidden patterns", () => {
    const badNames = [
      "",
      " ",
      "-starts-with-dash",
      "ends/with/slash/",
      "has whitespace",
      "double//slash",
      "has..dots",
      "has@{sequence",
      "bad~name",
      "bad^name",
      "bad:name",
      "bad?name",
      "bad*name",
      "bad[name]",
    ];
    badNames.forEach((name) => {
      const result = validateBranchName(name);
      expect(result.ok).toBe(false);
    });
  });

  it("normalizes commit messages to a single trimmed subject line", () => {
    expect(normalizeCommitMessage("feat: add workbench").ok).toBe(true);
    expect(normalizeCommitMessage("   ").ok).toBe(false);
    expect(normalizeCommitMessage("x".repeat(121)).ok).toBe(false);
  });
});

