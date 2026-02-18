import { getDatabase } from "../client.js";
import { ensureDatabaseReady } from "../migrate.js";

export interface IntegrationActionHistoryTraceRow {
  index: number;
  stepId: string;
  status: string;
  code?: string;
  message?: string;
}

export interface IntegrationActionHistoryRecord {
  id: string;
  at: string;
  mode: "dry_run" | "execute";
  actionId: string | null;
  steps: string[];
  status: "planned" | "confirm_required" | "completed" | "failed";
  code?: string;
  error?: string;
  trace: IntegrationActionHistoryTraceRow[];
}

const parseJsonArray = <T>(raw: unknown, fallback: T[]): T[] => {
  if (typeof raw !== "string") {
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
};

export const insertIntegrationActionHistory = (entry: IntegrationActionHistoryRecord) => {
  ensureDatabaseReady();
  const db = getDatabase();
  db.prepare(
    `INSERT INTO integration_action_history(
      id, at, mode, action_id, steps_json, status, code, error, trace_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.id,
    entry.at,
    entry.mode,
    entry.actionId,
    JSON.stringify(entry.steps || []),
    entry.status,
    entry.code || null,
    entry.error || null,
    JSON.stringify(entry.trace || []),
  );
};

export const listIntegrationActionHistory = (limit = 60): IntegrationActionHistoryRecord[] => {
  ensureDatabaseReady();
  const db = getDatabase();
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const rows = db
    .prepare(
      `SELECT id, at, mode, action_id, steps_json, status, code, error, trace_json
       FROM integration_action_history
       ORDER BY at DESC
       LIMIT ?`,
    )
    .all(safeLimit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id || ""),
    at: String(row.at || new Date().toISOString()),
    mode: row.mode === "execute" ? "execute" : "dry_run",
    actionId: row.action_id ? String(row.action_id) : null,
    steps: parseJsonArray<string>(row.steps_json, []),
    status:
      row.status === "confirm_required" || row.status === "completed" || row.status === "failed" ? (row.status as "confirm_required" | "completed" | "failed") : "planned",
    code: row.code ? String(row.code) : undefined,
    error: row.error ? String(row.error) : undefined,
    trace: parseJsonArray<IntegrationActionHistoryTraceRow>(row.trace_json, []),
  }));
};
