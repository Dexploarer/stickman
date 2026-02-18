import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetDatabaseForTests } from "../src/db/client.ts";
import { resetDatabaseMigrationsForTests, runDatabaseMigrations } from "../src/db/migrate.ts";
import { insertIntegrationActionHistory, listIntegrationActionHistory } from "../src/db/repositories/integration-actions-repo.ts";

const createdDirs: string[] = [];

const makeTempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "stickman-action-history-"));
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

describe("integration action history repository", () => {
  it("stores and lists action traces in descending time order", () => {
    const tempDir = makeTempDir();
    const dbPath = path.join(tempDir, "stickman.db");

    resetDatabaseForTests(dbPath);
    runDatabaseMigrations({
      force: true,
      onboardingStatePath: path.join(tempDir, "missing-onboarding.json"),
      integrationBridgeStatePath: path.join(tempDir, "missing-bridge.json"),
    });

    insertIntegrationActionHistory({
      id: "run-1",
      at: "2026-02-18T12:00:00.000Z",
      mode: "dry_run",
      actionId: "prepare_observer_workspace",
      steps: ["ensure_mac_allowlist"],
      status: "planned",
      trace: [
        {
          index: 0,
          stepId: "ensure_mac_allowlist",
          status: "planned",
        },
      ],
    });

    insertIntegrationActionHistory({
      id: "run-2",
      at: "2026-02-18T12:05:00.000Z",
      mode: "execute",
      actionId: "launch_watch_surface",
      steps: ["start_watch_session"],
      status: "completed",
      trace: [
        {
          index: 0,
          stepId: "start_watch_session",
          status: "executed",
        },
      ],
    });

    const history = listIntegrationActionHistory(10);
    expect(history.length).toBe(2);
    expect(history[0]?.id).toBe("run-2");
    expect(history[1]?.id).toBe("run-1");

    const limited = listIntegrationActionHistory(1);
    expect(limited.length).toBe(1);
    expect(limited[0]?.id).toBe("run-2");
  });
});
