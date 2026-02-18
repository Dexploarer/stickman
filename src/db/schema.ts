import type { getDatabase } from "./client.js";

type SqliteDatabase = ReturnType<typeof getDatabase>;

export const CORE_SCHEMA_MIGRATION_VERSION = "2026.02.18.core_state_v1";

const coreSchemaSql = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS onboarding_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS integration_subscribers (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  events_json TEXT NOT NULL,
  secret TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_success_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS integration_bridge_stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  delivered INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  retries_scheduled INTEGER NOT NULL,
  last_delivery_at TEXT,
  last_event_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS integration_action_history (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  mode TEXT NOT NULL,
  action_id TEXT,
  steps_json TEXT NOT NULL,
  status TEXT NOT NULL,
  code TEXT,
  error TEXT,
  trace_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS code_sessions (
  id TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  exit_code INTEGER,
  stdout TEXT NOT NULL,
  stderr TEXT NOT NULL,
  read_only INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_integration_action_history_at ON integration_action_history(at DESC);
CREATE INDEX IF NOT EXISTS idx_code_sessions_started_at ON code_sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_integration_subscribers_enabled ON integration_subscribers(enabled, updated_at DESC);
`;

export const applyCoreSchema = (db: SqliteDatabase) => {
  db.exec(coreSchemaSql);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO meta(key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run("migration_version", CORE_SCHEMA_MIGRATION_VERSION, now);
};

export const readMetaValue = (db: SqliteDatabase, key: string): string | null => {
  const row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1").get(key) as { value?: string } | undefined;
  return typeof row?.value === "string" ? row.value : null;
};
