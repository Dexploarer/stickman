import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const trustScoring = require("../.github/trust-scoring.cjs") as {
  DEFAULT_CONFIG: Record<string, unknown>;
  addEvent: (state: Record<string, unknown>, event: Record<string, unknown>) => Record<string, unknown>;
  compactState: (state: Record<string, unknown>) => Record<string, unknown>;
  computeTrustScore: (
    state: Record<string, unknown>,
    config?: Record<string, unknown>,
    now?: number,
  ) => {
    score: number;
    tier: string;
    breakdown: {
      perEvent: Array<{ type: string; points: number; modifiers: Record<string, unknown> }>;
    };
  };
  createContributorState: (contributor: string, now?: number) => Record<string, unknown>;
  expandState: (state: Record<string, unknown>) => Record<string, unknown>;
  getTierInfo: (score: number) => { name: string };
};

const { DEFAULT_CONFIG, addEvent, compactState, computeTrustScore, createContributorState, expandState, getTierInfo } =
  trustScoring;

const DAY_MS = 24 * 60 * 60 * 1000;

describe("contributor trust scoring", () => {
  it("encodes events in compact storage format", () => {
    const now = Date.parse("2026-02-18T00:00:00.000Z");
    const state = createContributorState("agent-alice", now);
    const next = addEvent(state, {
      type: "approve",
      timestamp: now,
      linesChanged: 120,
      labels: ["bugfix"],
      prNumber: 42,
    }) as { e: Array<{ y: string; ts: number; l: number; p: number; lb: string[] }> };

    expect(next.e).toHaveLength(1);
    expect(next.e[0]).toEqual({
      y: "a",
      ts: now,
      l: 120,
      p: 42,
      lb: ["bugfix"],
    });
  });

  it("applies diminishing returns across repeated approvals", () => {
    const now = Date.parse("2026-02-18T00:00:00.000Z");
    let state = createContributorState("agent-bob", now);
    state = addEvent(state, {
      type: "approve",
      timestamp: now - DAY_MS,
      linesChanged: 150,
      labels: ["feature"],
      prNumber: 1,
    });
    state = addEvent(state, {
      type: "approve",
      timestamp: now,
      linesChanged: 150,
      labels: ["feature"],
      prNumber: 2,
    });

    const result = computeTrustScore(state, DEFAULT_CONFIG, now);
    const approvals = result.breakdown.perEvent.filter((event) => event.type === "approve");

    expect(approvals).toHaveLength(2);
    expect(approvals[1].points).toBeLessThan(approvals[0].points);
  });

  it("weights recent events higher than old events", () => {
    const now = Date.parse("2026-02-18T00:00:00.000Z");
    const recentState = addEvent(createContributorState("agent-recent", now), {
      type: "approve",
      timestamp: now,
      linesChanged: 120,
      labels: ["bugfix"],
      prNumber: 10,
    });
    const staleState = addEvent(createContributorState("agent-stale", now), {
      type: "approve",
      timestamp: now - 90 * DAY_MS,
      linesChanged: 120,
      labels: ["bugfix"],
      prNumber: 11,
    });

    const recent = computeTrustScore(recentState, DEFAULT_CONFIG, now);
    const stale = computeTrustScore(staleState, DEFAULT_CONFIG, now);

    expect(recent.score).toBeGreaterThan(stale.score);
  });

  it("downgrades massive PRs below xlarge multiplier", () => {
    const now = Date.parse("2026-02-18T00:00:00.000Z");
    const xlargeState = addEvent(createContributorState("agent-xl", now), {
      type: "approve",
      timestamp: now,
      linesChanged: 1200,
      labels: ["feature"],
      prNumber: 20,
    });
    const massiveState = addEvent(createContributorState("agent-massive", now), {
      type: "approve",
      timestamp: now,
      linesChanged: 2000,
      labels: ["feature"],
      prNumber: 21,
    });

    const xlarge = computeTrustScore(xlargeState, DEFAULT_CONFIG, now);
    const massive = computeTrustScore(massiveState, DEFAULT_CONFIG, now);

    expect(xlarge.score).toBeGreaterThan(massive.score);
  });

  it("enforces hard velocity cap by zeroing positive gains", () => {
    const now = Date.parse("2026-02-18T00:00:00.000Z");
    let state = createContributorState("agent-velocity", now);
    for (let index = 0; index < 5; index += 1) {
      state = addEvent(state, {
        type: "approve",
        timestamp: now - index * 60_000,
        linesChanged: 120,
        labels: ["bugfix"],
        prNumber: 100 + index,
      });
    }

    const config = {
      ...DEFAULT_CONFIG,
      velocity: {
        ...(DEFAULT_CONFIG as { velocity: Record<string, unknown> }).velocity,
        softCapPRs: 2,
        hardCapPRs: 3,
      },
      dailyPointCap: 1000,
    };

    const result = computeTrustScore(state, config, now);
    const approvals = result.breakdown.perEvent.filter((event) => event.type === "approve");

    expect(approvals.at(-1)?.points).toBe(0);
    expect(approvals.at(-2)?.points).toBe(0);
  });

  it("enforces daily point caps", () => {
    const now = Date.parse("2026-02-18T00:00:00.000Z");
    const state = addEvent(createContributorState("agent-cap", now), {
      type: "approve",
      timestamp: now,
      linesChanged: 1400,
      labels: ["security"],
      prNumber: 200,
    });

    const config = {
      ...DEFAULT_CONFIG,
      dailyPointCap: 2,
    };

    const result = computeTrustScore(state, config, now);
    const gained = result.score - 35;

    expect(gained).toBeLessThanOrEqual(2);
  });

  it("applies inactivity decay after grace period", () => {
    const baseTime = Date.parse("2026-01-01T00:00:00.000Z");
    let state = createContributorState("agent-decay", baseTime);

    for (let index = 0; index < 10; index += 1) {
      state = addEvent(state, {
        type: "approve",
        timestamp: baseTime + index * 1_000,
        linesChanged: 500,
        labels: ["core"],
        prNumber: 300 + index,
      });
    }

    const immediate = computeTrustScore(state, DEFAULT_CONFIG, baseTime + 20_000);
    const later = computeTrustScore(state, DEFAULT_CONFIG, baseTime + 180 * DAY_MS);

    expect(later.score).toBeLessThan(immediate.score);
    expect(later.score).toBeGreaterThanOrEqual(30);
  });

  it("maps score bands to expected tiers", () => {
    expect(getTierInfo(95).name).toBe("legendary");
    expect(getTierInfo(80).name).toBe("trusted");
    expect(getTierInfo(63).name).toBe("established");
    expect(getTierInfo(50).name).toBe("contributing");
    expect(getTierInfo(35).name).toBe("probationary");
    expect(getTierInfo(20).name).toBe("untested");
    expect(getTierInfo(5).name).toBe("restricted");
  });

  it("penalizes critical rejections more than trivial rejections", () => {
    const now = Date.parse("2026-02-18T00:00:00.000Z");
    const critical = addEvent(createContributorState("agent-critical", now), {
      type: "reject",
      timestamp: now,
      linesChanged: 300,
      labels: ["core"],
      prNumber: 400,
      reviewSeverity: "critical",
    });
    const trivial = addEvent(createContributorState("agent-trivial", now), {
      type: "reject",
      timestamp: now,
      linesChanged: 300,
      labels: ["core"],
      prNumber: 401,
      reviewSeverity: "trivial",
    });

    const criticalResult = computeTrustScore(critical, DEFAULT_CONFIG, now);
    const trivialResult = computeTrustScore(trivial, DEFAULT_CONFIG, now);

    expect(criticalResult.score).toBeLessThan(trivialResult.score);
  });

  it("round-trips compact and expanded state", () => {
    const now = Date.parse("2026-02-18T00:00:00.000Z");
    const compact = addEvent(createContributorState("agent-roundtrip", now), {
      type: "approve",
      timestamp: now,
      linesChanged: 111,
      labels: ["test"],
      prNumber: 500,
    });
    const expanded = expandState(compact);
    const packed = compactState(expanded);

    expect((packed as { c: string }).c).toBe("agent-roundtrip");
    expect((packed as { e: Array<{ y: string }> }).e[0].y).toBe("a");
  });
});
