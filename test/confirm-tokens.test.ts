import { describe, expect, it } from "bun:test";

import { buildConfirmPayloadHash, consumeConfirmToken, issueConfirmToken } from "../src/integrations/confirm-tokens.ts";

describe("integrations/confirm-tokens", () => {
  it("buildConfirmPayloadHash is stable across key order", () => {
    const first = buildConfirmPayloadHash({
      action: "run",
      payload: {
        alpha: 1,
        bravo: 2,
      },
    });
    const second = buildConfirmPayloadHash({
      payload: {
        bravo: 2,
        alpha: 1,
      },
      action: "run",
    });

    expect(first).toBe(second);
    expect(first.length).toBeGreaterThan(10);
  });

  it("buildConfirmPayloadHash respects array ordering", () => {
    const forward = buildConfirmPayloadHash(["a", "b", "c"]);
    const reverse = buildConfirmPayloadHash(["c", "b", "a"]);

    expect(forward).not.toBe(reverse);
  });

  it("issues a token and validates payload hash", () => {
    const payloadHash = buildConfirmPayloadHash({ action: "publish", id: 12 });
    const token = issueConfirmToken(payloadHash);

    const result = consumeConfirmToken(token.token, payloadHash);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.token).toBe(token.token);
      expect(result.record.consumedAt).toBeDefined();
    }
  });

  it("rejects missing, mismatched, and reused tokens", () => {
    const payloadHash = buildConfirmPayloadHash({ action: "deploy", id: 77 });
    const token = issueConfirmToken(payloadHash);

    expect(consumeConfirmToken("", payloadHash)).toEqual({ ok: false, code: "confirm_required" });
    expect(consumeConfirmToken("missing-token", payloadHash)).toEqual({ ok: false, code: "confirm_required" });
    expect(consumeConfirmToken(token.token, "different-hash")).toEqual({ ok: false, code: "confirm_mismatch" });

    const firstUse = consumeConfirmToken(token.token, payloadHash);
    expect(firstUse.ok).toBe(true);
    expect(consumeConfirmToken(token.token, payloadHash)).toEqual({ ok: false, code: "confirm_used" });
  });

  it("rejects expired tokens", () => {
    const payloadHash = buildConfirmPayloadHash({ action: "archive", id: 101 });
    const token = issueConfirmToken(payloadHash, -1);

    expect(consumeConfirmToken(token.token, payloadHash)).toEqual({ ok: false, code: "confirm_expired" });
  });
});
