export const CONTEXT_STORAGE_KEYS = {
  inbox: "prompt-or-die-social-suite.context-inbox.v1",
  utilityRail: "prompt-or-die-social-suite.ui-utility-rail.v1",
  prefs: "prompt-or-die-social-suite.context-prefs.v1",
};

export const CONTEXT_MENU_ACTION_IDS = [
  "post.append_to_composer",
  "post.replace_composer",
  "post.build_thread_outline",
  "tools.prefill_planner_goal",
  "tools.prefill_mission_query",
  "tools.prefill_command_studio",
  "knowledge.capture",
  "chat.prefill_prompt",
];

export const CONTEXT_ACTION_ID_SET = new Set(CONTEXT_MENU_ACTION_IDS);

const toSafeString = (value, maxLength = 12000) => {
  if (typeof value !== "string") {
    return "";
  }
  return value.slice(0, maxLength);
};

const toSafeNumber = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
};

const toSafeBool = (value) => Boolean(value);

export const normalizeContextSourcePayload = (payload) => ({
  selectionText: toSafeString(payload?.selectionText).trim(),
  linkURL: toSafeString(payload?.linkURL, 2000).trim(),
  pageURL: toSafeString(payload?.pageURL, 2000).trim(),
  isEditable: toSafeBool(payload?.isEditable),
  mediaType: toSafeString(payload?.mediaType, 80).trim(),
  x: toSafeNumber(payload?.x),
  y: toSafeNumber(payload?.y),
  ts: toSafeNumber(payload?.ts, Date.now()),
  sourceHint: toSafeString(payload?.sourceHint, 120).trim() || "unknown",
});

export const resolveContextText = (context) => {
  const normalized = normalizeContextSourcePayload(context);
  if (normalized.selectionText) {
    return normalized.selectionText;
  }
  if (normalized.linkURL) {
    return normalized.linkURL;
  }
  if (normalized.pageURL) {
    return normalized.pageURL;
  }
  return "";
};

export const buildThreadOutline = (seedText, linkURL = "") => {
  const base = String(seedText || "").trim();
  const headline = base || "Core signal";
  const linkLine = linkURL ? `\n\nReference: ${linkURL}` : "";
  return [
    `1/ Hook: ${headline.slice(0, 180)}`,
    "2/ Why it matters:",
    "3/ Evidence:",
    "4/ What to do next:",
    "5/ CTA:",
  ].join("\n") + linkLine;
};

export const deriveContextTags = (actionId, context) => {
  const normalized = normalizeContextSourcePayload(context);
  const sample = `${normalized.selectionText} ${normalized.linkURL}`.toLowerCase();
  const tags = new Set();
  if (String(actionId || "").startsWith("post.")) {
    tags.add("tweet");
  }
  if (actionId === "tools.prefill_planner_goal" || actionId === "tools.prefill_mission_query") {
    tags.add("mission");
  }
  if (actionId === "tools.prefill_command_studio" || actionId === "chat.prefill_prompt") {
    tags.add("prompt");
  }
  if (actionId === "knowledge.capture") {
    tags.add("knowledge");
  }
  if (normalized.linkURL) {
    tags.add("link");
  }
  if (/(trend|algorithm|viral|signal)/.test(sample)) {
    tags.add("trend");
  }
  if (/(prompt|brief|thread|angle|idea)/.test(sample)) {
    tags.add("prompt");
  }
  if (/(tweet|post|x\.com|twitter)/.test(sample)) {
    tags.add("tweet");
  }
  return [...tags].slice(0, 8);
};

const contextId = (seedTs = Date.now()) =>
  `ctx-${Math.max(0, Number(seedTs) || Date.now()).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const normalizeContextInboxItem = (item, index = 0) => {
  if (!item || typeof item !== "object") {
    return null;
  }
  const id = toSafeString(item.id, 80).trim() || contextId(Date.now() + index);
  const text = toSafeString(item.text, 8000).trim();
  if (!text) {
    return null;
  }
  const tags = Array.isArray(item.tags)
    ? [...new Set(item.tags.map((tag) => toSafeString(tag, 32).trim().toLowerCase()).filter(Boolean))].slice(0, 8)
    : [];
  const source = toSafeString(item.source, 200).trim() || "context";
  const createdAt = toSafeString(item.createdAt, 60).trim() || new Date().toISOString();
  const consumedBy = toSafeString(item.consumedBy, 80).trim();
  return {
    id,
    text,
    tags,
    source,
    createdAt,
    pinned: toSafeBool(item.pinned),
    consumedBy: consumedBy || undefined,
  };
};

export const sortContextInboxItems = (items) => {
  return [...items].sort((left, right) => {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }
    return String(right.createdAt).localeCompare(String(left.createdAt));
  });
};

export const upsertContextInboxItem = (items, nextItem, maxItems = 120) => {
  const existing = Array.isArray(items) ? items.map((item, index) => normalizeContextInboxItem(item, index)).filter(Boolean) : [];
  const normalizedNext = normalizeContextInboxItem(nextItem);
  if (!normalizedNext) {
    return sortContextInboxItems(existing).slice(0, maxItems);
  }
  const deduped = existing.filter((item) => item.id !== normalizedNext.id);
  deduped.unshift(normalizedNext);
  return sortContextInboxItems(deduped).slice(0, maxItems);
};

export const readPersistedJSON = (storage, key, fallback) => {
  try {
    const raw = storage?.getItem?.(key);
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
};

export const writePersistedJSON = (storage, key, value) => {
  try {
    storage?.setItem?.(key, JSON.stringify(value));
  } catch {
    // keep UI responsive even if local storage is blocked
  }
};

export const createContextInboxItem = (actionId, context, nowIso = new Date().toISOString()) => {
  const normalized = normalizeContextSourcePayload(context);
  const text = resolveContextText(normalized);
  return normalizeContextInboxItem({
    id: contextId(normalized.ts),
    text,
    tags: deriveContextTags(actionId, normalized),
    source: normalized.sourceHint || "context",
    createdAt: nowIso,
    pinned: false,
  });
};

const requiresText = (actionId) => actionId !== "knowledge.capture";

export const runContextAction = (actionId, contextPayload, handlers = {}) => {
  const action = String(actionId || "").trim();
  if (!CONTEXT_ACTION_ID_SET.has(action)) {
    return { ok: false, ignored: true, reason: "unknown_action", actionId: action };
  }
  const context = normalizeContextSourcePayload(contextPayload);
  const text = resolveContextText(context);
  if (requiresText(action) && !text) {
    return { ok: false, ignored: true, reason: "empty_context", actionId: action };
  }

  if (action === "post.append_to_composer") {
    handlers.setComposerDraft?.({ mode: "append", text, context, actionId: action });
    return { ok: true, actionId: action, effect: "composer.append" };
  }
  if (action === "post.replace_composer") {
    handlers.setComposerDraft?.({ mode: "replace", text, context, actionId: action });
    return { ok: true, actionId: action, effect: "composer.replace" };
  }
  if (action === "post.build_thread_outline") {
    handlers.setComposerDraft?.({
      mode: "replace",
      text: buildThreadOutline(text, context.linkURL),
      context,
      actionId: action,
    });
    return { ok: true, actionId: action, effect: "composer.thread_outline" };
  }
  if (action === "tools.prefill_planner_goal") {
    handlers.prefillPlannerGoal?.({ text, context, actionId: action });
    return { ok: true, actionId: action, effect: "planner.prefill_goal" };
  }
  if (action === "tools.prefill_mission_query") {
    handlers.prefillMissionQuery?.({ text, context, actionId: action });
    return { ok: true, actionId: action, effect: "mission.prefill_query" };
  }
  if (action === "tools.prefill_command_studio") {
    handlers.prefillCommandStudio?.({ text, context, actionId: action });
    return { ok: true, actionId: action, effect: "command.prefill" };
  }
  if (action === "chat.prefill_prompt") {
    handlers.prefillChatPrompt?.({ text, context, actionId: action });
    return { ok: true, actionId: action, effect: "chat.prefill" };
  }
  if (action === "knowledge.capture") {
    const item = createContextInboxItem(action, context);
    if (!item) {
      return { ok: false, ignored: true, reason: "empty_context", actionId: action };
    }
    handlers.captureKnowledge?.({ item, context, actionId: action });
    return { ok: true, actionId: action, effect: "knowledge.capture", item };
  }
  return { ok: false, ignored: true, reason: "unhandled_action", actionId: action };
};
