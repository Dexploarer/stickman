import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetDatabaseForTests } from "../src/db/client.ts";
import { resetDatabaseMigrationsForTests } from "../src/db/migrate.ts";
import { getOnboardingState, saveOnboardingState } from "../src/onboarding.ts";

const createdDirs: string[] = [];

const makeTempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "stickman-onboarding-db-"));
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

describe("onboarding SQLite persistence", () => {
  it("loads defaults and persists updates", async () => {
    const tempDir = makeTempDir();
    const dbPath = path.join(tempDir, "stickman.db");

    resetDatabaseForTests(dbPath);

    const defaults = await getOnboardingState();
    expect(defaults.completed).toBe(false);
    expect(defaults.storage?.engine).toBe("sqlite");

    await saveOnboardingState({
      completed: true,
      providers: {
        mode: "hybrid",
      },
    });

    const updated = await getOnboardingState();
    expect(updated.completed).toBe(true);
    expect(updated.providers.mode).toBe("hybrid");
    expect(updated.storage?.engine).toBe("sqlite");
    expect(typeof updated.storage?.path).toBe("string");
  });
});
