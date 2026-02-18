import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getDatabase, resetDatabaseForTests } from "../src/db/client.ts";
import { resetDatabaseMigrationsForTests, runDatabaseMigrations } from "../src/db/migrate.ts";

const createdDirs: string[] = [];

const makeTempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "stickman-db-migrate-"));
  createdDirs.push(dir);
  return dir;
};

afterEach(() => {
  resetDatabaseForTests();
  resetDatabaseMigrationsForTests();
  while (createdDirs.length) {
    const dir = createdDirs.pop();
    if (!dir) {
      continue;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("db migrations", () => {
  it("creates schema and is idempotent", () => {
    const tempDir = makeTempDir();
    const dbPath = path.join(tempDir, "stickman.db");

    resetDatabaseForTests(dbPath);
    runDatabaseMigrations({
      force: true,
      onboardingStatePath: path.join(tempDir, "missing-onboarding.json"),
      integrationBridgeStatePath: path.join(tempDir, "missing-bridge.json"),
    });

    const db = getDatabase();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = new Set(tables.map((row) => row.name));

    expect(tableNames.has("meta")).toBe(true);
    expect(tableNames.has("onboarding_state")).toBe(true);
    expect(tableNames.has("integration_subscribers")).toBe(true);
    expect(tableNames.has("integration_bridge_stats")).toBe(true);
    expect(tableNames.has("integration_action_history")).toBe(true);
    expect(tableNames.has("code_sessions")).toBe(true);

    const migrationVersion = db
      .prepare("SELECT value FROM meta WHERE key = 'migration_version' LIMIT 1")
      .get() as { value?: string } | undefined;
    expect(typeof migrationVersion?.value).toBe("string");
    expect((migrationVersion?.value || "").length).toBeGreaterThan(4);

    runDatabaseMigrations({
      onboardingStatePath: path.join(tempDir, "missing-onboarding.json"),
      integrationBridgeStatePath: path.join(tempDir, "missing-bridge.json"),
    });

    const onboardingCount = db
      .prepare("SELECT COUNT(*) AS count FROM onboarding_state")
      .get() as { count: number };
    expect(onboardingCount.count).toBe(1);
  });

  it("imports legacy JSON only when target tables are empty", () => {
    const tempDir = makeTempDir();
    const dbPath = path.join(tempDir, "stickman.db");
    const onboardingPath = path.join(tempDir, "onboarding.json");
    const bridgePath = path.join(tempDir, "integration-bridge.json");

    writeFileSync(
      onboardingPath,
      JSON.stringify(
        {
          completed: true,
          updatedAt: "2026-02-18T10:00:00.000Z",
          providers: {
            mode: "hybrid",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(
      bridgePath,
      JSON.stringify(
        {
          subscribers: [
            {
              id: "sub-1",
              url: "https://example.com/hook",
              enabled: true,
              events: ["integration_*"],
              secret: "secret-1",
              createdAt: "2026-02-18T10:00:00.000Z",
              updatedAt: "2026-02-18T10:00:00.000Z",
            },
          ],
          stats: {
            delivered: 4,
            failed: 1,
            retriesScheduled: 2,
            lastDeliveryAt: "2026-02-18T10:05:00.000Z",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    resetDatabaseForTests(dbPath);
    runDatabaseMigrations({
      force: true,
      onboardingStatePath: onboardingPath,
      integrationBridgeStatePath: bridgePath,
    });

    const db = getDatabase();
    const onboardingRow = db
      .prepare("SELECT payload_json FROM onboarding_state WHERE id = 1 LIMIT 1")
      .get() as { payload_json: string };
    const onboarding = JSON.parse(onboardingRow.payload_json) as Record<string, unknown>;
    expect(onboarding.completed).toBe(true);
    expect((onboarding.providers as Record<string, unknown>)?.mode).toBe("hybrid");

    const subscriberCount = db
      .prepare("SELECT COUNT(*) AS count FROM integration_subscribers")
      .get() as { count: number };
    expect(subscriberCount.count).toBe(1);

    const stats = db
      .prepare("SELECT delivered, failed, retries_scheduled FROM integration_bridge_stats WHERE id = 1")
      .get() as { delivered: number; failed: number; retries_scheduled: number };
    expect(stats.delivered).toBe(4);
    expect(stats.failed).toBe(1);
    expect(stats.retries_scheduled).toBe(2);

    writeFileSync(
      onboardingPath,
      JSON.stringify(
        {
          completed: false,
          providers: { mode: "openrouter" },
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(
      bridgePath,
      JSON.stringify(
        {
          subscribers: [
            {
              id: "sub-2",
              url: "https://example.com/new",
              enabled: true,
              events: ["integration_*"],
              secret: "secret-2",
              createdAt: "2026-02-18T11:00:00.000Z",
              updatedAt: "2026-02-18T11:00:00.000Z",
            },
          ],
          stats: {
            delivered: 99,
            failed: 88,
            retriesScheduled: 77,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    runDatabaseMigrations({
      force: true,
      onboardingStatePath: onboardingPath,
      integrationBridgeStatePath: bridgePath,
    });

    const onboardingRowAfter = db
      .prepare("SELECT payload_json FROM onboarding_state WHERE id = 1 LIMIT 1")
      .get() as { payload_json: string };
    const onboardingAfter = JSON.parse(onboardingRowAfter.payload_json) as Record<string, unknown>;
    expect(onboardingAfter.completed).toBe(true);

    const subscriberCountAfter = db
      .prepare("SELECT COUNT(*) AS count FROM integration_subscribers")
      .get() as { count: number };
    expect(subscriberCountAfter.count).toBe(1);
  });
});
