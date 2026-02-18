import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetDatabaseForTests } from "../src/db/client.ts";
import { resetDatabaseMigrationsForTests, runDatabaseMigrations } from "../src/db/migrate.ts";
import { getCodeSessionRecord, listCodeSessionRecords, upsertCodeSessionRecord } from "../src/db/repositories/code-sessions-repo.ts";
import type { TerminalSessionRecord } from "../src/types.ts";

const createdDirs: string[] = [];

const makeTempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "stickman-code-sessions-"));
  createdDirs.push(dir);
  return dir;
};

afterEach(() => {
  resetDatabaseForTests();
  resetDatabaseMigrationsForTests();
  while (createdDirs.length) {
    const dir = createdDirs.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("code sessions repository", () => {
  it("upserts, loads, and orders sessions", () => {
    const tempDir = makeTempDir();
    const dbPath = path.join(tempDir, "stickman.db");

    resetDatabaseForTests(dbPath);
    runDatabaseMigrations({
      force: true,
      onboardingStatePath: path.join(tempDir, "missing-onboarding.json"),
      integrationBridgeStatePath: path.join(tempDir, "missing-bridge.json"),
    });

    const first: TerminalSessionRecord = {
      id: "s1",
      mode: "command",
      command: "pwd",
      cwd: "/tmp",
      status: "running",
      startedAt: "2026-02-18T12:00:00.000Z",
      stdout: "",
      stderr: "",
      readOnly: true,
      updatedAt: "2026-02-18T12:00:00.000Z",
    };

    upsertCodeSessionRecord(first);
    upsertCodeSessionRecord({
      ...first,
      status: "succeeded",
      stdout: "line-1\nline-2",
      finishedAt: "2026-02-18T12:00:03.000Z",
      durationMs: 3000,
      exitCode: 0,
      updatedAt: "2026-02-18T12:00:03.000Z",
    });

    upsertCodeSessionRecord({
      id: "s2",
      mode: "command",
      command: "rg -n provider src/server.ts",
      cwd: "/workspace",
      status: "failed",
      startedAt: "2026-02-18T12:10:00.000Z",
      finishedAt: "2026-02-18T12:10:01.000Z",
      durationMs: 1000,
      exitCode: 1,
      stdout: "",
      stderr: "not found",
      readOnly: true,
      updatedAt: "2026-02-18T12:10:01.000Z",
    });

    const loadedS1 = getCodeSessionRecord("s1");
    expect(loadedS1).not.toBeNull();
    expect(loadedS1?.status).toBe("succeeded");
    expect(loadedS1?.stdout).toContain("line-2");

    const rows = listCodeSessionRecords(10);
    expect(rows.length).toBe(2);
    expect(rows[0]?.id).toBe("s2");
    expect(rows[1]?.id).toBe("s1");
  });
});
