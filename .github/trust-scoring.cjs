"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

const EVENT_CODE_MAP = {
  approve: "a",
  reject: "r",
  close: "c",
  selfClose: "s",
};

const CODE_EVENT_MAP = {
  a: "approve",
  r: "reject",
  c: "close",
  s: "selfClose",
};

const DEFAULT_CONFIG = Object.freeze({
  initialScore: 35,
  diminishingRate: 0.2,
  recencyHalfLifeDays: 45,
  dailyPointCap: 35,
  basePoints: Object.freeze({
    approve: 8,
    reject: 10,
    close: 2,
  }),
  approvalStreakBonus: 0.08,
  approvalStreakCapMultiplier: 1.5,
  rejectionStreakPenaltyRate: 0.15,
  rejectionStreakPenaltyCap: 2.5,
  velocity: Object.freeze({
    softCapPRs: 10,
    hardCapPRs: 25,
    penaltyPerPR: 0.15,
    windowDays: 7,
  }),
  inactivity: Object.freeze({
    gracePeriodDays: 10,
    decayRatePerDay: 0.005,
    decayFloor: 30,
    decayTarget: 40,
  }),
  complexityMultipliers: Object.freeze([
    Object.freeze({ maxLines: 10, multiplier: 0.4, label: "trivial" }),
    Object.freeze({ maxLines: 50, multiplier: 0.7, label: "small" }),
    Object.freeze({ maxLines: 150, multiplier: 1.0, label: "medium" }),
    Object.freeze({ maxLines: 500, multiplier: 1.3, label: "large" }),
    Object.freeze({ maxLines: 1500, multiplier: 1.5, label: "xlarge" }),
    Object.freeze({ maxLines: Number.POSITIVE_INFINITY, multiplier: 1.2, label: "massive" }),
  ]),
  categoryMultipliers: Object.freeze({
    security: 1.8,
    "critical-fix": 1.5,
    core: 1.3,
    feature: 1.1,
    bugfix: 1.0,
    refactor: 0.9,
    test: 0.8,
    docs: 0.6,
    chore: 0.5,
    aesthetic: 0.4,
  }),
  defaultCategoryMultiplier: 0.8,
  reviewSeverityMultipliers: Object.freeze({
    critical: 1.8,
    major: 1.3,
    normal: 1.0,
    minor: 0.5,
    trivial: 0.3,
  }),
  tiers: Object.freeze([
    Object.freeze({
      name: "legendary",
      minScore: 90,
      maxScore: 100,
      meaning: "Auto-merge eligible",
    }),
    Object.freeze({
      name: "trusted",
      minScore: 75,
      maxScore: 89,
      meaning: "Expedited review",
    }),
    Object.freeze({
      name: "established",
      minScore: 60,
      maxScore: 74,
      meaning: "Proven track record",
    }),
    Object.freeze({
      name: "contributing",
      minScore: 45,
      maxScore: 59,
      meaning: "Standard review",
    }),
    Object.freeze({
      name: "probationary",
      minScore: 30,
      maxScore: 44,
      meaning: "Closer scrutiny",
    }),
    Object.freeze({
      name: "untested",
      minScore: 15,
      maxScore: 29,
      meaning: "New contributor",
    }),
    Object.freeze({
      name: "restricted",
      minScore: 0,
      maxScore: 14,
      meaning: "Trust deficit, needs sponsor",
    }),
  ]),
});

const HIGH_VELOCITY_CONFIG = Object.freeze({
  ...DEFAULT_CONFIG,
  initialScore: 40,
  diminishingRate: 0.08,
  dailyPointCap: 80,
  velocity: Object.freeze({
    ...DEFAULT_CONFIG.velocity,
    softCapPRs: 80,
    hardCapPRs: 200,
  }),
});

function withConfig(customConfig) {
  if (!customConfig) {
    return DEFAULT_CONFIG;
  }
  return {
    ...DEFAULT_CONFIG,
    ...customConfig,
    basePoints: { ...DEFAULT_CONFIG.basePoints, ...(customConfig.basePoints ?? {}) },
    velocity: { ...DEFAULT_CONFIG.velocity, ...(customConfig.velocity ?? {}) },
    inactivity: { ...DEFAULT_CONFIG.inactivity, ...(customConfig.inactivity ?? {}) },
    categoryMultipliers: {
      ...DEFAULT_CONFIG.categoryMultipliers,
      ...(customConfig.categoryMultipliers ?? {}),
    },
    reviewSeverityMultipliers: {
      ...DEFAULT_CONFIG.reviewSeverityMultipliers,
      ...(customConfig.reviewSeverityMultipliers ?? {}),
    },
    complexityMultipliers: customConfig.complexityMultipliers ?? DEFAULT_CONFIG.complexityMultipliers,
    tiers: customConfig.tiers ?? DEFAULT_CONFIG.tiers,
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toDayKey(timestampMs) {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function normalizeLabels(labels) {
  if (!Array.isArray(labels)) {
    return [];
  }
  return labels.map((label) => String(label).trim().toLowerCase()).filter(Boolean);
}

function normalizeEvent(rawEvent) {
  const type = String(rawEvent?.type ?? "").trim();
  if (!EVENT_CODE_MAP[type]) {
    throw new Error(`Unknown event type: ${type}`);
  }

  const timestamp = Number(rawEvent?.timestamp ?? Date.now());
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid timestamp: ${rawEvent?.timestamp}`);
  }

  const linesChanged = Math.max(0, Number(rawEvent?.linesChanged ?? 0));
  const labels = normalizeLabels(rawEvent?.labels);
  const prNumber =
    rawEvent?.prNumber === undefined || rawEvent?.prNumber === null
      ? undefined
      : Number(rawEvent.prNumber);
  const reviewSeverity = rawEvent?.reviewSeverity
    ? String(rawEvent.reviewSeverity).trim().toLowerCase()
    : undefined;

  return {
    type,
    timestamp,
    linesChanged: Number.isFinite(linesChanged) ? linesChanged : 0,
    labels,
    prNumber: Number.isFinite(prNumber) ? prNumber : undefined,
    reviewSeverity,
  };
}

function toCompactEvent(event) {
  const normalized = normalizeEvent(event);
  const compact = {
    y: EVENT_CODE_MAP[normalized.type],
    ts: normalized.timestamp,
  };

  if (normalized.linesChanged > 0) {
    compact.l = normalized.linesChanged;
  }
  if (normalized.labels.length > 0) {
    compact.lb = normalized.labels;
  }
  if (typeof normalized.prNumber === "number") {
    compact.p = normalized.prNumber;
  }
  if (normalized.reviewSeverity) {
    compact.rv = normalized.reviewSeverity;
  }

  return compact;
}

function fromCompactEvent(compactEvent) {
  const type = CODE_EVENT_MAP[compactEvent?.y];
  if (!type) {
    throw new Error(`Unknown compact event code: ${compactEvent?.y}`);
  }
  return normalizeEvent({
    type,
    timestamp: compactEvent.ts,
    linesChanged: compactEvent.l ?? 0,
    labels: compactEvent.lb ?? [],
    prNumber: compactEvent.p,
    reviewSeverity: compactEvent.rv,
  });
}

function createContributorState(contributor, now = Date.now()) {
  return {
    c: String(contributor),
    t: Number(now),
    m: 0,
    e: [],
  };
}

function expandState(state) {
  if (!state || typeof state !== "object") {
    throw new Error("State is required");
  }
  if (Array.isArray(state.events)) {
    return {
      contributor: String(state.contributor),
      createdAt: Number(state.createdAt ?? Date.now()),
      manualAdjustment: Number(state.manualAdjustment ?? 0),
      events: state.events.map((event) => normalizeEvent(event)),
    };
  }

  const compactEvents = Array.isArray(state.e) ? state.e : [];
  return {
    contributor: String(state.c ?? state.contributor ?? "unknown"),
    createdAt: Number(state.t ?? state.createdAt ?? Date.now()),
    manualAdjustment: Number(state.m ?? state.manualAdjustment ?? 0),
    events: compactEvents.map((event) => fromCompactEvent(event)),
  };
}

function compactState(state) {
  const expanded = expandState(state);
  return {
    c: expanded.contributor,
    t: expanded.createdAt,
    m: expanded.manualAdjustment,
    e: expanded.events.map((event) => toCompactEvent(event)),
  };
}

function addEvent(state, event) {
  const normalized = toCompactEvent(event);
  const compact = compactState(state);
  return {
    ...compact,
    e: [...compact.e, normalized].sort((a, b) => a.ts - b.ts),
  };
}

function getComplexityBucket(linesChanged, config) {
  const lines = Math.max(0, Number(linesChanged) || 0);
  for (const bucket of config.complexityMultipliers) {
    if (lines <= bucket.maxLines) {
      return bucket;
    }
  }
  return config.complexityMultipliers[config.complexityMultipliers.length - 1];
}

function getCategoryMultiplier(labels, config) {
  const normalizedLabels = normalizeLabels(labels);
  let bestLabel = null;
  let bestMultiplier = config.defaultCategoryMultiplier;

  for (const label of normalizedLabels) {
    const multiplier = config.categoryMultipliers[label];
    if (typeof multiplier === "number" && multiplier > bestMultiplier) {
      bestMultiplier = multiplier;
      bestLabel = label;
    }
  }

  return {
    label: bestLabel,
    multiplier: bestMultiplier,
  };
}

function getTierInfo(score, tiers = DEFAULT_CONFIG.tiers) {
  const sorted = [...tiers].sort((a, b) => b.minScore - a.minScore);
  const found = sorted.find((tier) => score >= tier.minScore) ?? sorted[sorted.length - 1];
  return {
    name: found.name,
    minScore: found.minScore,
    maxScore: found.maxScore,
    meaning: found.meaning,
  };
}

function countWindowEvents(events, index, windowDays) {
  const current = events[index];
  const windowStart = current.timestamp - windowDays * DAY_MS;
  let count = 0;
  for (let i = 0; i <= index; i += 1) {
    const candidate = events[i];
    if (candidate.type === "selfClose") {
      continue;
    }
    if (candidate.timestamp >= windowStart && candidate.timestamp <= current.timestamp) {
      count += 1;
    }
  }
  return count;
}

function inferReviewSeverityFromLabels(labels = []) {
  const normalized = normalizeLabels(labels);
  if (normalized.includes("critical") || normalized.includes("severity:critical")) {
    return "critical";
  }
  if (normalized.includes("major") || normalized.includes("severity:major")) {
    return "major";
  }
  if (normalized.includes("minor") || normalized.includes("severity:minor")) {
    return "minor";
  }
  if (normalized.includes("trivial") || normalized.includes("severity:trivial")) {
    return "trivial";
  }
  return "normal";
}

function computeTrustScore(state, customConfig, now = Date.now()) {
  const config = withConfig(customConfig);
  const expanded = expandState(state);
  const events = [...expanded.events].sort((a, b) => a.timestamp - b.timestamp);

  let score = config.initialScore + expanded.manualAdjustment;
  let priorApprovals = 0;
  let approvalStreak = 0;
  let rejectionStreak = 0;

  const dailyPositivePoints = new Map();
  const warnings = [];

  const breakdown = {
    initialScore: config.initialScore,
    manualAdjustment: expanded.manualAdjustment,
    eventCount: events.length,
    positivePoints: 0,
    negativePoints: 0,
    dailyCapHits: 0,
    velocitySoftHits: 0,
    velocityHardHits: 0,
    inactivityDays: 0,
    decayApplied: 0,
    rawScoreBeforeDecay: 0,
    finalScore: 0,
    perEvent: [],
  };

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const daysSinceEvent = Math.max(0, (now - event.timestamp) / DAY_MS);
    const recencyWeight = Math.pow(0.5, daysSinceEvent / config.recencyHalfLifeDays);
    const complexity = getComplexityBucket(event.linesChanged, config);
    const category = getCategoryMultiplier(event.labels, config);

    const windowCount = countWindowEvents(events, index, config.velocity.windowDays);
    let velocityMultiplier = 1;

    if (windowCount > config.velocity.hardCapPRs) {
      velocityMultiplier = 0;
      breakdown.velocityHardHits += 1;
      warnings.push(
        `Hard velocity cap triggered on event ${index + 1} (${windowCount}/${config.velocity.hardCapPRs})`,
      );
    } else if (windowCount > config.velocity.softCapPRs) {
      const overSoftCap = windowCount - config.velocity.softCapPRs;
      velocityMultiplier = Math.max(0, 1 - config.velocity.penaltyPerPR * overSoftCap);
      breakdown.velocitySoftHits += 1;
    }

    let rawPoints = 0;
    let points = 0;
    let severityMultiplier = 1;
    let streakMultiplier = 1;
    let diminishingMultiplier = 1;

    if (event.type === "approve") {
      diminishingMultiplier = 1 / (1 + config.diminishingRate * Math.log(1 + priorApprovals));
      approvalStreak += 1;
      rejectionStreak = 0;

      streakMultiplier = Math.min(
        1 + config.approvalStreakBonus * Math.max(0, approvalStreak - 1),
        config.approvalStreakCapMultiplier,
      );

      rawPoints =
        config.basePoints.approve *
        diminishingMultiplier *
        recencyWeight *
        complexity.multiplier *
        category.multiplier *
        streakMultiplier;

      points = rawPoints * velocityMultiplier;

      if (points > 0) {
        const dayKey = toDayKey(event.timestamp);
        const dayTotal = dailyPositivePoints.get(dayKey) ?? 0;
        const remaining = Math.max(0, config.dailyPointCap - dayTotal);
        const capped = Math.min(points, remaining);

        if (capped < points) {
          breakdown.dailyCapHits += 1;
          warnings.push(`Daily point cap clipped approval event ${index + 1}`);
        }

        points = capped;
        dailyPositivePoints.set(dayKey, dayTotal + points);
      }

      priorApprovals += 1;
    } else if (event.type === "reject") {
      approvalStreak = 0;
      rejectionStreak += 1;

      const severity = event.reviewSeverity ?? inferReviewSeverityFromLabels(event.labels);
      severityMultiplier = config.reviewSeverityMultipliers[severity] ?? 1;

      streakMultiplier = Math.min(
        Math.pow(1 + config.rejectionStreakPenaltyRate, Math.max(0, rejectionStreak - 1)),
        config.rejectionStreakPenaltyCap,
      );

      rawPoints =
        -config.basePoints.reject *
        severityMultiplier *
        recencyWeight *
        complexity.multiplier *
        category.multiplier *
        streakMultiplier;
      points = rawPoints;
    } else if (event.type === "close") {
      approvalStreak = 0;
      rejectionStreak = 0;
      rawPoints = -config.basePoints.close * recencyWeight;
      points = rawPoints;
    } else {
      rawPoints = 0;
      points = 0;
    }

    score += points;

    if (points > 0) {
      breakdown.positivePoints += points;
    } else {
      breakdown.negativePoints += points;
    }

    breakdown.perEvent.push({
      type: event.type,
      timestamp: event.timestamp,
      prNumber: event.prNumber,
      linesChanged: event.linesChanged,
      labels: event.labels,
      rawPoints,
      points,
      modifiers: {
        recencyWeight,
        complexityMultiplier: complexity.multiplier,
        complexityLabel: complexity.label,
        categoryMultiplier: category.multiplier,
        categoryLabel: category.label,
        severityMultiplier,
        streakMultiplier,
        diminishingMultiplier,
        velocityMultiplier,
        rollingWindowCount: windowCount,
      },
    });
  }

  const lastEventTimestamp = events.length > 0 ? events[events.length - 1].timestamp : expanded.createdAt;
  const inactivityDays = Math.max(0, (now - lastEventTimestamp) / DAY_MS);
  breakdown.inactivityDays = inactivityDays;
  breakdown.rawScoreBeforeDecay = score;

  if (inactivityDays > config.inactivity.gracePeriodDays && score > config.inactivity.decayTarget) {
    const decayingDays = inactivityDays - config.inactivity.gracePeriodDays;
    const decayed =
      config.inactivity.decayTarget +
      (score - config.inactivity.decayTarget) *
        Math.exp(-config.inactivity.decayRatePerDay * decayingDays);
    breakdown.decayApplied = score - decayed;
    score = decayed;
  }

  if (inactivityDays > config.inactivity.gracePeriodDays) {
    score = Math.max(score, config.inactivity.decayFloor);
  }

  score = clamp(score, 0, 100);
  breakdown.finalScore = score;

  const tierInfo = getTierInfo(score, config.tiers);

  return {
    score: Number(score.toFixed(2)),
    tier: tierInfo.name,
    tierInfo,
    breakdown,
    warnings,
  };
}

function readStateFile(filePath) {
  const targetPath = path.resolve(filePath);
  if (!fs.existsSync(targetPath)) {
    return {};
  }
  const raw = fs.readFileSync(targetPath, "utf8").trim();
  if (!raw) {
    return {};
  }
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === "object" && parsed.contributors && typeof parsed.contributors === "object") {
    return parsed.contributors;
  }
  return parsed;
}

function writeStateFile(filePath, stateMap) {
  const targetPath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(stateMap, null, 2)}\n`);
}

function getContributorState(stateMap, contributor, now = Date.now()) {
  const key = String(contributor);
  const existing = stateMap[key];
  if (!existing) {
    return createContributorState(key, now);
  }
  return compactState(existing);
}

function parseArgs(argv) {
  const positional = [];
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        options[key] = next;
        index += 1;
      } else {
        options[key] = true;
      }
      continue;
    }
    positional.push(token);
  }

  return {
    command: positional[0] ?? "help",
    positional: positional.slice(1),
    options,
  };
}

function parseLabels(labelText) {
  if (!labelText) {
    return [];
  }
  return String(labelText)
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
}

function mapReviewStateToEventType(reviewState) {
  const normalized = String(reviewState ?? "").trim().toLowerCase();
  if (normalized === "approved") {
    return "approve";
  }
  if (normalized === "changes_requested") {
    return "reject";
  }
  if (normalized === "dismissed") {
    return "close";
  }
  return "selfClose";
}

function upsertEventFromCli(stateMap, options) {
  const contributor = String(options.contributor ?? "").trim();
  const type = String(options.type ?? "").trim();
  if (!contributor || !type) {
    throw new Error("record requires --contributor and --type");
  }

  const now = options.now ? Number(options.now) : Date.now();
  const event = normalizeEvent({
    type,
    timestamp: now,
    linesChanged: Number(options.lines ?? 0),
    labels: parseLabels(options.labels),
    prNumber: options.pr ? Number(options.pr) : undefined,
    reviewSeverity: options.severity ? String(options.severity).toLowerCase() : undefined,
  });

  const currentState = getContributorState(stateMap, contributor, now);
  const nextState = addEvent(currentState, event);
  stateMap[contributor] = nextState;
  return { contributor, event, nextState };
}

function upsertEventFromReviewPayload(stateMap, options) {
  const eventFile = options["event-file"];
  if (!eventFile) {
    throw new Error("from-review-event requires --event-file");
  }
  const payload = JSON.parse(fs.readFileSync(path.resolve(eventFile), "utf8"));

  const contributor = payload?.pull_request?.user?.login;
  if (!contributor) {
    throw new Error("Could not resolve pull_request.user.login from event payload");
  }

  const labels = Array.isArray(payload?.pull_request?.labels)
    ? payload.pull_request.labels.map((label) => label?.name).filter(Boolean)
    : [];

  const reviewState = payload?.review?.state;
  const type = mapReviewStateToEventType(reviewState);

  const linesChanged =
    Number(payload?.pull_request?.additions ?? 0) + Number(payload?.pull_request?.deletions ?? 0);

  const event = normalizeEvent({
    type,
    timestamp: payload?.review?.submitted_at ? Date.parse(payload.review.submitted_at) : Date.now(),
    linesChanged,
    labels,
    prNumber: Number(payload?.pull_request?.number),
    reviewSeverity: inferReviewSeverityFromLabels(labels),
  });

  const currentState = getContributorState(stateMap, contributor, Date.now());
  const nextState = addEvent(currentState, event);
  return { contributor, event, nextState };
}

function outputJson(payload, outputPath) {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (outputPath) {
    fs.writeFileSync(path.resolve(outputPath), text);
  } else {
    process.stdout.write(text);
  }
}

function printUsage() {
  process.stdout.write(
    [
      "Contributor Trust Scoring",
      "",
      "Commands:",
      "  summary --state-file .github/contributor-trust.json",
      "  score --contributor agent-alice --state-file .github/contributor-trust.json",
      "  record --contributor agent-alice --type approve --lines 120 --labels bugfix,core --pr 42 --state-file .github/contributor-trust.json [--write]",
      "  from-review-event --event-file <GITHUB_EVENT_PATH> --state-file .github/contributor-trust.json [--write]",
      "",
      "Optional:",
      "  --output <path> to write JSON payload to a file",
    ].join("\n"),
  );
}

function runCli() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const stateFile = options["state-file"] ? String(options["state-file"]) : ".github/contributor-trust.json";
  const outputPath = options.output ? String(options.output) : undefined;
  const write = options.write === true || options.write === "true";
  const useHighVelocity = options["high-velocity"] === true || options["high-velocity"] === "true";
  const config = useHighVelocity ? HIGH_VELOCITY_CONFIG : DEFAULT_CONFIG;

  try {
    if (command === "help") {
      printUsage();
      return;
    }

    if (command === "summary") {
      const stateMap = readStateFile(stateFile);
      const now = Date.now();
      const contributors = Object.keys(stateMap)
        .map((contributor) => {
          const result = computeTrustScore(stateMap[contributor], config, now);
          return {
            contributor,
            score: result.score,
            tier: result.tier,
            warnings: result.warnings.length,
          };
        })
        .sort((a, b) => b.score - a.score);

      outputJson({ ok: true, contributors }, outputPath);
      return;
    }

    if (command === "score") {
      const contributor = String(options.contributor ?? "").trim();
      if (!contributor) {
        throw new Error("score requires --contributor");
      }
      const stateMap = readStateFile(stateFile);
      const state = getContributorState(stateMap, contributor, Date.now());
      const result = computeTrustScore(state, config, Date.now());
      outputJson({ ok: true, contributor, result }, outputPath);
      return;
    }

    if (command === "record") {
      const stateMap = readStateFile(stateFile);
      const { contributor, event, nextState } = upsertEventFromCli(stateMap, options);
      const result = computeTrustScore(nextState, config, Date.now());

      if (write) {
        stateMap[contributor] = nextState;
        writeStateFile(stateFile, stateMap);
      }

      outputJson(
        {
          ok: true,
          contributor,
          event,
          result,
          wroteState: write,
          stateFile: path.resolve(stateFile),
        },
        outputPath,
      );
      return;
    }

    if (command === "from-review-event") {
      const stateMap = readStateFile(stateFile);
      const { contributor, event, nextState } = upsertEventFromReviewPayload(stateMap, options);
      const result = computeTrustScore(nextState, config, Date.now());

      if (write) {
        stateMap[contributor] = nextState;
        writeStateFile(stateFile, stateMap);
      }

      outputJson(
        {
          ok: true,
          contributor,
          event,
          result,
          wroteState: write,
          stateFile: path.resolve(stateFile),
        },
        outputPath,
      );
      return;
    }

    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputJson({ ok: false, error: message }, outputPath);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_CONFIG,
  HIGH_VELOCITY_CONFIG,
  addEvent,
  compactState,
  computeTrustScore,
  createContributorState,
  expandState,
  getTierInfo,
  inferReviewSeverityFromLabels,
  readStateFile,
  writeStateFile,
};

if (require.main === module) {
  runCli();
}
