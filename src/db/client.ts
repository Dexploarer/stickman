import { mkdirSync } from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { appConfig } from "../config.js";
import type { LocalDatabaseConfig } from "../types.js";

const createDatabase = (targetPath: string) => new BetterSqlite3(targetPath);
type SqliteDatabase = ReturnType<typeof createDatabase>;

let db: SqliteDatabase | null = null;
let dbPathOverride: string | null = null;

const resolveDbPath = (): string => {
  const candidate = dbPathOverride || appConfig.db.path;
  if (path.isAbsolute(candidate)) {
    return candidate;
  }
  return path.resolve(candidate);
};

export const getDatabasePath = (): string => resolveDbPath();

export const getDatabaseConfig = (): LocalDatabaseConfig => ({
  engine: "sqlite",
  path: resolveDbPath(),
  journalMode: "WAL",
  synchronous: "NORMAL",
});

export const getDatabase = (): SqliteDatabase => {
  if (db) {
    return db;
  }
  const targetPath = resolveDbPath();
  mkdirSync(path.dirname(targetPath), { recursive: true });
  db = createDatabase(targetPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  return db;
};

export const resetDatabaseForTests = (nextPath?: string) => {
  if (db) {
    db.close();
    db = null;
  }
  dbPathOverride = nextPath ? path.resolve(nextPath) : null;
};
