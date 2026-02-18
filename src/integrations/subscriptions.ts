import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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

const parseStorage = (raw: string): IntegrationBridgeStorageShape => {
  try {
    const parsed = JSON.parse(raw) as Partial<IntegrationBridgeStorageShape> | null;
    const subscribers = Array.isArray(parsed?.subscribers)
      ? parsed?.subscribers
          .filter((item): item is IntegrationSubscriber => Boolean(item && typeof item === "object"))
          .map((item) => ({
            id: String(item.id || randomUUID()),
            url: String(item.url || ""),
            enabled: item.enabled !== false,
            events: sanitizeEvents(item.events),
            secret: String(item.secret || ""),
            createdAt: String(item.createdAt || new Date().toISOString()),
            updatedAt: String(item.updatedAt || new Date().toISOString()),
            lastSuccessAt: item.lastSuccessAt ? String(item.lastSuccessAt) : undefined,
            lastError: item.lastError ? String(item.lastError) : undefined,
          }))
          .filter((item) => item.url && item.secret)
      : [];
    const stats = {
      delivered: Number(parsed?.stats?.delivered || 0),
      failed: Number(parsed?.stats?.failed || 0),
      retriesScheduled: Number(parsed?.stats?.retriesScheduled || 0),
      lastDeliveryAt: parsed?.stats?.lastDeliveryAt ? String(parsed.stats.lastDeliveryAt) : undefined,
      lastEventAt: parsed?.stats?.lastEventAt ? String(parsed.stats.lastEventAt) : undefined,
    };
    return {
      subscribers,
      stats,
    };
  } catch {
    return defaultStorage();
  }
};

export class IntegrationSubscriptionStore {
  private filePath: string;
  private data: IntegrationBridgeStorageShape = defaultStorage();
  private loaded = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async ensureLoaded() {
    if (this.loaded) {
      return;
    }
    try {
      const raw = await readFile(this.filePath, "utf-8");
      this.data = parseStorage(raw);
    } catch {
      this.data = defaultStorage();
      await this.persist();
    }
    this.loaded = true;
  }

  async persist() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.data, null, 2));
  }

  listSubscribers(): IntegrationSubscriber[] {
    return this.data.subscribers.map((item) => ({
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
    this.data.subscribers.push(subscriber);
    await this.persist();
    return {
      subscriber: this.stripSecret(subscriber),
      secret,
    };
  }

  async deleteSubscriber(id: string): Promise<boolean> {
    const before = this.data.subscribers.length;
    this.data.subscribers = this.data.subscribers.filter((item) => item.id !== id);
    if (this.data.subscribers.length !== before) {
      await this.persist();
      return true;
    }
    return false;
  }

  async setEnabled(id: string, enabled: boolean): Promise<IntegrationSubscriber | null> {
    const subscriber = this.data.subscribers.find((item) => item.id === id);
    if (!subscriber) {
      return null;
    }
    subscriber.enabled = enabled;
    subscriber.updatedAt = new Date().toISOString();
    await this.persist();
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
    const subscriber = this.data.subscribers.find((item) => item.id === input.id);
    if (!subscriber) {
      return;
    }
    if (input.ok) {
      subscriber.lastSuccessAt = new Date().toISOString();
      subscriber.lastError = undefined;
    } else {
      subscriber.lastError = String(input.error || "delivery_failed");
    }
    subscriber.updatedAt = new Date().toISOString();
    await this.persist();
  }

  async updateStats(patch: Partial<IntegrationBridgeStorageShape["stats"]>) {
    this.data.stats = {
      ...this.data.stats,
      ...patch,
    };
    await this.persist();
  }

  getStats(): IntegrationBridgeStorageShape["stats"] {
    return {
      ...this.data.stats,
    };
  }

  getById(id: string): IntegrationSubscriber | null {
    const subscriber = this.data.subscribers.find((item) => item.id === id);
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
}
