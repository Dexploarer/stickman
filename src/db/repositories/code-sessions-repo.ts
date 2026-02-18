import type { TerminalSessionRecord } from "../../types.js";
import { getDatabase } from "../client.js";
import { ensureDatabaseReady } from "../migrate.js";

const mapSessionRecord = (row: Record<string, unknown>): TerminalSessionRecord => ({
  id: String(row.id || ""),
  mode: "command",
  command: String(row.command || ""),
  cwd: String(row.cwd || ""),
  status: String(row.status || "failed"),
  startedAt: String(row.started_at || new Date().toISOString()),
  finishedAt: row.finished_at ? String(row.finished_at) : undefined,
  durationMs: typeof row.duration_ms === "number" ? row.duration_ms : row.duration_ms == null ? undefined : Number(row.duration_ms),
  exitCode: typeof row.exit_code === "number" ? row.exit_code : row.exit_code == null ? undefined : Number(row.exit_code),
  stdout: String(row.stdout || ""),
  stderr: String(row.stderr || ""),
  readOnly: Number(row.read_only || 0) === 1,
  updatedAt: String(row.updated_at || new Date().toISOString()),
});

export const upsertCodeSessionRecord = (session: TerminalSessionRecord) => {
  ensureDatabaseReady();
  const db = getDatabase();
  db.prepare(
    `INSERT INTO code_sessions(
      id, command, cwd, status, started_at, finished_at, duration_ms, exit_code, stdout, stderr, read_only, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      command = excluded.command,
      cwd = excluded.cwd,
      status = excluded.status,
      started_at = excluded.started_at,
      finished_at = excluded.finished_at,
      duration_ms = excluded.duration_ms,
      exit_code = excluded.exit_code,
      stdout = excluded.stdout,
      stderr = excluded.stderr,
      read_only = excluded.read_only,
      updated_at = excluded.updated_at`,
  ).run(
    session.id,
    session.command,
    session.cwd,
    session.status,
    session.startedAt,
    session.finishedAt || null,
    typeof session.durationMs === "number" ? session.durationMs : null,
    typeof session.exitCode === "number" ? session.exitCode : null,
    session.stdout,
    session.stderr,
    session.readOnly ? 1 : 0,
    session.updatedAt,
  );
};

export const listCodeSessionRecords = (limit = 60): TerminalSessionRecord[] => {
  ensureDatabaseReady();
  const db = getDatabase();
  const safeLimit = Math.max(1, Math.min(120, Math.floor(limit)));
  const rows = db
    .prepare(
      `SELECT id, command, cwd, status, started_at, finished_at, duration_ms, exit_code, stdout, stderr, read_only, updated_at
       FROM code_sessions
       ORDER BY started_at DESC
       LIMIT ?`,
    )
    .all(safeLimit) as Array<Record<string, unknown>>;
  return rows.map((row) => mapSessionRecord(row));
};

export const getCodeSessionRecord = (id: string): TerminalSessionRecord | null => {
  ensureDatabaseReady();
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT id, command, cwd, status, started_at, finished_at, duration_ms, exit_code, stdout, stderr, read_only, updated_at
       FROM code_sessions
       WHERE id = ?
       LIMIT 1`,
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  return mapSessionRecord(row);
};
