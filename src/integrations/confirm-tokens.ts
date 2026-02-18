import { createHash, randomUUID } from "node:crypto";

import type { IntegrationConfirmTokenRecord } from "../types.js";

const tokenStore = new Map<string, IntegrationConfirmTokenRecord>();

const stableStringify = (value: unknown): string => {
  if (value == null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(",")}}`;
};

export const buildConfirmPayloadHash = (payload: unknown): string => {
  const stable = stableStringify(payload);
  return createHash("sha256").update(stable).digest("hex");
};

export const issueConfirmToken = (payloadHash: string, ttlMs = 5 * 60_000): IntegrationConfirmTokenRecord => {
  const now = Date.now();
  const record: IntegrationConfirmTokenRecord = {
    token: randomUUID(),
    payloadHash,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
  tokenStore.set(record.token, record);
  return record;
};

export const consumeConfirmToken = (
  token: string,
  payloadHash: string,
): { ok: true; record: IntegrationConfirmTokenRecord } | { ok: false; code: "confirm_required" | "confirm_expired" | "confirm_mismatch" | "confirm_used" } => {
  const trimmed = String(token || "").trim();
  if (!trimmed) {
    return { ok: false, code: "confirm_required" };
  }
  const record = tokenStore.get(trimmed);
  if (!record) {
    return { ok: false, code: "confirm_required" };
  }
  if (record.consumedAt) {
    return { ok: false, code: "confirm_used" };
  }
  if (new Date(record.expiresAt).getTime() <= Date.now()) {
    return { ok: false, code: "confirm_expired" };
  }
  if (record.payloadHash !== payloadHash) {
    return { ok: false, code: "confirm_mismatch" };
  }
  record.consumedAt = new Date().toISOString();
  tokenStore.set(trimmed, record);
  return { ok: true, record };
};
