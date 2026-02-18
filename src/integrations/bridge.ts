import { createHmac, randomUUID } from "node:crypto";

import type { IntegrationBridgeStatus } from "../types.js";
import type { IntegrationBridgeEvent, IntegrationSubscriber } from "./types.js";
import { IntegrationSubscriptionStore } from "./subscriptions.js";
import { LivekitControlPublisher } from "./livekit-bridge.js";

const retryDelaysMs = [1000, 3000, 9000];

const matchesEventPattern = (patterns: string[], eventType: string): boolean => {
  if (patterns.includes("*")) {
    return true;
  }
  for (const pattern of patterns) {
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      if (eventType.startsWith(prefix)) {
        return true;
      }
    }
    if (pattern === eventType) {
      return true;
    }
  }
  return false;
};

export class IntegrationBridge {
  private store: IntegrationSubscriptionStore;
  private livekit: LivekitControlPublisher;
  private pending = 0;

  constructor(store: IntegrationSubscriptionStore, livekit: LivekitControlPublisher) {
    this.store = store;
    this.livekit = livekit;
  }

  async ensureReady() {
    await this.store.ensureLoaded();
  }

  private async deliverWithRetry(subscriber: IntegrationSubscriber, event: IntegrationBridgeEvent, attempt: number): Promise<void> {
    const body = JSON.stringify({
      id: event.id,
      type: event.type,
      ts: event.ts,
      payload: event.payload,
    });
    const signature = createHmac("sha256", subscriber.secret).update(body).digest("hex");
    try {
      const response = await fetch(subscriber.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-stickman-signature": `sha256=${signature}`,
          "x-stickman-event-id": event.id,
          "x-stickman-event-type": event.type,
          "x-stickman-attempt": String(attempt),
        },
        body,
      });
      if (!response.ok) {
        throw new Error(`webhook returned ${response.status}`);
      }
      this.pending = Math.max(0, this.pending - 1);
      await this.store.updateDeliveryResult({ id: subscriber.id, ok: true });
      const stats = this.store.getStats();
      await this.store.updateStats({
        delivered: stats.delivered + 1,
        lastDeliveryAt: new Date().toISOString(),
      });
    } catch (error) {
      if (attempt < retryDelaysMs.length) {
        const stats = this.store.getStats();
        await this.store.updateStats({
          retriesScheduled: stats.retriesScheduled + 1,
        });
        setTimeout(() => {
          void this.deliverWithRetry(subscriber, event, attempt + 1);
        }, retryDelaysMs[attempt - 1]);
        return;
      }
      this.pending = Math.max(0, this.pending - 1);
      const message = error instanceof Error ? error.message : String(error);
      await this.store.updateDeliveryResult({ id: subscriber.id, ok: false, error: message });
      const stats = this.store.getStats();
      await this.store.updateStats({
        failed: stats.failed + 1,
        lastDeliveryAt: new Date().toISOString(),
      });
    }
  }

  async emit(event: IntegrationBridgeEvent): Promise<void> {
    await this.ensureReady();
    if (!event.type.startsWith("integration_")) {
      return;
    }
    const subscribers = this.store
      .listSubscribers()
      .filter((subscriber) => subscriber.enabled && matchesEventPattern(subscriber.events, event.type));
    const stats = this.store.getStats();
    await this.store.updateStats({
      lastEventAt: event.ts || new Date().toISOString(),
      delivered: stats.delivered,
      failed: stats.failed,
      retriesScheduled: stats.retriesScheduled,
    });
    for (const subscriber of subscribers) {
      this.pending += 1;
      void this.deliverWithRetry(subscriber, event, 1);
    }
    await this.livekit.publish(event);
  }

  async getStatus(): Promise<IntegrationBridgeStatus> {
    await this.ensureReady();
    const subscribers = this.store.listSubscribers();
    const stats = this.store.getStats();
    return {
      subscribersTotal: subscribers.length,
      subscribersEnabled: subscribers.filter((subscriber) => subscriber.enabled).length,
      queueDepth: this.pending,
      delivered: stats.delivered,
      failed: stats.failed,
      retriesScheduled: stats.retriesScheduled,
      lastDeliveryAt: stats.lastDeliveryAt,
      lastEventAt: stats.lastEventAt,
      livekit: this.livekit.getStatus(),
    };
  }

  async listSubscribers() {
    await this.ensureReady();
    return this.store.listSubscribers().map((subscriber) => this.store.stripSecret(subscriber));
  }

  async createSubscriber(input: { url: string; events?: string[] }) {
    await this.ensureReady();
    return this.store.createSubscriber(input);
  }

  async setSubscriberEnabled(id: string, enabled: boolean) {
    await this.ensureReady();
    const subscriber = await this.store.setEnabled(id, enabled);
    return subscriber ? this.store.stripSecret(subscriber) : null;
  }

  async deleteSubscriber(id: string) {
    await this.ensureReady();
    return this.store.deleteSubscriber(id);
  }

  async testSubscriber(id: string) {
    await this.ensureReady();
    const subscriber = this.store.getById(id);
    if (!subscriber) {
      return false;
    }
    const event: IntegrationBridgeEvent = {
      id: randomUUID(),
      type: "integration_test_event",
      ts: new Date().toISOString(),
      payload: {
        test: true,
        subscriberId: id,
      },
    };
    this.pending += 1;
    void this.deliverWithRetry(subscriber, event, 1);
    return true;
  }
}
