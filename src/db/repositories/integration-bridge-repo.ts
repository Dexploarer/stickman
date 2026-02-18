import type { IntegrationSubscriber } from "../../types.js";
import { getDatabase } from "../client.js";
import { ensureDatabaseReady } from "../migrate.js";

export interface IntegrationBridgeStatsRecord {
  delivered: number;
  failed: number;
  retriesScheduled: number;
  lastDeliveryAt?: string;
  lastEventAt?: string;
  updatedAt?: string;
}

const defaultStats = (): IntegrationBridgeStatsRecord => ({
  delivered: 0,
  failed: 0,
  retriesScheduled: 0,
});

const sanitizeEvents = (events: unknown): string[] => {
  if (!Array.isArray(events)) {
    return ["integration_*"];
  }
  const list = events
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return list.length ? Array.from(new Set(list)) : ["integration_*"];
};

const mapSubscriber = (row: Record<string, unknown>): IntegrationSubscriber => ({
  id: String(row.id || ""),
  url: String(row.url || ""),
  enabled: Number(row.enabled || 0) === 1,
  events: sanitizeEvents(
    (() => {
      try {
        return JSON.parse(String(row.events_json || "[]"));
      } catch {
        return ["integration_*"];
      }
    })(),
  ),
  secret: String(row.secret || ""),
  createdAt: String(row.created_at || new Date().toISOString()),
  updatedAt: String(row.updated_at || new Date().toISOString()),
  lastSuccessAt: row.last_success_at ? String(row.last_success_at) : undefined,
  lastError: row.last_error ? String(row.last_error) : undefined,
});

const ensureStatsRow = () => {
  ensureDatabaseReady();
  const db = getDatabase();
  const row = db.prepare("SELECT id FROM integration_bridge_stats WHERE id = 1 LIMIT 1").get() as { id?: number } | undefined;
  if (row?.id === 1) {
    return;
  }
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO integration_bridge_stats(id, delivered, failed, retries_scheduled, last_delivery_at, last_event_at, updated_at)
     VALUES (1, 0, 0, 0, NULL, NULL, ?)`,
  ).run(now);
};

export const listIntegrationSubscribersFromDb = (): IntegrationSubscriber[] => {
  ensureDatabaseReady();
  const db = getDatabase();
  return db
    .prepare(
      `SELECT id, url, enabled, events_json, secret, created_at, updated_at, last_success_at, last_error
       FROM integration_subscribers
       ORDER BY created_at DESC`,
    )
    .all()
    .map((row) => mapSubscriber(row as Record<string, unknown>));
};

export const getIntegrationSubscriberByIdFromDb = (id: string): IntegrationSubscriber | null => {
  ensureDatabaseReady();
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT id, url, enabled, events_json, secret, created_at, updated_at, last_success_at, last_error
       FROM integration_subscribers
       WHERE id = ?
       LIMIT 1`,
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  return mapSubscriber(row);
};

export const upsertIntegrationSubscriberInDb = (subscriber: IntegrationSubscriber) => {
  ensureDatabaseReady();
  const db = getDatabase();
  db.prepare(
    `INSERT INTO integration_subscribers(
      id, url, enabled, events_json, secret, created_at, updated_at, last_success_at, last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      url = excluded.url,
      enabled = excluded.enabled,
      events_json = excluded.events_json,
      secret = excluded.secret,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      last_success_at = excluded.last_success_at,
      last_error = excluded.last_error`,
  ).run(
    subscriber.id,
    subscriber.url,
    subscriber.enabled ? 1 : 0,
    JSON.stringify(sanitizeEvents(subscriber.events)),
    subscriber.secret,
    subscriber.createdAt,
    subscriber.updatedAt,
    subscriber.lastSuccessAt || null,
    subscriber.lastError || null,
  );
};

export const deleteIntegrationSubscriberFromDb = (id: string): boolean => {
  ensureDatabaseReady();
  const db = getDatabase();
  const result = db.prepare("DELETE FROM integration_subscribers WHERE id = ?").run(id);
  return result.changes > 0;
};

export const setIntegrationSubscriberEnabledInDb = (id: string, enabled: boolean): IntegrationSubscriber | null => {
  ensureDatabaseReady();
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare("UPDATE integration_subscribers SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, now, id);
  return getIntegrationSubscriberByIdFromDb(id);
};

export const updateIntegrationSubscriberDeliveryInDb = (input: { id: string; ok: boolean; error?: string }) => {
  ensureDatabaseReady();
  const db = getDatabase();
  const now = new Date().toISOString();
  if (input.ok) {
    db.prepare(
      "UPDATE integration_subscribers SET last_success_at = ?, last_error = NULL, updated_at = ? WHERE id = ?",
    ).run(now, now, input.id);
    return;
  }
  db.prepare(
    "UPDATE integration_subscribers SET last_error = ?, updated_at = ? WHERE id = ?",
  ).run(String(input.error || "delivery_failed"), now, input.id);
};

export const getIntegrationBridgeStatsFromDb = (): IntegrationBridgeStatsRecord => {
  ensureStatsRow();
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM integration_bridge_stats WHERE id = 1 LIMIT 1").get() as
    | {
        delivered?: number;
        failed?: number;
        retries_scheduled?: number;
        last_delivery_at?: string;
        last_event_at?: string;
        updated_at?: string;
      }
    | undefined;
  if (!row) {
    return defaultStats();
  }
  return {
    delivered: Number(row.delivered || 0),
    failed: Number(row.failed || 0),
    retriesScheduled: Number(row.retries_scheduled || 0),
    lastDeliveryAt: row.last_delivery_at,
    lastEventAt: row.last_event_at,
    updatedAt: row.updated_at,
  };
};

export const updateIntegrationBridgeStatsInDb = (patch: Partial<IntegrationBridgeStatsRecord>): IntegrationBridgeStatsRecord => {
  ensureStatsRow();
  const db = getDatabase();
  const current = getIntegrationBridgeStatsFromDb();
  const next: IntegrationBridgeStatsRecord = {
    ...current,
    ...patch,
    delivered: Number(patch.delivered ?? current.delivered),
    failed: Number(patch.failed ?? current.failed),
    retriesScheduled: Number(patch.retriesScheduled ?? current.retriesScheduled),
    updatedAt: new Date().toISOString(),
  };

  db.prepare(
    `UPDATE integration_bridge_stats
     SET delivered = ?, failed = ?, retries_scheduled = ?, last_delivery_at = ?, last_event_at = ?, updated_at = ?
     WHERE id = 1`,
  ).run(
    next.delivered,
    next.failed,
    next.retriesScheduled,
    next.lastDeliveryAt || null,
    next.lastEventAt || null,
    next.updatedAt,
  );

  return next;
};
