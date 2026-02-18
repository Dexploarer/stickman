import { readFileSync } from "node:fs";

import { defaultOnboardingState, integrationBridgeStatePath, onboardingStatePath } from "../config.js";
import type { IntegrationSubscriber, OnboardingState } from "../types.js";
import { getDatabase, getDatabaseConfig, getDatabasePath } from "./client.js";
import { applyCoreSchema } from "./schema.js";

export interface MigrationRunOptions {
  onboardingStatePath?: string;
  integrationBridgeStatePath?: string;
  force?: boolean;
}

const defaultBridgeStats = {
  delivered: 0,
  failed: 0,
  retriesScheduled: 0,
  lastDeliveryAt: undefined as string | undefined,
  lastEventAt: undefined as string | undefined,
};

let initializedDbPath: string | null = null;

const safeReadJson = (filePath: string): unknown => {
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

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

const normalizeLegacySubscriber = (value: unknown): IntegrationSubscriber | null => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const row = value as Record<string, unknown>;
  const id = String(row.id || "").trim();
  const url = String(row.url || "").trim();
  const secret = String(row.secret || "").trim();
  if (!id || !url || !secret) {
    return null;
  }
  const now = new Date().toISOString();
  return {
    id,
    url,
    enabled: row.enabled !== false,
    events: sanitizeEvents(row.events),
    secret,
    createdAt: String(row.createdAt || now),
    updatedAt: String(row.updatedAt || now),
    lastSuccessAt: row.lastSuccessAt ? String(row.lastSuccessAt) : undefined,
    lastError: row.lastError ? String(row.lastError) : undefined,
  };
};

const importLegacyOnboardingStateIfEmpty = (inputPath: string) => {
  const db = getDatabase();
  const existingCountRow = db.prepare("SELECT COUNT(*) AS count FROM onboarding_state").get() as { count?: number } | undefined;
  const existingCount = Number(existingCountRow?.count || 0);
  if (existingCount > 0) {
    return;
  }

  const now = new Date().toISOString();
  const defaults = defaultOnboardingState();
  let payload: OnboardingState = {
    ...defaults,
    updatedAt: now,
    storage: {
      engine: "sqlite",
      path: getDatabasePath(),
      migratedAt: now,
    },
  };

  const parsed = safeReadJson(inputPath);
  if (parsed && typeof parsed === "object") {
    payload = {
      ...(parsed as OnboardingState),
      storage: {
        engine: "sqlite",
        path: getDatabasePath(),
        migratedAt: now,
      },
    };
    if (!payload.updatedAt) {
      payload.updatedAt = now;
    }
  }

  db.prepare(
    `INSERT INTO onboarding_state(id, payload_json, updated_at)
     VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
  ).run(JSON.stringify(payload), payload.updatedAt || now);
};

const ensureIntegrationBridgeStatsRow = (statsPatch?: {
  delivered?: number;
  failed?: number;
  retriesScheduled?: number;
  lastDeliveryAt?: string;
  lastEventAt?: string;
}) => {
  const db = getDatabase();
  const current = db.prepare("SELECT * FROM integration_bridge_stats WHERE id = 1 LIMIT 1").get() as
    | {
        delivered: number;
        failed: number;
        retries_scheduled: number;
        last_delivery_at?: string;
        last_event_at?: string;
      }
    | undefined;
  const now = new Date().toISOString();
  const next = {
    delivered: Number(statsPatch?.delivered ?? current?.delivered ?? defaultBridgeStats.delivered),
    failed: Number(statsPatch?.failed ?? current?.failed ?? defaultBridgeStats.failed),
    retriesScheduled: Number(statsPatch?.retriesScheduled ?? current?.retries_scheduled ?? defaultBridgeStats.retriesScheduled),
    lastDeliveryAt: statsPatch?.lastDeliveryAt ?? current?.last_delivery_at ?? defaultBridgeStats.lastDeliveryAt,
    lastEventAt: statsPatch?.lastEventAt ?? current?.last_event_at ?? defaultBridgeStats.lastEventAt,
  };
  db.prepare(
    `INSERT INTO integration_bridge_stats(id, delivered, failed, retries_scheduled, last_delivery_at, last_event_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       delivered = excluded.delivered,
       failed = excluded.failed,
       retries_scheduled = excluded.retries_scheduled,
       last_delivery_at = excluded.last_delivery_at,
       last_event_at = excluded.last_event_at,
       updated_at = excluded.updated_at`,
  ).run(next.delivered, next.failed, next.retriesScheduled, next.lastDeliveryAt || null, next.lastEventAt || null, now);
};

const importLegacyIntegrationBridgeIfEmpty = (inputPath: string) => {
  const db = getDatabase();
  const existingCountRow = db.prepare("SELECT COUNT(*) AS count FROM integration_subscribers").get() as { count?: number } | undefined;
  const existingCount = Number(existingCountRow?.count || 0);

  if (existingCount <= 0) {
    const parsed = safeReadJson(inputPath) as {
      subscribers?: unknown[];
      stats?: {
        delivered?: number;
        failed?: number;
        retriesScheduled?: number;
        lastDeliveryAt?: string;
        lastEventAt?: string;
      };
    } | null;

    const subscribers = Array.isArray(parsed?.subscribers)
      ? parsed?.subscribers
          .map((entry) => normalizeLegacySubscriber(entry))
          .filter((entry): entry is IntegrationSubscriber => Boolean(entry))
      : [];

    if (subscribers.length) {
      const upsert = db.prepare(
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
      );
      for (const subscriber of subscribers) {
        upsert.run(
          subscriber.id,
          subscriber.url,
          subscriber.enabled ? 1 : 0,
          JSON.stringify(subscriber.events || ["integration_*"]),
          subscriber.secret,
          subscriber.createdAt,
          subscriber.updatedAt,
          subscriber.lastSuccessAt || null,
          subscriber.lastError || null,
        );
      }
    }

    ensureIntegrationBridgeStatsRow({
      delivered: Number(parsed?.stats?.delivered || 0),
      failed: Number(parsed?.stats?.failed || 0),
      retriesScheduled: Number(parsed?.stats?.retriesScheduled || 0),
      lastDeliveryAt: parsed?.stats?.lastDeliveryAt,
      lastEventAt: parsed?.stats?.lastEventAt,
    });
    return;
  }

  ensureIntegrationBridgeStatsRow();
};

export const runDatabaseMigrations = (options: MigrationRunOptions = {}) => {
  const dbPath = getDatabasePath();
  if (!options.force && initializedDbPath === dbPath) {
    return;
  }

  const db = getDatabase();
  applyCoreSchema(db);
  importLegacyOnboardingStateIfEmpty(options.onboardingStatePath || onboardingStatePath);
  importLegacyIntegrationBridgeIfEmpty(options.integrationBridgeStatePath || integrationBridgeStatePath);

  const now = new Date().toISOString();
  const dbConfig = getDatabaseConfig();
  db.prepare(
    `INSERT INTO meta(key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run("db_path", dbPath, now);
  db.prepare(
    `INSERT INTO meta(key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run("db_journal_mode", dbConfig.journalMode, now);

  initializedDbPath = dbPath;
};

export const ensureDatabaseReady = () => {
  runDatabaseMigrations();
};

export const resetDatabaseMigrationsForTests = () => {
  initializedDbPath = null;
};
