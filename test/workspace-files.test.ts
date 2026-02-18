import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  isWorkspacePathBlocked,
  readWorkspaceTextFile,
  resolveWorkspacePath,
  writeWorkspaceTextFile,
} from "../src/workspace/files.ts";

describe("workspace/files", () => {
  it("blocks sensitive and runtime paths", () => {
    expect(isWorkspacePathBlocked(".git/config")).toBe(true);
    expect(isWorkspacePathBlocked("node_modules/react/index.js")).toBe(true);
    expect(isWorkspacePathBlocked(".pordie/config.json")).toBe(true);
    expect(isWorkspacePathBlocked(".state/onboarding.json")).toBe(true);
    expect(isWorkspacePathBlocked(".env")).toBe(true);
    expect(isWorkspacePathBlocked("sub/.env.local")).toBe(true);
    expect(isWorkspacePathBlocked("src/server.ts")).toBe(false);
  });

  it("rejects paths that escape the workspace root", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mss-workspace-root-"));
    try {
      const resolved = resolveWorkspacePath({
        workspaceRoot,
        relPath: "../etc/passwd",
        kind: "file",
      });
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) {
        expect(resolved.code).toBe("invalid_path");
      }
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("reads and writes with baseSha guardrails", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mss-workspace-io-"));
    try {
      const relPath = "notes.txt";
      await writeFile(path.join(workspaceRoot, relPath), "hello", "utf8");

      const initial = await readWorkspaceTextFile({ workspaceRoot, relPath });
      expect(initial.ok).toBe(true);
      if (!initial.ok) {
        return;
      }

      const mismatch = await writeWorkspaceTextFile({
        workspaceRoot,
        relPath,
        content: "next",
        baseSha256: "deadbeef",
      });
      expect(mismatch.ok).toBe(false);
      if (!mismatch.ok) {
        expect(mismatch.code).toBe("base_sha_mismatch");
      }

      const writeOk = await writeWorkspaceTextFile({
        workspaceRoot,
        relPath,
        content: "next",
        baseSha256: initial.sha256,
      });
      expect(writeOk.ok).toBe(true);

      const after = await readWorkspaceTextFile({ workspaceRoot, relPath });
      expect(after.ok).toBe(true);
      if (after.ok) {
        expect(after.content).toBe("next");
      }
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("rejects binary-ish file reads", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mss-workspace-bin-"));
    try {
      const relPath = "blob.bin";
      await writeFile(path.join(workspaceRoot, relPath), Buffer.from([0, 1, 2, 3, 4]));
      const result = await readWorkspaceTextFile({ workspaceRoot, relPath });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("binary_file");
      }
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

