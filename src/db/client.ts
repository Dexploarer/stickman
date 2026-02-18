import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { appConfig } from "../config.js";
import type { LocalDatabaseConfig } from "../types.js";

export interface SqliteRunResult {
  changes: number;
  lastInsertRowid?: number | bigint;
}

export interface SqliteStatement {
  run: (...params: unknown[]) => SqliteRunResult;
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
}

export interface SqliteDatabase {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
}

const require = createRequire(import.meta.url);

const isBunRuntime = (): boolean => typeof (globalThis as unknown as { Bun?: unknown }).Bun !== "undefined";

const createDatabase = (targetPath: string): SqliteDatabase => {
  if (isBunRuntime()) {
    const { Database } = require("bun:sqlite") as { Database: new (path: string) => SqliteDatabase };
    return new Database(targetPath);
  }

  const BetterSqlite3 = require("better-sqlite3") as unknown as new (path: string) => SqliteDatabase;
  return new BetterSqlite3(targetPath);
};

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
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA synchronous=NORMAL;");
  db.exec("PRAGMA foreign_keys=ON;");
  return db;
};

export const resetDatabaseForTests = (nextPath?: string) => {
  if (db) {
    db.close();
    db = null;
  }
  dbPathOverride = nextPath ? path.resolve(nextPath) : null;
};
