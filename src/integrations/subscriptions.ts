import { randomBytes, randomUUID } from "node:crypto";

import {
  deleteIntegrationSubscriberFromDb,
  getIntegrationBridgeStatsFromDb,
  getIntegrationSubscriberByIdFromDb,
  listIntegrationSubscribersFromDb,
  setIntegrationSubscriberEnabledInDb,
  updateIntegrationBridgeStatsInDb,
  updateIntegrationSubscriberDeliveryInDb,
  upsertIntegrationSubscriberInDb,
} from "../db/repositories/integration-bridge-repo.js";
import { ensureDatabaseReady } from "../db/migrate.js";
import type { IntegrationSubscriber } from "../types.js";
import type { IntegrationBridgeStorageShape } from "./types.js";

const defaultStorage = (): IntegrationBridgeStorageShape => ({
  subscribers: [],
  stats: {
    delivered: 0,
    failed: 0,
    retriesScheduled: 0,
    lastDeliveryAt: undefined,
    lastEventAt: undefined,
  },
});

const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value.trim());

const sanitizeEvents = (events: unknown): string[] => {
  if (!Array.isArray(events)) {
    return ["integration_*"];
  }
  const rows = events
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!rows.length) {
    return ["integration_*"];
  }
  return Array.from(new Set(rows));
};

export class IntegrationSubscriptionStore {
  private filePath: string;
  private loaded = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async ensureLoaded() {
    if (this.loaded) {
      return;
    }
    ensureDatabaseReady();
    this.loaded = true;
  }

  async persist() {
    // Persistence is handled transactionally by SQLite repository methods.
  }

  listSubscribers(): IntegrationSubscriber[] {
    ensureDatabaseReady();
    return listIntegrationSubscribersFromDb().map((item) => ({
      ...item,
      events: [...item.events],
    }));
  }

  async createSubscriber(input: {
    url: string;
    events?: string[];
  }): Promise<{ subscriber: Omit<IntegrationSubscriber, "secret">; secret: string }> {
    const url = String(input.url || "").trim();
    if (!isHttpUrl(url)) {
      throw new Error("Subscriber url must start with http:// or https://");
    }
    const now = new Date().toISOString();
    const secret = randomBytes(32).toString("hex");
    const subscriber: IntegrationSubscriber = {
      id: randomUUID(),
      url,
      enabled: true,
      events: sanitizeEvents(input.events),
      secret,
      createdAt: now,
      updatedAt: now,
    };
    upsertIntegrationSubscriberInDb(subscriber);
    return {
      subscriber: this.stripSecret(subscriber),
      secret,
    };
  }

  async deleteSubscriber(id: string): Promise<boolean> {
    return deleteIntegrationSubscriberFromDb(id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<IntegrationSubscriber | null> {
    const subscriber = setIntegrationSubscriberEnabledInDb(id, enabled);
    if (!subscriber) {
      return null;
    }
    return {
      ...subscriber,
      events: [...subscriber.events],
    };
  }

  async updateDeliveryResult(input: {
    id: string;
    ok: boolean;
    error?: string;
  }) {
    updateIntegrationSubscriberDeliveryInDb(input);
  }

  async updateStats(patch: Partial<IntegrationBridgeStorageShape["stats"]>) {
    updateIntegrationBridgeStatsInDb({
      delivered: patch.delivered,
      failed: patch.failed,
      retriesScheduled: patch.retriesScheduled,
      lastDeliveryAt: patch.lastDeliveryAt,
      lastEventAt: patch.lastEventAt,
    });
  }

  getStats(): IntegrationBridgeStorageShape["stats"] {
    ensureDatabaseReady();
    const stats = getIntegrationBridgeStatsFromDb();
    return {
      delivered: stats.delivered,
      failed: stats.failed,
      retriesScheduled: stats.retriesScheduled,
      lastDeliveryAt: stats.lastDeliveryAt,
      lastEventAt: stats.lastEventAt,
    };
  }

  getById(id: string): IntegrationSubscriber | null {
    const subscriber = getIntegrationSubscriberByIdFromDb(id);
    if (!subscriber) {
      return null;
    }
    return {
      ...subscriber,
      events: [...subscriber.events],
    };
  }

  stripSecret(subscriber: IntegrationSubscriber): Omit<IntegrationSubscriber, "secret"> {
    const { secret: _secret, ...rest } = subscriber;
    return {
      ...rest,
      events: [...rest.events],
    };
  }

  getStorageSnapshot(): IntegrationBridgeStorageShape {
    return {
      subscribers: this.listSubscribers(),
      stats: this.getStats(),
    };
  }

  getLegacyFilePath() {
    return this.filePath;
  }

  resetToDefaults() {
    const snapshot = defaultStorage();
    return snapshot;
  }
}
