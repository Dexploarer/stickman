import {
  buildThreadOutline,
  CONTEXT_ACTION_ID_SET,
  CONTEXT_STORAGE_KEYS,
  deriveContextTags,
  normalizeContextSourcePayload,
  readPersistedJSON,
  resolveContextText,
  runContextAction,
  upsertContextInboxItem,
  writePersistedJSON,
} from "./context-actions.js";

const HISTORY_KEY = "prompt-or-die-social-suite.history.v1";
const COWORK_CHAT_KEY = "prompt-or-die-social-suite.cowork.chat.v1";
const MAX_HISTORY = 50;
const BLUEPRINT_SHELL_MODE = true;
const DASHBOARD_LAYOUT_KEY = "prompt-or-die-social-suite.dashboard.layout.v1";
const DASHBOARD_VIEW_KEY = "prompt-or-die-social-suite.dashboard.view.v1";
const DASHBOARD_CUSTOM_PANELS_KEY = "prompt-or-die-social-suite.dashboard.custom-panels.v1";
const DASHBOARD_JSON_RENDER_SPEC_KEY = "prompt-or-die-social-suite.dashboard.json-render-spec.v1";
const DASHBOARD_MAX_CUSTOM_PANELS = 16;
const DASHBOARD_PANEL_SIZE_ORDER = ["auto", "wide", "tall", "large"];
const DASHBOARD_JSON_RENDER_LAYOUTS = ["grid", "stack", "tabs"];
const DASHBOARD_JSON_RENDER_WIDGET_TYPES = ["panel", "metric", "chart", "table", "text"];
const DASHBOARD_JSON_RENDER_MAX_PANELS = 12;
const CONTEXT_INBOX_MAX_ITEMS = 120;
const CONTEXT_DEFAULT_PREFS = Object.freeze({
  pickerLastAction: "post.append_to_composer",
});
const DASHBOARD_PAGE_TABS = [
  { id: "operations", label: "Operations" },
  { id: "studio", label: "Studio" },
  { id: "all", label: "All Pages" },
];
const DASHBOARD_SEGMENT_TABS = [
  { id: "panel", label: "Panels" },
  { id: "tool", label: "Tools" },
  { id: "modal", label: "Modals" },
];
const DASHBOARD_PANEL_META_BY_TITLE = {
  "Runtime Controls": { page: "operations", segment: "panel" },
  "Quick Automations": { page: "operations", segment: "tool" },
  "Recent Runs": { page: "operations", segment: "panel" },
  "Approval Queue": { page: "operations", segment: "panel" },
  "Skill Center": { page: "operations", segment: "tool" },
  "Task Board": { page: "operations", segment: "panel" },
  "Mac Allowlist + Watch": { page: "operations", segment: "panel" },
  "Agentic Co-Workspace": { page: "operations", segment: "panel" },
  "Login Refresh": { page: "studio", segment: "tool" },
  "Command Studio": { page: "operations", segment: "tool" },
  "AI Workflow Planner": { page: "studio", segment: "tool" },
  "AI Chat Copilot": { page: "studio", segment: "tool" },
  "AI Image Copilot": { page: "studio", segment: "tool" },
  "X Algorithm OS Lab": { page: "studio", segment: "tool" },
};

const state = {
  catalog: [],
  latestPlan: null,
  history: [],
  onboarding: null,
  modelCache: null,
  derivedPersona: null,
  latestXAlgo: null,
  providerStatus: null,
  extensions: null,
  autonomy: null,
  approvals: [],
  coworkMessages: [],
  skills: [],
  tasks: [],
  coworkState: null,
  coworkMissions: [],
  taskLogs: [],
  macApps: [],
  watchSources: [],
  livekitStatus: null,
  integrations: null,
  integrationActionCatalog: [],
  integrationActionHistory: [],
  integrationSubscribers: [],
  integrationBridgeStatus: null,
  contextInbox: [],
  contextPrefs: { ...CONTEXT_DEFAULT_PREFS },
  utilityRail: {
    collapsed: false,
  },
  desktopCapabilities: {
    nativeContextMenu: false,
  },
  dashboardJsonRenderSpec: null,
  dashboardJsonRenderDraft: null,
};

const $ = (id) => document.getElementById(id);

const setText = (id, value) => {
  const node = $(id);
  if (!node) {
    return;
  }
  node.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
};

const toJSON = (value) => JSON.stringify(value, null, 2);

const parseMaybeJSON = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

const normalizeDashboardPageId = (value) => {
  const candidate = String(value || "").trim();
  return DASHBOARD_PAGE_TABS.some((item) => item.id === candidate && candidate !== "all") ? candidate : "operations";
};

const normalizeDashboardSegmentId = (value) => {
  const candidate = String(value || "").trim();
  if (candidate === "tool" || candidate === "modal") {
    return candidate;
  }
  return "panel";
};

const normalizeDashboardLayout = (value) => {
  const candidate = String(value || "").trim().toLowerCase();
  return DASHBOARD_JSON_RENDER_LAYOUTS.includes(candidate) ? candidate : "grid";
};

const normalizeDashboardColumns = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 2;
  }
  return Math.max(1, Math.min(4, Math.round(parsed)));
};

const normalizeDashboardWidgetType = (value) => {
  const candidate = String(value || "").trim().toLowerCase();
  return DASHBOARD_JSON_RENDER_WIDGET_TYPES.includes(candidate) ? candidate : "panel";
};

const normalizeWidgetContentList = (value, limit = 12) =>
  Array.isArray(value)
    ? value
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .slice(0, limit)
    : [];

const normalizeDashboardWidget = (widget, index) => {
  if (!widget || typeof widget !== "object" || Array.isArray(widget)) {
    return null;
  }

  const widgetType = normalizeDashboardWidgetType(widget.type);
  const id = String(widget.id || `json-widget-${index + 1}`).trim().slice(0, 80);
  const titleBase = String(widget.title || "").trim();
  const titleFallback = widgetType === "text" ? "Context Note" : `Generated ${widgetType[0].toUpperCase()}${widgetType.slice(1)}`;
  const title = (titleBase || `${titleFallback} ${index + 1}`).slice(0, 90);
  if (!title) {
    return null;
  }

  const summary = String(widget.summary || widget.description || "").trim().slice(0, 300);
  const page = normalizeDashboardPageId(widget.page);
  const segment = normalizeDashboardSegmentId(widget.segment);
  const size = normalizeDashboardPanelSize(widget.size);

  const explicitContent = normalizeWidgetContentList(widget.content);
  const derivedContent = [];
  if (widgetType === "metric") {
    const value = String(widget.value || "").trim().slice(0, 120);
    const trend = String(widget.trend || "").trim().toLowerCase();
    const change = String(widget.change || "").trim().slice(0, 120);
    if (value) {
      derivedContent.push(`Value: ${value}`);
    }
    if (trend && ["up", "down", "flat"].includes(trend)) {
      derivedContent.push(`Trend: ${trend}${change ? ` (${change})` : ""}`);
    }
  } else if (widgetType === "chart") {
    const chartType = String(widget.chartType || "").trim().toLowerCase();
    const dataKey = String(widget.dataKey || "").trim().slice(0, 120);
    if (chartType) {
      derivedContent.push(`Chart: ${chartType}`);
    }
    if (dataKey) {
      derivedContent.push(`Data: ${dataKey}`);
    }
  } else if (widgetType === "table") {
    const columns = normalizeWidgetContentList(widget.columns, 8);
    const dataKey = String(widget.dataKey || "").trim().slice(0, 120);
    if (columns.length) {
      derivedContent.push(`Columns: ${columns.join(", ")}`);
    }
    if (dataKey) {
      derivedContent.push(`Data: ${dataKey}`);
    }
  } else if (widgetType === "text") {
    const contentText = String(widget.contentText || widget.text || widget.content || "").trim().slice(0, 240);
    if (contentText) {
      derivedContent.push(contentText);
    }
  }

  const content = (explicitContent.length ? explicitContent : derivedContent).slice(0, 12);
  return {
    id,
    type: "panel",
    widgetType,
    title,
    summary,
    page,
    segment,
    size,
    content,
  };
};

const normalizeJsonRenderPanelElement = (element, index) => {
  if (!element || typeof element !== "object" || Array.isArray(element)) {
    return null;
  }
  const rawType = String(element.type || "").trim().toLowerCase();
  if (rawType !== "panel") {
    return null;
  }
  const id = String(element.id || `json-panel-${index + 1}`).trim().slice(0, 80);
  const title = String(element.title || `Generated Panel ${index + 1}`).trim().slice(0, 90);
  if (!title) {
    return null;
  }
  const summary = String(element.summary || "").trim().slice(0, 300);
  const page = normalizeDashboardPageId(element.page);
  const segment = normalizeDashboardSegmentId(element.segment);
  const size = normalizeDashboardPanelSize(element.size);
  const textBlocks = Array.isArray(element.content)
    ? element.content.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 12)
    : [];
  return {
    id,
    type: "panel",
    widgetType: "panel",
    title,
    summary,
    page,
    segment,
    size,
    content: textBlocks,
  };
};

const normalizeDashboardJsonRenderSpec = (spec) => {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return null;
  }
  const root = spec.root && typeof spec.root === "object" && !Array.isArray(spec.root) ? spec.root : {};
  const usingCustomSchema = Array.isArray(spec.widgets);

  if (usingCustomSchema) {
    const widgets = spec.widgets
      .map((item, index) => normalizeDashboardWidget(item, index))
      .filter(Boolean)
      .slice(0, DASHBOARD_JSON_RENDER_MAX_PANELS);
    if (!widgets.length) {
      return null;
    }
    return {
      layout: normalizeDashboardLayout(spec.layout),
      columns: normalizeDashboardColumns(spec.columns),
      root: {
        type: "dashboard",
        title: String(spec.title || root.title || "Generated Dashboard").trim().slice(0, 120),
        description: String(spec.description || root.description || "").trim().slice(0, 400),
      },
      widgets,
      elements: widgets.map((widget) => ({
        id: widget.id,
        type: "panel",
        widgetType: widget.widgetType,
        title: widget.title,
        summary: widget.summary,
        page: widget.page,
        segment: widget.segment,
        size: widget.size,
        content: widget.content,
      })),
    };
  }

  const elementsRaw = Array.isArray(spec.elements) ? spec.elements : [];
  const elements = elementsRaw
    .map((item, index) => normalizeJsonRenderPanelElement(item, index))
    .filter(Boolean)
    .slice(0, DASHBOARD_JSON_RENDER_MAX_PANELS);
  if (!elements.length) {
    return null;
  }
  return {
    layout: "grid",
    columns: 2,
    root: {
      type: "dashboard",
      title: String(root.title || "Generated Dashboard").trim().slice(0, 120),
      description: String(root.description || "").trim().slice(0, 400),
    },
    widgets: elements.map((element, index) => ({
      id: element.id || `json-widget-${index + 1}`,
      type: "panel",
      widgetType: "panel",
      title: element.title,
      summary: element.summary,
      page: element.page,
      segment: element.segment,
      size: element.size,
      content: Array.isArray(element.content) ? element.content : [],
    })),
    elements,
  };
};

const readDashboardJsonRenderSpec = () => {
  const parsed = parseMaybeJSON(window.localStorage.getItem(DASHBOARD_JSON_RENDER_SPEC_KEY) || "");
  return normalizeDashboardJsonRenderSpec(parsed);
};

const writeDashboardJsonRenderSpec = (spec) => {
  if (!spec) {
    window.localStorage.removeItem(DASHBOARD_JSON_RENDER_SPEC_KEY);
    return;
  }
  window.localStorage.setItem(DASHBOARD_JSON_RENDER_SPEC_KEY, JSON.stringify(spec));
};

const extractJsonObjectFromText = (rawText) => {
  const text = String(rawText || "").trim();
  if (!text) {
    return null;
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const inner = candidate.slice(start, end + 1);
      try {
        return JSON.parse(inner);
      } catch {
        return null;
      }
    }
    return null;
  }
};

const buildDashboardJsonRenderPrompt = (goal) => {
  const task = String(goal || "").trim();
  return [
    "Generate a JSON dashboard specification using JSON Render custom schema format.",
    "Return ONLY valid JSON. Do not include markdown fences or extra commentary.",
    "Schema:",
    "{",
    '  "layout": "grid|stack|tabs",',
    '  "columns": 1-4,',
    '  "title": "string",',
    '  "description": "string",',
    '  "widgets": [',
    '    {',
    '      "type": "panel|metric|chart|table|text",',
    '      "id": "string",',
    '      "title": "string",',
    '      "summary": "string",',
    '      "page": "operations|studio",',
    '      "segment": "panel|tool|modal",',
    '      "size": "auto|wide|tall|large",',
    '      "content": ["string", "string"],',
    '      "value": "string (metric only)",',
    '      "trend": "up|down|flat (metric only)",',
    '      "change": "string (metric only)",',
    '      "chartType": "line|bar|pie|area (chart only)",',
    '      "dataKey": "string (chart/table only)",',
    '      "columns": ["id", "customer", "amount"] (table only)',
    "    }",
    "  ]",
    "}",
    "Constraints:",
    "- 6 to 10 elements",
    "- social and X focused only",
    "- no coding or terminal features",
    "- concise, actionable panel copy",
    "- include a mix of widget types where useful",
    task ? `Goal: ${task}` : "Goal: improve social operations dashboard UX",
  ].join("\n");
};

const buildGeneratedDashboardPanelNode = (element) => {
  const panel = document.createElement("article");
  panel.className = "panel generated-dashboard-panel";
  panel.dataset.generatedWidgetType = String(element.widgetType || "panel");
  panel.dataset.dashboardPage = element.page;
  panel.dataset.dashboardSegment = element.segment;
  panel.dataset.dashboardPanelSize = element.size;

  const title = document.createElement("h2");
  title.textContent = element.title;
  panel.appendChild(title);

  if (element.summary) {
    const summary = document.createElement("p");
    summary.className = "summary";
    summary.textContent = element.summary;
    panel.appendChild(summary);
  }

  if (Array.isArray(element.content) && element.content.length) {
    const list = document.createElement("ul");
    list.className = "generated-panel-list";
    element.content.forEach((line) => {
      const item = document.createElement("li");
      item.textContent = line;
      list.appendChild(item);
    });
    panel.appendChild(list);
  }

  return panel;
};

const hydrateGeneratedDashboardPanels = () => {
  const root = $("dashboard-root");
  if (!(root instanceof HTMLElement)) {
    return;
  }
  const rightColumn = root.querySelector(":scope > section.stack");
  if (!(rightColumn instanceof HTMLElement)) {
    return;
  }
  rightColumn.querySelectorAll(".generated-dashboard-panel").forEach((node) => node.remove());
  const spec = state.dashboardJsonRenderSpec;
  if (!spec || !Array.isArray(spec.elements)) {
    return;
  }
  spec.elements.forEach((element) => {
    const panel = buildGeneratedDashboardPanelNode(element);
    rightColumn.appendChild(panel);
  });
};

const summarizeDashboardJsonRenderSpec = (spec) => {
  if (!spec) {
    return { enabled: false, panelCount: 0 };
  }
  const widgets = Array.isArray(spec.widgets) ? spec.widgets : Array.isArray(spec.elements) ? spec.elements : [];
  return {
    enabled: true,
    layout: spec.layout || "grid",
    columns: normalizeDashboardColumns(spec.columns),
    title: spec.root?.title || "Generated Dashboard",
    description: spec.root?.description || "",
    panelCount: widgets.length,
    panels: widgets.map((element) => ({
          id: element.id,
          type: element.widgetType || element.type || "panel",
          title: element.title,
          page: element.page,
          segment: element.segment,
          size: element.size,
        })),
  };
};

const slugifyPanelId = (value) =>
  String(value || "panel")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "panel";

const normalizeDashboardView = (candidate) => {
  const pageIds = new Set(DASHBOARD_PAGE_TABS.map((item) => item.id));
  const segmentIds = new Set(DASHBOARD_SEGMENT_TABS.map((item) => item.id));
  const page = pageIds.has(candidate?.page) ? candidate.page : "operations";
  const segment = segmentIds.has(candidate?.segment) ? candidate.segment : "panel";
  return { page, segment };
};

const normalizeDashboardPanelSize = (sizeRaw) => {
  const normalized = String(sizeRaw || "").trim().toLowerCase();
  return DASHBOARD_PANEL_SIZE_ORDER.includes(normalized) ? normalized : "auto";
};

const readDashboardView = () => {
  const raw = window.localStorage.getItem(DASHBOARD_VIEW_KEY);
  if (!raw) {
    return normalizeDashboardView();
  }
  const parsed = parseMaybeJSON(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return normalizeDashboardView();
  }
  return normalizeDashboardView(parsed);
};

const writeDashboardView = (view) => {
  window.localStorage.setItem(DASHBOARD_VIEW_KEY, JSON.stringify(normalizeDashboardView(view)));
};

const readDashboardLayout = () => {
  const raw = window.localStorage.getItem(DASHBOARD_LAYOUT_KEY);
  if (!raw) {
    return null;
  }
  const parsed = parseMaybeJSON(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed;
};

const writeDashboardLayout = (layout) => {
  window.localStorage.setItem(DASHBOARD_LAYOUT_KEY, JSON.stringify(layout));
};

const readDashboardCustomPanels = () => {
  const raw = window.localStorage.getItem(DASHBOARD_CUSTOM_PANELS_KEY);
  if (!raw) {
    return [];
  }
  const parsed = parseMaybeJSON(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }
  const pageIds = new Set(DASHBOARD_PAGE_TABS.map((item) => item.id));
  const segmentIds = new Set(DASHBOARD_SEGMENT_TABS.map((item) => item.id));
  const used = new Set();
  const normalized = [];
  parsed.forEach((item, index) => {
    if (!item || typeof item !== "object") {
      return;
    }
    const title = String(item.title || `Custom Panel ${index + 1}`).trim().slice(0, 80);
    if (!title) {
      return;
    }
    const requestedId = String(item.id || "").trim();
    let id = requestedId || `custom-${slugifyPanelId(title)}`;
    if (!id.startsWith("custom-")) {
      id = `custom-${slugifyPanelId(id)}`;
    }
    while (used.has(id)) {
      id = `${id}-${index + 1}`;
    }
    used.add(id);
    const page = pageIds.has(item.page) ? item.page : "operations";
    const segment = segmentIds.has(item.segment) && item.segment !== "modal" ? item.segment : "panel";
    const notes = typeof item.notes === "string" ? item.notes.slice(0, 20_000) : "";
    const size = normalizeDashboardPanelSize(item.size);
    normalized.push({
      id,
      title,
      page,
      segment,
      notes,
      size,
    });
  });
  return normalized.slice(0, DASHBOARD_MAX_CUSTOM_PANELS);
};

const writeDashboardCustomPanels = (panels) => {
  window.localStorage.setItem(DASHBOARD_CUSTOM_PANELS_KEY, JSON.stringify(panels));
};

const deriveDashboardPanelMeta = (title) => {
  const known = DASHBOARD_PANEL_META_BY_TITLE[title];
  if (known) {
    return known;
  }
  return {
    page: "operations",
    segment: "panel",
  };
};

const readContextInbox = () => {
  const parsed = readPersistedJSON(window.localStorage, CONTEXT_STORAGE_KEYS.inbox, []);
  if (!Array.isArray(parsed)) {
    return [];
  }
  let next = [];
  parsed.forEach((item) => {
    next = upsertContextInboxItem(next, item, CONTEXT_INBOX_MAX_ITEMS);
  });
  return next.slice(0, CONTEXT_INBOX_MAX_ITEMS);
};

const writeContextInbox = () => {
  writePersistedJSON(window.localStorage, CONTEXT_STORAGE_KEYS.inbox, state.contextInbox.slice(0, CONTEXT_INBOX_MAX_ITEMS));
};

const readContextPrefs = () => {
  const parsed = readPersistedJSON(window.localStorage, CONTEXT_STORAGE_KEYS.prefs, null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...CONTEXT_DEFAULT_PREFS };
  }
  const nextAction = String(parsed.pickerLastAction || CONTEXT_DEFAULT_PREFS.pickerLastAction).trim();
  return {
    pickerLastAction: CONTEXT_ACTION_ID_SET.has(nextAction) ? nextAction : CONTEXT_DEFAULT_PREFS.pickerLastAction,
  };
};

const writeContextPrefs = () => {
  writePersistedJSON(window.localStorage, CONTEXT_STORAGE_KEYS.prefs, state.contextPrefs);
};

const readUtilityRailState = () => {
  const parsed = readPersistedJSON(window.localStorage, CONTEXT_STORAGE_KEYS.utilityRail, null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { collapsed: false };
  }
  return {
    collapsed: Boolean(parsed.collapsed),
  };
};

const writeUtilityRailState = () => {
  writePersistedJSON(window.localStorage, CONTEXT_STORAGE_KEYS.utilityRail, state.utilityRail);
};

const setContextFeedback = (message) => {
  const node = $("context-feedback-line");
  if (node) {
    node.textContent = String(message || "").trim();
  }
};

const setFormFieldValue = (id, value, mode = "replace") => {
  const field = $(id);
  if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) {
    return false;
  }
  const nextText = String(value || "").trim();
  if (!nextText) {
    return false;
  }
  if (mode === "append") {
    const current = String(field.value || "").trim();
    field.value = current ? `${current}\n\n${nextText}` : nextText;
  } else {
    field.value = nextText;
  }
  field.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
};

const updateContextInbox = (nextItems) => {
  state.contextInbox = (Array.isArray(nextItems) ? nextItems : []).slice(0, CONTEXT_INBOX_MAX_ITEMS);
  writeContextInbox();
  renderContextInbox();
};

const setUtilityRailSourceText = (text) => {
  const field = $("context-rail-source");
  if (field instanceof HTMLTextAreaElement) {
    field.value = String(text || "").trim();
  }
};

const getUtilityRailSourceText = () => {
  const direct = ($("context-rail-source")?.value || "").trim();
  if (direct) {
    return direct;
  }
  if (state.contextInbox[0]?.text) {
    return String(state.contextInbox[0].text || "").trim();
  }
  const selected = window.getSelection?.()?.toString?.().trim();
  return selected || "";
};

const markContextInboxItemConsumed = (itemId, consumedBy) => {
  const id = String(itemId || "").trim();
  if (!id) {
    return;
  }
  const next = state.contextInbox.map((item) =>
    item.id === id
      ? {
          ...item,
          consumedBy: consumedBy || undefined,
        }
      : item,
  );
  updateContextInbox(next);
};

const captureContextToInbox = ({ item, context, actionId }) => {
  const mergedTags = [...new Set([...(item?.tags || []), ...deriveContextTags(actionId, context)])].slice(0, 8);
  const nextItem = {
    ...item,
    tags: mergedTags,
    source: context?.sourceHint || item?.source || "context",
  };
  updateContextInbox(upsertContextInboxItem(state.contextInbox, nextItem, CONTEXT_INBOX_MAX_ITEMS));
  if (!(($("context-rail-source")?.value || "").trim())) {
    setUtilityRailSourceText(nextItem.text || "");
  }
};

const contextPayloadFromSelection = (sourceHint = "web-fallback-picker") =>
  normalizeContextSourcePayload({
    selectionText: window.getSelection?.()?.toString?.().trim() || "",
    pageURL: window.location?.href || "",
    x: window.scrollX || 0,
    y: window.scrollY || 0,
    ts: Date.now(),
    sourceHint,
  });

const parseTagInput = (raw) => {
  return [...new Set(String(raw || "")
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean))]
    .slice(0, 8);
};

const renderContextInbox = () => {
  const node = $("context-inbox-list");
  if (!node) {
    return;
  }
  node.innerHTML = "";
  if (!state.contextInbox.length) {
    const empty = document.createElement("p");
    empty.className = "summary";
    empty.textContent = "No context captured yet. Use right-click (desktop) or Send Context.";
    node.appendChild(empty);
    return;
  }
  state.contextInbox.forEach((item) => {
    const card = document.createElement("article");
    card.className = "context-inbox-item";
    card.dataset.contextItemId = item.id;

    const head = document.createElement("div");
    head.className = "context-inbox-head";
    const title = document.createElement("strong");
    title.textContent = item.source || "context";
    const time = document.createElement("small");
    time.textContent = new Date(item.createdAt || Date.now()).toLocaleString();
    head.append(title, time);

    const text = document.createElement("pre");
    text.className = "context-inbox-text";
    text.textContent = String(item.text || "");

    const tags = document.createElement("div");
    tags.className = "context-inbox-tags";
    (item.tags || []).forEach((tag) => {
      const chip = document.createElement("span");
      chip.className = "context-tag";
      chip.textContent = tag;
      tags.appendChild(chip);
    });

    const tagEditor = document.createElement("div");
    tagEditor.className = "context-tag-editor";
    const tagInput = document.createElement("input");
    tagInput.type = "text";
    tagInput.value = (item.tags || []).join(", ");
    tagInput.dataset.contextTagInput = item.id;
    tagInput.placeholder = "tags: tweet, trend, prompt";
    const saveTags = document.createElement("button");
    saveTags.type = "button";
    saveTags.className = "ghost";
    saveTags.dataset.contextAction = "save-tags";
    saveTags.dataset.contextItemId = item.id;
    saveTags.textContent = "Save Tags";
    tagEditor.append(tagInput, saveTags);

    const actions = document.createElement("div");
    actions.className = "context-inbox-actions";
    [
      ["Composer", "composer"],
      ["Planner", "planner"],
      ["Chat", "chat"],
      ["Mission", "mission"],
    ].forEach(([label, target]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost";
      button.dataset.contextAction = "dispatch";
      button.dataset.contextTarget = target;
      button.dataset.contextItemId = item.id;
      button.textContent = label;
      actions.appendChild(button);
    });

    const metaActions = document.createElement("div");
    metaActions.className = "context-inbox-meta-actions";

    const pinButton = document.createElement("button");
    pinButton.type = "button";
    pinButton.className = "ghost";
    pinButton.dataset.contextAction = "pin-toggle";
    pinButton.dataset.contextItemId = item.id;
    pinButton.textContent = item.pinned ? "Unpin" : "Pin";

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "ghost";
    removeButton.dataset.contextAction = "remove";
    removeButton.dataset.contextItemId = item.id;
    removeButton.textContent = "Archive";

    metaActions.append(pinButton, removeButton);

    if (item.consumedBy) {
      const consumed = document.createElement("p");
      consumed.className = "summary";
      consumed.textContent = `Last sent: ${item.consumedBy}`;
      card.append(head, text, tags, tagEditor, actions, metaActions, consumed);
    } else {
      card.append(head, text, tags, tagEditor, actions, metaActions);
    }
    node.appendChild(card);
  });
};

const saveContextTags = (itemId, rawTags) => {
  const id = String(itemId || "").trim();
  if (!id) {
    return;
  }
  const tags = parseTagInput(rawTags);
  const next = state.contextInbox.map((item) => (item.id === id ? { ...item, tags } : item));
  updateContextInbox(next);
};

const removeContextInboxItem = (itemId) => {
  const id = String(itemId || "").trim();
  if (!id) {
    return;
  }
  updateContextInbox(state.contextInbox.filter((item) => item.id !== id));
};

const togglePinnedContextInboxItem = (itemId) => {
  const id = String(itemId || "").trim();
  if (!id) {
    return;
  }
  const next = state.contextInbox.map((item) =>
    item.id === id
      ? {
          ...item,
          pinned: !item.pinned,
        }
      : item,
  );
  updateContextInbox(
    [...next].sort((left, right) => {
      if (left.pinned !== right.pinned) {
        return left.pinned ? -1 : 1;
      }
      return String(right.createdAt).localeCompare(String(left.createdAt));
    }),
  );
};

const contextActionRouter = (payload) => {
  const actionId = String(payload?.actionId || "").trim();
  const context = normalizeContextSourcePayload(payload?.context || payload);
  const result = runContextAction(actionId, context, {
    setComposerDraft: ({ mode, text }) => {
      setFormFieldValue("tweet-text", text, mode);
    },
    prefillPlannerGoal: ({ text }) => {
      setFormFieldValue("plan-goal", text, "replace");
    },
    prefillMissionQuery: ({ text }) => {
      setFormFieldValue("cowork-mission-query", text, "replace");
    },
    prefillCommandStudio: ({ text }) => {
      setFormFieldValue("endpoint-filter", text, "replace");
      renderEndpointOptions();
    },
    prefillChatPrompt: ({ text }) => {
      setFormFieldValue("ai-prompt", text, "replace");
    },
    captureKnowledge: ({ item, context: sourceContext, actionId: sourceActionId }) => {
      captureContextToInbox({ item, context: sourceContext, actionId: sourceActionId });
    },
  });

  if (result.ok) {
    state.contextPrefs = {
      ...state.contextPrefs,
      pickerLastAction: actionId,
    };
    writeContextPrefs();
    setContextFeedback(`Context action applied: ${actionId}`);
  } else {
    setContextFeedback(`Context action ignored: ${result.reason || "unknown"}`);
    if (result.reason === "unknown_action") {
      console.error("Unknown context action received:", actionId, payload);
    }
  }
  logActivity("Context action", {
    actionId,
    ok: result.ok,
    reason: result.reason || null,
    effect: result.effect || null,
    sourceHint: context.sourceHint,
  });
  return result;
};

const contextTargetToActionId = (target) => {
  if (target === "planner") {
    return "tools.prefill_planner_goal";
  }
  if (target === "chat") {
    return "chat.prefill_prompt";
  }
  if (target === "mission") {
    return "tools.prefill_mission_query";
  }
  return "post.append_to_composer";
};

const contextTransformText = (type, sourceText) => {
  const text = String(sourceText || "").trim();
  if (!text) {
    return "";
  }
  if (type === "tighten") {
    return text
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 40)
      .join(" ");
  }
  if (type === "cta") {
    return `${text}\n\nDrop your take and I will build a sharper angle.`;
  }
  if (type === "threadify") {
    return buildThreadOutline(text);
  }
  return text;
};

const syncUtilityRailState = () => {
  const rail = $("dashboard-utility-rail");
  if (!rail) {
    return;
  }
  rail.classList.toggle("collapsed", Boolean(state.utilityRail.collapsed));
  rail.setAttribute("aria-hidden", state.utilityRail.collapsed ? "true" : "false");
  const toggle = $("utility-rail-toggle");
  if (toggle) {
    toggle.textContent = state.utilityRail.collapsed ? "Open Rail" : "Collapse";
  }
};

const openContextPicker = (seedPayload) => {
  const modal = $("context-action-picker");
  if (!modal) {
    return;
  }
  const selection = normalizeContextSourcePayload(seedPayload || contextPayloadFromSelection("web-context-picker"));
  const area = $("context-picker-text");
  if (area instanceof HTMLTextAreaElement) {
    area.value = resolveContextText(selection);
  }
  const source = $("context-picker-source");
  if (source) {
    source.textContent = selection.selectionText ? "Selection detected" : "No selection - add context manually";
  }
  modal.classList.remove("hidden");
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  const preferred = state.contextPrefs?.pickerLastAction;
  if (preferred && CONTEXT_ACTION_ID_SET.has(preferred)) {
    const preferredButton = modal.querySelector(`[data-context-picker-action="${preferred}"]`);
    if (preferredButton instanceof HTMLButtonElement) {
      preferredButton.focus();
    }
  }
};

const closeContextPicker = () => {
  const modal = $("context-action-picker");
  if (!modal) {
    return;
  }
  modal.classList.remove("open");
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
};

const syncContextSurfaceAvailability = () => {
  const sendButton = $("context-send-btn");
  if (sendButton) {
    sendButton.classList.toggle("hidden", Boolean(state.desktopCapabilities.nativeContextMenu));
  }
  const modeNode = $("context-mode-hint");
  if (modeNode) {
    modeNode.textContent = state.desktopCapabilities.nativeContextMenu
      ? "Native right-click context menu active."
      : "Web fallback active: use Send Context or Cmd/Ctrl+Shift+K.";
  }
};

const renderDashboardJsonRenderStatus = () => {
  setText("dashboard-json-render-output", {
    active: summarizeDashboardJsonRenderSpec(state.dashboardJsonRenderSpec),
    draft: summarizeDashboardJsonRenderSpec(state.dashboardJsonRenderDraft),
  });
};

const applyDashboardJsonRenderSpec = (spec) => {
  state.dashboardJsonRenderSpec = spec;
  writeDashboardJsonRenderSpec(spec);
  renderDashboardJsonRenderStatus();
};

const initDashboardWorkbench = () => {
  if (BLUEPRINT_SHELL_MODE) {
    initBlueprintShell();
    return;
  }
  const root = $("dashboard-root");
  if (!root || root.dataset.workbenchReady === "true") {
    return;
  }
  const leftColumn = root.querySelector(":scope > aside.stack");
  const rightColumn = root.querySelector(":scope > section.stack");
  const utilityRail = root.querySelector(":scope > aside.utility-rail");
  if (!(leftColumn instanceof HTMLElement) || !(rightColumn instanceof HTMLElement)) {
    return;
  }
  const panels = [
    ...leftColumn.querySelectorAll(":scope > article.panel"),
    ...rightColumn.querySelectorAll(":scope > article.panel"),
  ];
  if (!panels.length) {
    return;
  }

  const workbench = document.createElement("div");
  workbench.className = "dashboard-workbench";

  const toolbar = document.createElement("div");
  toolbar.className = "dashboard-workbench-bar";

  const pageTabs = document.createElement("div");
  pageTabs.className = "dashboard-tab-group";
  DASHBOARD_PAGE_TABS.forEach((tab) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost dashboard-tab";
    button.dataset.dashboardPage = tab.id;
    button.textContent = tab.label;
    pageTabs.appendChild(button);
  });

  const segmentTabs = document.createElement("div");
  segmentTabs.className = "dashboard-tab-group";
  DASHBOARD_SEGMENT_TABS.forEach((tab) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost dashboard-tab";
    button.dataset.dashboardSegment = tab.id;
    button.textContent = tab.label;
    segmentTabs.appendChild(button);
  });

  const actions = document.createElement("div");
  actions.className = "dashboard-workbench-actions";

  const addPanelBtn = document.createElement("button");
  addPanelBtn.type = "button";
  addPanelBtn.className = "ghost";
  addPanelBtn.textContent = "Add Panel";
  actions.appendChild(addPanelBtn);

  const openToolsModalBtn = document.createElement("button");
  openToolsModalBtn.type = "button";
  openToolsModalBtn.className = "ghost";
  openToolsModalBtn.textContent = "Open Tool Modal";
  actions.appendChild(openToolsModalBtn);

  const resetLayoutBtn = document.createElement("button");
  resetLayoutBtn.type = "button";
  resetLayoutBtn.className = "ghost";
  resetLayoutBtn.textContent = "Reset Layout";
  actions.appendChild(resetLayoutBtn);

  const sendContextBtn = document.createElement("button");
  sendContextBtn.type = "button";
  sendContextBtn.className = "ghost";
  sendContextBtn.id = "context-send-btn";
  sendContextBtn.textContent = "Send Context";
  actions.appendChild(sendContextBtn);

  const customCountChip = document.createElement("span");
  customCountChip.className = "chip";
  actions.appendChild(customCountChip);

  toolbar.append(pageTabs, segmentTabs, actions);

  const panelGrid = document.createElement("div");
  panelGrid.className = "dashboard-panel-grid";
  panelGrid.id = "dashboard-panel-grid";

  const toolsModal = document.createElement("div");
  toolsModal.className = "dashboard-modal-overlay hidden";
  toolsModal.setAttribute("aria-hidden", "true");

  const modalCard = document.createElement("div");
  modalCard.className = "dashboard-modal-card";
  modalCard.setAttribute("role", "dialog");
  modalCard.setAttribute("aria-modal", "true");

  const modalHeader = document.createElement("div");
  modalHeader.className = "dashboard-modal-head";

  const modalTitle = document.createElement("h3");
  modalTitle.textContent = "Tool Segments";
  modalHeader.appendChild(modalTitle);

  const modalClose = document.createElement("button");
  modalClose.type = "button";
  modalClose.className = "ghost";
  modalClose.textContent = "Close";
  modalHeader.appendChild(modalClose);

  const modalHint = document.createElement("p");
  modalHint.className = "summary";
  modalHint.textContent = "Jump into tool-focused panels and keep the dashboard arranged around your current workflow.";

  const modalList = document.createElement("div");
  modalList.className = "dashboard-tool-list";

  modalCard.append(modalHeader, modalHint, modalList);
  toolsModal.appendChild(modalCard);

  const panelMap = new Map();
  const staticPanelOrder = [];
  const seenPanelIds = new Set();
  let draggedPanel = null;

  const toPanelPage = (value) => {
    const normalized = String(value || "").trim();
    if (DASHBOARD_PAGE_TABS.some((item) => item.id === normalized && normalized !== "all")) {
      return normalized;
    }
    return "operations";
  };

  const toPanelSegment = (value) => {
    const normalized = String(value || "").trim();
    if (normalized === "tool") {
      return "tool";
    }
    return "panel";
  };

  const panelSizeLabel = (sizeRaw) => {
    const size = normalizeDashboardPanelSize(sizeRaw);
    if (size === "wide") {
      return "Wide";
    }
    if (size === "tall") {
      return "Tall";
    }
    if (size === "large") {
      return "Large";
    }
    return "Auto";
  };

  const nextPanelSize = (sizeRaw) => {
    const current = normalizeDashboardPanelSize(sizeRaw);
    const index = DASHBOARD_PANEL_SIZE_ORDER.indexOf(current);
    return DASHBOARD_PANEL_SIZE_ORDER[(index + 1) % DASHBOARD_PANEL_SIZE_ORDER.length];
  };

  const reserveStaticPanelId = (title, index) => {
    const base = slugifyPanelId(title || `panel-${index + 1}`);
    let candidate = base;
    let suffix = 2;
    while (seenPanelIds.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    seenPanelIds.add(candidate);
    return candidate;
  };

  const reserveCustomPanelId = (seed) => {
    const base = slugifyPanelId(String(seed || "panel").replace(/^custom-/, ""));
    let candidate = `custom-${base}`;
    let suffix = 2;
    while (seenPanelIds.has(candidate)) {
      candidate = `custom-${base}-${suffix}`;
      suffix += 1;
    }
    seenPanelIds.add(candidate);
    return candidate;
  };

  const updatePanelHandleMeta = (panel) => {
    const labelNode = panel.querySelector(".panel-drag-label");
    if (labelNode) {
      labelNode.textContent = panel.dataset.panelTitle || "Panel";
    }
    const tagNode = panel.querySelector(".panel-drag-tag");
    if (tagNode) {
      tagNode.textContent = `${panel.dataset.panelPage || "operations"} / ${panel.dataset.panelSegment || "panel"}`;
    }
  };

  const getCustomPanelCount = () => [...panelMap.values()].filter((panel) => panel.dataset.panelCustom === "true").length;

  const updateCustomPanelCount = () => {
    customCountChip.textContent = `Custom panels ${getCustomPanelCount()}/${DASHBOARD_MAX_CUSTOM_PANELS}`;
  };

  const updateGridDensity = () => {
    const visibleCount = [...panelGrid.querySelectorAll(".dashboard-panel-card:not(.hidden)")].length;
    let minWidth = 340;
    if (visibleCount >= 14) {
      minWidth = 220;
    } else if (visibleCount >= 10) {
      minWidth = 250;
    } else if (visibleCount >= 7) {
      minWidth = 280;
    }
    panelGrid.style.setProperty("--dashboard-panel-min-width", `${minWidth}px`);
  };

  const createCustomPanelElement = (config) => {
    const panel = document.createElement("article");
    panel.className = "panel custom-user-panel";

    const title = document.createElement("h2");
    title.textContent = config.title;

    const summary = document.createElement("p");
    summary.className = "summary";
    summary.textContent = "User-defined panel with dynamic size, page/segment routing, and persistent notes.";

    const configGrid = document.createElement("div");
    configGrid.className = "custom-panel-config";

    const titleLabel = document.createElement("label");
    titleLabel.textContent = "Panel title";
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.className = "custom-panel-title-input";
    titleInput.value = config.title;
    titleInput.maxLength = 80;

    const pageLabel = document.createElement("label");
    pageLabel.textContent = "Page";
    const pageSelect = document.createElement("select");
    pageSelect.className = "custom-panel-page-select";
    DASHBOARD_PAGE_TABS.filter((item) => item.id !== "all").forEach((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.label;
      pageSelect.appendChild(option);
    });
    pageSelect.value = toPanelPage(config.page);

    const segmentLabel = document.createElement("label");
    segmentLabel.textContent = "Segment";
    const segmentSelect = document.createElement("select");
    segmentSelect.className = "custom-panel-segment-select";
    [
      { id: "panel", label: "Panels" },
      { id: "tool", label: "Tools" },
    ].forEach((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.label;
      segmentSelect.appendChild(option);
    });
    segmentSelect.value = toPanelSegment(config.segment);

    const notesLabel = document.createElement("label");
    notesLabel.textContent = "Notes";
    const notesArea = document.createElement("textarea");
    notesArea.className = "custom-panel-notes";
    notesArea.rows = 9;
    notesArea.placeholder = "Add checklists, snippets, references, and panel-specific context.";
    notesArea.value = config.notes || "";

    configGrid.append(
      titleLabel,
      titleInput,
      pageLabel,
      pageSelect,
      segmentLabel,
      segmentSelect,
      notesLabel,
      notesArea,
    );
    panel.append(title, summary, configGrid);
    return panel;
  };

  const collectCustomPanelsState = () => {
    const customPanels = [];
    [...panelGrid.querySelectorAll(".dashboard-panel-card[data-panel-custom='true']")].forEach((panel) => {
      const panelId = panel.dataset.panelId || "";
      if (!panelId) {
        return;
      }
      const titleInput = panel.querySelector(".custom-panel-title-input");
      const notesArea = panel.querySelector(".custom-panel-notes");
      const pageSelect = panel.querySelector(".custom-panel-page-select");
      const segmentSelect = panel.querySelector(".custom-panel-segment-select");
      const title = String(titleInput?.value || panel.dataset.panelTitle || "Custom Panel").trim().slice(0, 80);
      customPanels.push({
        id: panelId,
        title: title || "Custom Panel",
        page: toPanelPage(pageSelect?.value || panel.dataset.panelPage || "operations"),
        segment: toPanelSegment(segmentSelect?.value || panel.dataset.panelSegment || "panel"),
        notes: typeof notesArea?.value === "string" ? notesArea.value.slice(0, 20_000) : "",
        size: normalizeDashboardPanelSize(panel.dataset.panelSize),
      });
    });
    return customPanels.slice(0, DASHBOARD_MAX_CUSTOM_PANELS);
  };

  const savePanelLayout = () => {
    const order = [...panelGrid.querySelectorAll(".dashboard-panel-card")]
      .map((panel) => panel.dataset.panelId)
      .filter(Boolean);
    const sizes = {};
    [...panelGrid.querySelectorAll(".dashboard-panel-card")].forEach((panel) => {
      const panelId = panel.dataset.panelId;
      if (!panelId) {
        return;
      }
      sizes[panelId] = normalizeDashboardPanelSize(panel.dataset.panelSize);
    });
    writeDashboardLayout({ order, sizes });
    writeDashboardCustomPanels(collectCustomPanelsState());
    updateCustomPanelCount();
  };

  const syncPanelSizeButtonText = () => {
    panelMap.forEach((panel, panelId) => {
      const button = panel.querySelector(`.panel-size-toggle[data-panel-id="${panelId}"]`);
      if (!(button instanceof HTMLButtonElement)) {
        return;
      }
      const size = normalizeDashboardPanelSize(panel.dataset.panelSize);
      button.textContent = `Size: ${panelSizeLabel(size)}`;
    });
  };

  const bindPanelDragHandlers = (panel) => {
    if (panel.dataset.panelDragBound === "true") {
      return;
    }
    panel.dataset.panelDragBound = "true";
    panel.addEventListener("dragstart", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.closest(".panel-drag-handle")) {
        event.preventDefault();
        return;
      }
      draggedPanel = panel;
      panel.classList.add("panel-dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", panel.dataset.panelId || "");
      }
    });
    panel.addEventListener("dragend", () => {
      panel.classList.remove("panel-dragging");
      draggedPanel = null;
      savePanelLayout();
      updateGridDensity();
    });
  };

  const registerPanel = (panel, options) => {
    const isCustom = Boolean(options.custom);
    const titleNode = panel.querySelector("h2");
    const title = String(options.title || titleNode?.textContent || "Panel").trim().slice(0, 80) || "Panel";
    const panelId = isCustom
      ? reserveCustomPanelId(options.panelId || title)
      : reserveStaticPanelId(options.panelId || title, staticPanelOrder.length);
    panel.dataset.panelId = panelId;
    panel.dataset.panelTitle = title;
    panel.dataset.panelPage = toPanelPage(options.page);
    panel.dataset.panelSegment = toPanelSegment(options.segment);
    panel.dataset.panelCustom = isCustom ? "true" : "false";
    panel.dataset.panelSize = normalizeDashboardPanelSize(options.size);
    panel.classList.add("dashboard-panel-card");
    panel.draggable = true;
    if (titleNode) {
      titleNode.textContent = title;
    }

    const existingHandle = panel.querySelector(":scope > .panel-drag-handle");
    if (existingHandle) {
      existingHandle.remove();
    }

    const dragHandle = document.createElement("div");
    dragHandle.className = "panel-drag-handle";

    const grip = document.createElement("span");
    grip.className = "panel-drag-grip";
    grip.textContent = "⋮⋮";

    const label = document.createElement("span");
    label.className = "panel-drag-label";
    label.textContent = title;

    const tag = document.createElement("span");
    tag.className = "panel-drag-tag";
    tag.textContent = `${panel.dataset.panelPage} / ${panel.dataset.panelSegment}`;

    const handleActions = document.createElement("div");
    handleActions.className = "panel-handle-actions";

    const sizeToggle = document.createElement("button");
    sizeToggle.type = "button";
    sizeToggle.className = "ghost panel-size-toggle";
    sizeToggle.dataset.panelId = panelId;
    sizeToggle.dataset.panelAction = "cycle-size";
    handleActions.appendChild(sizeToggle);

    if (isCustom) {
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "ghost panel-remove-btn";
      removeButton.dataset.panelId = panelId;
      removeButton.dataset.panelAction = "remove-custom";
      removeButton.textContent = "Remove";
      handleActions.appendChild(removeButton);
    }

    dragHandle.append(grip, label, tag, handleActions);
    panel.prepend(dragHandle);
    bindPanelDragHandlers(panel);

    panelMap.set(panelId, panel);
    if (!isCustom) {
      staticPanelOrder.push(panelId);
    }
    if (panel.parentElement !== panelGrid) {
      panelGrid.appendChild(panel);
    }
    updatePanelHandleMeta(panel);
    syncPanelSizeButtonText();
    return panelId;
  };

  const loadPanelLayout = () => {
    const saved = readDashboardLayout();
    const savedOrder = Array.isArray(saved?.order) ? saved.order : [];
    const appended = new Set();
    savedOrder.forEach((panelId) => {
      const panel = panelMap.get(panelId);
      if (panel) {
        panelGrid.appendChild(panel);
        appended.add(panelId);
      }
    });
    panelMap.forEach((panel, panelId) => {
      if (!appended.has(panelId)) {
        panelGrid.appendChild(panel);
      }
    });
    const savedSizes = saved && typeof saved.sizes === "object" && !Array.isArray(saved.sizes) ? saved.sizes : null;
    const legacyWide = new Set(Array.isArray(saved?.wide) ? saved.wide : []);
    panelMap.forEach((panel, panelId) => {
      const sizeFromMap = savedSizes ? normalizeDashboardPanelSize(savedSizes[panelId]) : null;
      const fallbackSize = legacyWide.has(panelId) ? "wide" : "auto";
      panel.dataset.panelSize = sizeFromMap || fallbackSize;
    });
    syncPanelSizeButtonText();
  };

  const openToolsModal = () => {
    toolsModal.classList.remove("hidden");
    toolsModal.classList.add("open");
    toolsModal.setAttribute("aria-hidden", "false");
  };

  const closeToolsModal = () => {
    toolsModal.classList.add("hidden");
    toolsModal.classList.remove("open");
    toolsModal.setAttribute("aria-hidden", "true");
  };

  const renderToolsModalItems = () => {
    modalList.innerHTML = "";
    const toolPanels = [...panelMap.values()].filter((panel) => panel.dataset.panelSegment === "tool");
    if (!toolPanels.length) {
      const empty = document.createElement("p");
      empty.className = "summary";
      empty.textContent = "No tool segments are currently available.";
      modalList.appendChild(empty);
      return;
    }
    toolPanels.forEach((panel) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost dashboard-tool-item";
      button.dataset.panelId = panel.dataset.panelId || "";
      button.textContent = `${panel.dataset.panelTitle || "Tool"}  |  ${panel.dataset.panelPage || "operations"}`;
      modalList.appendChild(button);
    });
  };

  panels.forEach((panel, index) => {
    if (!(panel instanceof HTMLElement)) {
      return;
    }
    const titleNode = panel.querySelector("h2");
    const title = (titleNode?.textContent || `Panel ${index + 1}`).trim();
    const meta = deriveDashboardPanelMeta(title);
    const page = panel.dataset.dashboardPage ? normalizeDashboardPageId(panel.dataset.dashboardPage) : meta.page;
    const segment = panel.dataset.dashboardSegment
      ? normalizeDashboardSegmentId(panel.dataset.dashboardSegment)
      : meta.segment;
    const size = panel.dataset.dashboardPanelSize ? normalizeDashboardPanelSize(panel.dataset.dashboardPanelSize) : "auto";
    registerPanel(panel, {
      panelId: title,
      title,
      page,
      segment,
      size,
      custom: false,
    });
  });

  readDashboardCustomPanels().forEach((panelConfig) => {
    const panel = createCustomPanelElement(panelConfig);
    const panelId = registerPanel(panel, {
      panelId: panelConfig.id,
      title: panelConfig.title,
      page: panelConfig.page,
      segment: panelConfig.segment,
      size: panelConfig.size,
      custom: true,
    });
    const titleInput = panel.querySelector(".custom-panel-title-input");
    const pageSelect = panel.querySelector(".custom-panel-page-select");
    const segmentSelect = panel.querySelector(".custom-panel-segment-select");
    const notesArea = panel.querySelector(".custom-panel-notes");
    let persistTimer = null;
    const queuePersist = () => {
      if (persistTimer) {
        clearTimeout(persistTimer);
      }
      persistTimer = setTimeout(() => {
        persistTimer = null;
        savePanelLayout();
      }, 120);
    };
    titleInput?.addEventListener("input", () => {
      const nextTitle = String(titleInput.value || "").trim().slice(0, 80);
      panel.dataset.panelTitle = nextTitle || "Custom Panel";
      const heading = panel.querySelector("h2");
      if (heading) {
        heading.textContent = panel.dataset.panelTitle;
      }
      updatePanelHandleMeta(panel);
      renderToolsModalItems();
      queuePersist();
    });
    pageSelect?.addEventListener("change", () => {
      panel.dataset.panelPage = toPanelPage(pageSelect.value);
      updatePanelHandleMeta(panel);
      applyDashboardFilters();
      renderToolsModalItems();
      savePanelLayout();
    });
    segmentSelect?.addEventListener("change", () => {
      panel.dataset.panelSegment = toPanelSegment(segmentSelect.value);
      updatePanelHandleMeta(panel);
      applyDashboardFilters();
      renderToolsModalItems();
      savePanelLayout();
    });
    notesArea?.addEventListener("input", () => {
      queuePersist();
    });
    if (panelId !== panelConfig.id) {
      savePanelLayout();
    }
  });

  const viewState = readDashboardView();
  let currentPage = viewState.page;
  let currentSegment = viewState.segment;

  const updateToolbarState = () => {
    pageTabs.querySelectorAll("button[data-dashboard-page]").forEach((button) => {
      button.classList.toggle("active", button.dataset.dashboardPage === currentPage);
    });
    segmentTabs.querySelectorAll("button[data-dashboard-segment]").forEach((button) => {
      button.classList.toggle("active", button.dataset.dashboardSegment === currentSegment);
    });
  };

  const applyDashboardFilters = () => {
    const inModalMode = currentSegment === "modal";
    panelGrid.classList.toggle("hidden", inModalMode);
    if (inModalMode) {
      openToolsModal();
    } else {
      closeToolsModal();
    }
    panelMap.forEach((panel) => {
      const page = panel.dataset.panelPage || "operations";
      const segment = panel.dataset.panelSegment || "panel";
      const matchesPage = currentPage === "all" || page === currentPage;
      const matchesSegment = currentSegment === "panel" ? segment !== "tool" : currentSegment === "tool" ? segment === "tool" : true;
      panel.classList.toggle("hidden", !(matchesPage && matchesSegment && !inModalMode));
    });
    updateGridDensity();
    updateToolbarState();
    writeDashboardView({
      page: currentPage,
      segment: currentSegment,
    });
  };

  const focusPanelById = (panelId) => {
    const panel = panelMap.get(panelId);
    if (!panel) {
      return;
    }
    const panelPage = panel.dataset.panelPage || "operations";
    const panelSegment = panel.dataset.panelSegment === "tool" ? "tool" : "panel";
    currentPage = panelPage;
    currentSegment = panelSegment;
    applyDashboardFilters();
    panel.classList.add("dashboard-panel-focus");
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => {
      panel.classList.remove("dashboard-panel-focus");
    }, 900);
  };

  panelGrid.addEventListener("dragover", (event) => {
    if (!draggedPanel) {
      return;
    }
    event.preventDefault();
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const destination = target.closest(".dashboard-panel-card");
    if (!(destination instanceof HTMLElement) || destination === draggedPanel) {
      return;
    }
    const rect = destination.getBoundingClientRect();
    const shouldPlaceAfter = event.clientY > rect.top + rect.height / 2;
    if (shouldPlaceAfter) {
      panelGrid.insertBefore(draggedPanel, destination.nextElementSibling);
      return;
    }
    panelGrid.insertBefore(draggedPanel, destination);
  });

  panelGrid.addEventListener("drop", (event) => {
    event.preventDefault();
    savePanelLayout();
    updateGridDensity();
  });

  toolbar.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const page = target.dataset.dashboardPage;
    if (page) {
      currentPage = page;
      if (currentSegment === "modal") {
        currentSegment = "panel";
      }
      applyDashboardFilters();
      return;
    }
    const segment = target.dataset.dashboardSegment;
    if (segment) {
      currentSegment = segment;
      applyDashboardFilters();
    }
  });

  panelGrid.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const action = target.dataset.panelAction || "";
    if (action === "cycle-size") {
      const panelId = target.dataset.panelId || "";
      const panel = panelMap.get(panelId);
      if (!panel) {
        return;
      }
      panel.dataset.panelSize = nextPanelSize(panel.dataset.panelSize);
      syncPanelSizeButtonText();
      savePanelLayout();
      updateGridDensity();
      return;
    }
    if (action === "remove-custom") {
      const panelId = target.dataset.panelId || "";
      const panel = panelMap.get(panelId);
      if (!panel || panel.dataset.panelCustom !== "true") {
        return;
      }
      panel.remove();
      panelMap.delete(panelId);
      seenPanelIds.delete(panelId);
      renderToolsModalItems();
      savePanelLayout();
      applyDashboardFilters();
    }
  });

  addPanelBtn.addEventListener("click", () => {
    const currentCustomCount = getCustomPanelCount();
    if (currentCustomCount >= DASHBOARD_MAX_CUSTOM_PANELS) {
      window.alert(`Custom panel limit reached (${DASHBOARD_MAX_CUSTOM_PANELS}). Remove one before adding another.`);
      return;
    }
    const rawTitle = window.prompt("Panel title", `Custom Panel ${currentCustomCount + 1}`);
    if (rawTitle == null) {
      return;
    }
    const title = rawTitle.trim().slice(0, 80) || `Custom Panel ${currentCustomCount + 1}`;
    const page = currentPage === "all" ? "operations" : currentPage;
    const segment = currentSegment === "tool" ? "tool" : "panel";
    const panel = createCustomPanelElement({
      id: "",
      title,
      page,
      segment,
      notes: "",
      size: "auto",
    });
    const panelId = registerPanel(panel, {
      panelId: `custom-${title}`,
      title,
      page,
      segment,
      size: "auto",
      custom: true,
    });
    const titleInput = panel.querySelector(".custom-panel-title-input");
    const pageSelect = panel.querySelector(".custom-panel-page-select");
    const segmentSelect = panel.querySelector(".custom-panel-segment-select");
    const notesArea = panel.querySelector(".custom-panel-notes");
    let persistTimer = null;
    const queuePersist = () => {
      if (persistTimer) {
        clearTimeout(persistTimer);
      }
      persistTimer = setTimeout(() => {
        persistTimer = null;
        savePanelLayout();
      }, 120);
    };
    titleInput?.addEventListener("input", () => {
      const nextTitle = String(titleInput.value || "").trim().slice(0, 80);
      panel.dataset.panelTitle = nextTitle || "Custom Panel";
      const heading = panel.querySelector("h2");
      if (heading) {
        heading.textContent = panel.dataset.panelTitle;
      }
      updatePanelHandleMeta(panel);
      renderToolsModalItems();
      queuePersist();
    });
    pageSelect?.addEventListener("change", () => {
      panel.dataset.panelPage = toPanelPage(pageSelect.value);
      updatePanelHandleMeta(panel);
      applyDashboardFilters();
      renderToolsModalItems();
      savePanelLayout();
    });
    segmentSelect?.addEventListener("change", () => {
      panel.dataset.panelSegment = toPanelSegment(segmentSelect.value);
      updatePanelHandleMeta(panel);
      applyDashboardFilters();
      renderToolsModalItems();
      savePanelLayout();
    });
    notesArea?.addEventListener("input", () => {
      queuePersist();
    });

    currentPage = page;
    currentSegment = segment;
    applyDashboardFilters();
    renderToolsModalItems();
    savePanelLayout();
    focusPanelById(panelId);
  });

  openToolsModalBtn.addEventListener("click", () => {
    openToolsModal();
  });

  modalClose.addEventListener("click", () => {
    closeToolsModal();
    if (currentSegment === "modal") {
      currentSegment = "panel";
      applyDashboardFilters();
    }
  });

  toolsModal.addEventListener("click", (event) => {
    const target = event.target;
    if (target === toolsModal) {
      closeToolsModal();
      if (currentSegment === "modal") {
        currentSegment = "panel";
        applyDashboardFilters();
      }
      return;
    }
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const panelButton = target.closest(".dashboard-tool-item");
    if (!(panelButton instanceof HTMLElement)) {
      return;
    }
    const panelId = panelButton.dataset.panelId || "";
    closeToolsModal();
    focusPanelById(panelId);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }
    if (toolsModal.classList.contains("open")) {
      closeToolsModal();
      if (currentSegment === "modal") {
        currentSegment = "panel";
        applyDashboardFilters();
      }
    }
  });

  resetLayoutBtn.addEventListener("click", () => {
    window.localStorage.removeItem(DASHBOARD_LAYOUT_KEY);
    window.localStorage.removeItem(DASHBOARD_VIEW_KEY);
    window.localStorage.removeItem(DASHBOARD_CUSTOM_PANELS_KEY);
    [...panelMap.values()].forEach((panel) => {
      if (panel.dataset.panelCustom === "true") {
        const panelId = panel.dataset.panelId || "";
        panel.remove();
        panelMap.delete(panelId);
        seenPanelIds.delete(panelId);
      }
    });
    staticPanelOrder.forEach((panelId) => {
      const panel = panelMap.get(panelId);
      if (!panel) {
        return;
      }
      panel.dataset.panelSize = "auto";
      panelGrid.appendChild(panel);
    });
    currentPage = "operations";
    currentSegment = "panel";
    syncPanelSizeButtonText();
    renderToolsModalItems();
    applyDashboardFilters();
    savePanelLayout();
  });

  renderToolsModalItems();
  loadPanelLayout();
  updateCustomPanelCount();
  applyDashboardFilters();

  const workspaceBody = document.createElement("div");
  workspaceBody.className = "dashboard-workspace-body";
  workspaceBody.appendChild(panelGrid);
  if (utilityRail instanceof HTMLElement) {
    utilityRail.classList.remove("hidden");
    workspaceBody.appendChild(utilityRail);
  }

  workbench.append(toolbar, workspaceBody);
  root.classList.remove("layout");
  root.classList.add("dashboard-root-workbench");
  root.append(workbench, toolsModal);

  leftColumn.remove();
  rightColumn.remove();
  root.dataset.workbenchReady = "true";
};

const splitPathInput = (raw) => {
  return String(raw || "")
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const timestamp = () => new Date().toISOString();
const formatClock = (iso) => {
  const date = new Date(iso || Date.now());
  if (Number.isNaN(date.getTime())) {
    return "--:--:--";
  }
  return date.toLocaleTimeString();
};

const logActivity = (title, payload) => {
  const logNode = $("activity-log");
  if (!logNode) {
    return;
  }
  const head = `[${new Date().toLocaleTimeString()}] ${title}`;
  const body = payload === undefined ? "" : `\n${toJSON(payload)}`;
  const next = `${head}${body}\n\n${logNode.textContent || ""}`.trim();
  logNode.textContent = next.slice(0, 16000);
};

const loadHistory = () => {
  const raw = window.localStorage.getItem(HISTORY_KEY);
  if (!raw) {
    return [];
  }
  const parsed = parseMaybeJSON(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed;
};

const saveHistory = () => {
  window.localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history));
};

const loadCoworkMessages = () => {
  const raw = window.localStorage.getItem(COWORK_CHAT_KEY);
  if (!raw) {
    return [];
  }
  const parsed = parseMaybeJSON(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      return {
        at: item.at || timestamp(),
        role: item.role || "agent",
        text: item.text || "",
      };
    })
    .filter(Boolean)
    .slice(-120);
};

const saveCoworkMessages = () => {
  window.localStorage.setItem(COWORK_CHAT_KEY, JSON.stringify(state.coworkMessages.slice(-120)));
};

const addCoworkMessage = (role, text) => {
  state.coworkMessages.push({
    at: timestamp(),
    role,
    text: String(text || "").trim(),
  });
  state.coworkMessages = state.coworkMessages.slice(-120);
  saveCoworkMessages();
  renderCoworkChat();
};

const renderCoworkChat = () => {
  const node = $("cowork-chat-log");
  if (!node) {
    renderBlueprintChatPreview();
    return;
  }
  node.innerHTML = "";
  if (!state.coworkMessages.length) {
    const empty = document.createElement("div");
    empty.className = "cowork-msg";
    empty.innerHTML = "<strong>System</strong>Dispatch tasks from here to run agent cowork flows.";
    node.appendChild(empty);
    renderBlueprintChatPreview();
    return;
  }
  state.coworkMessages.forEach((message) => {
    const item = document.createElement("div");
    const role = String(message.role || "agent");
    item.className = `cowork-msg msg-${role}`;
    const title = role === "user" ? "You" : role === "agent" ? "Agent" : "System";
    item.innerHTML = `<strong>${title}</strong>${String(message.text || "").replace(/</g, "&lt;")}<span class="msg-meta">${formatClock(
      message.at,
    )}</span>`;
    node.appendChild(item);
  });
  node.scrollTop = node.scrollHeight;
  renderBlueprintChatPreview();
};

const renderCoworkConversations = () => {
  const node = $("cowork-conversations");
  if (!node) {
    return;
  }
  node.innerHTML = "";
  const rows = state.history.slice(0, 14);
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "history-item";
    empty.textContent = "No operations yet.";
    node.appendChild(empty);
    return;
  }
  rows.forEach((item) => {
    const wrap = document.createElement("div");
    wrap.className = "history-item";
    const title = document.createElement("strong");
    title.textContent = item.endpoint || "event";
    wrap.appendChild(title);
    const timeNode = document.createElement("small");
    timeNode.textContent = new Date(item.at).toLocaleString();
    wrap.appendChild(timeNode);
    const meta = document.createElement("code");
    meta.textContent = toJSON({
      ok: item.ok,
      args: item.args || {},
    });
    wrap.appendChild(meta);
    node.appendChild(wrap);
  });
};

const ellipsizeText = (value, maxLength = 66) => {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}...`;
};

const deriveBlueprintThreadTitle = (entry) => {
  const args = entry?.args && typeof entry.args === "object" && !Array.isArray(entry.args) ? entry.args : {};
  const candidate = [
    args.prompt,
    args.task,
    args.query,
    args.goal,
    args.text,
    args.handle,
    args.username,
  ].find((item) => typeof item === "string" && item.trim());
  if (candidate) {
    return ellipsizeText(candidate, 62);
  }
  const endpoint = String(entry?.endpoint || "thread").replace(/[_-]+/g, " ").trim();
  return ellipsizeText(endpoint || "thread", 62);
};

const renderBlueprintThreadList = () => {
  const list = $("pplx-thread-list");
  if (!(list instanceof HTMLElement)) {
    return;
  }
  list.innerHTML = "";
  const rows = state.history.slice(0, 16);
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "pplx-thread-empty";
    empty.textContent = "No threads yet. Ask anything to start.";
    list.appendChild(empty);
    return;
  }
  rows.forEach((item, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pplx-thread-item";
    button.dataset.pplxHistoryIndex = String(index);
    button.textContent = deriveBlueprintThreadTitle(item);
    list.appendChild(button);
  });
};

const renderBlueprintChatPreview = () => {
  const node = $("pplx-chat-preview");
  if (!(node instanceof HTMLElement)) {
    return;
  }
  const latest = [...state.coworkMessages].reverse().find((item) => typeof item?.text === "string" && item.text.trim());
  if (!latest) {
    node.textContent = "Ask anything to run a social mission, build a draft, or capture context.";
    return;
  }
  const role = latest.role === "user" ? "You" : latest.role === "agent" ? "Agent" : "System";
  node.textContent = `${role}: ${ellipsizeText(latest.text, 240)}`;
};

const initBlueprintShell = () => {
  if (!BLUEPRINT_SHELL_MODE) {
    return;
  }
  const root = $("dashboard-root");
  if (!(root instanceof HTMLElement) || root.dataset.blueprintShellReady === "true") {
    return;
  }
  root.dataset.blueprintShellReady = "true";
  root.classList.add("blueprint-shell-root");

  [...root.children].forEach((child) => {
    if (!(child instanceof HTMLElement)) {
      return;
    }
    child.classList.add("blueprint-legacy-node");
    child.setAttribute("aria-hidden", "true");
  });

  const shell = document.createElement("div");
  shell.id = "pplx-shell";
  shell.className = "pplx-shell";
  shell.innerHTML = `
    <aside class="pplx-sidebar">
      <div class="pplx-sidebar-top">
        <div class="pplx-brand">
          <span class="pplx-brand-mark">✣</span>
          <span class="pplx-brand-name">Prompt or Die</span>
        </div>
        <button type="button" class="pplx-sidebar-toggle" aria-label="Toggle sidebar">⋮</button>
      </div>
      <button type="button" id="pplx-new-thread" class="pplx-new-thread">New Thread</button>
      <nav class="pplx-nav">
        <button type="button" class="pplx-nav-item active" data-pplx-nav="home"><span>⌕</span>Home</button>
        <button type="button" class="pplx-nav-item" data-pplx-nav="discover"><span>⊕</span>Discover</button>
        <button type="button" class="pplx-nav-item" data-pplx-nav="spaces"><span>✦</span>Spaces</button>
        <button type="button" class="pplx-nav-item" data-pplx-nav="library"><span>⌂</span>Library</button>
      </nav>
      <div id="pplx-thread-list" class="pplx-thread-list"></div>
      <div class="pplx-sidebar-footer">
        <button type="button" class="pplx-shortcuts">⌘ Shortcuts</button>
        <div class="pplx-user-row">
          <span class="pplx-user-badge">S</span>
          <span class="pplx-user-name">Social Suite <small>live</small></span>
          <span class="pplx-user-gear">⚙</span>
        </div>
      </div>
    </aside>
    <section class="pplx-main">
      <div class="pplx-center-mark" aria-hidden="true">
        <span>✣</span>
      </div>
      <form id="pplx-composer-form" class="pplx-composer">
        <label class="pplx-composer-label" for="pplx-composer-input">Ask anything...</label>
        <textarea id="pplx-composer-input" rows="1" placeholder="Ask anything..."></textarea>
        <div class="pplx-composer-row">
          <div class="pplx-composer-left">
            <button class="pplx-mini-btn active" type="button" data-pplx-tool="search" aria-label="Search">⌕</button>
            <button class="pplx-mini-btn" type="button" data-pplx-tool="reason" aria-label="Reason">⟳</button>
            <button class="pplx-mini-btn" type="button" data-pplx-tool="focus" aria-label="Focus">⌂</button>
          </div>
          <div class="pplx-composer-right">
            <button class="pplx-icon-btn" type="button" data-pplx-tool="model" aria-label="Model">◫</button>
            <button class="pplx-icon-btn" type="button" data-pplx-tool="web" aria-label="Web">◌</button>
            <button class="pplx-icon-btn" type="button" data-pplx-tool="attach" aria-label="Attach">⌘</button>
            <button class="pplx-icon-btn" type="button" data-pplx-tool="voice" aria-label="Voice">◉</button>
            <button class="pplx-icon-btn" type="button" id="pplx-send-btn" aria-label="Send">➤</button>
          </div>
        </div>
      </form>
      <div id="pplx-chat-preview" class="pplx-chat-preview"></div>
    </section>
  `;
  root.appendChild(shell);

  const navButtons = [...shell.querySelectorAll("[data-pplx-nav]")];
  navButtons.forEach((button) => {
    button.addEventListener("click", () => {
      navButtons.forEach((entry) => entry.classList.remove("active"));
      button.classList.add("active");
      const navId = String(button.getAttribute("data-pplx-nav") || "home");
      if (navId === "library") {
        $("utility-rail-toggle")?.click();
      } else if (navId === "spaces") {
        $("cowork-mission-query")?.focus();
      } else if (navId === "discover") {
        const input = $("pplx-composer-input");
        if (input instanceof HTMLTextAreaElement) {
          input.value = "Find current high-signal X trends for AI agents and suggest three post angles.";
          input.focus();
        }
      }
    });
  });

  const runBlueprintSubmit = () => {
    const promptNode = $("pplx-composer-input");
    const task = (promptNode instanceof HTMLTextAreaElement ? promptNode.value : "").trim();
    if (!task) {
      return;
    }
    const taskInput = $("cowork-task-input");
    if (taskInput instanceof HTMLTextAreaElement) {
      taskInput.value = task;
    }
    const coworkForm = $("cowork-form");
    if (coworkForm instanceof HTMLFormElement) {
      coworkForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }
    if (promptNode instanceof HTMLTextAreaElement) {
      promptNode.value = "";
    }
  };

  $("pplx-composer-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    runBlueprintSubmit();
  });

  $("pplx-composer-input")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      runBlueprintSubmit();
    }
  });

  $("pplx-send-btn")?.addEventListener("click", () => {
    runBlueprintSubmit();
  });

  $("pplx-new-thread")?.addEventListener("click", () => {
    state.coworkMessages = [];
    saveCoworkMessages();
    renderCoworkChat();
    renderBlueprintChatPreview();
    const input = $("pplx-composer-input");
    if (input instanceof HTMLTextAreaElement) {
      input.value = "";
      input.focus();
    }
  });

  $("pplx-thread-list")?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const row = target.closest("[data-pplx-history-index]");
    if (!(row instanceof HTMLElement)) {
      return;
    }
    const index = Number(row.dataset.pplxHistoryIndex);
    const entry = Number.isFinite(index) ? state.history[index] : null;
    if (!entry) {
      return;
    }
    const prompt = deriveBlueprintThreadTitle(entry);
    const input = $("pplx-composer-input");
    if (input instanceof HTMLTextAreaElement) {
      input.value = prompt;
      input.focus();
    }
  });

  shell.querySelectorAll("[data-pplx-tool]").forEach((node) => {
    node.addEventListener("click", () => {
      const toolId = String(node.getAttribute("data-pplx-tool") || "").trim();
      if (toolId === "attach") {
        openContextPicker(contextPayloadFromSelection("blueprint-toolbar"));
      } else if (toolId === "web") {
        $("workflow-run")?.focus();
      } else if (toolId === "model") {
        $("provider-refresh")?.click();
      } else if (toolId === "voice") {
        $("ai-form")?.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    });
  });

  renderBlueprintThreadList();
  renderBlueprintChatPreview();
};

const recordHistory = (entry) => {
  state.history.unshift({
    at: timestamp(),
    ...entry,
  });
  state.history = state.history.slice(0, MAX_HISTORY);
  saveHistory();
  renderHistory();
  renderCoworkConversations();
};

const renderHistory = () => {
  const container = $("history-list");
  if (!container) {
    renderBlueprintThreadList();
    return;
  }
  container.innerHTML = "";
  if (!state.history.length) {
    const empty = document.createElement("div");
    empty.className = "history-item";
    empty.textContent = "No runs yet.";
    container.appendChild(empty);
    renderBlueprintThreadList();
    return;
  }

  state.history.forEach((item, index) => {
    const node = document.createElement("div");
    node.className = "history-item";

    const title = document.createElement("strong");
    title.textContent = `${item.endpoint}  ${item.ok ? "OK" : "FAIL"}`;
    node.appendChild(title);

    const at = document.createElement("small");
    at.textContent = new Date(item.at).toLocaleString();
    node.appendChild(at);

    const preview = document.createElement("code");
    preview.textContent = toJSON(item.args || {});
    node.appendChild(preview);

    const rerun = document.createElement("button");
    rerun.type = "button";
    rerun.className = "ghost";
    rerun.textContent = "Run again";
    rerun.dataset.historyIndex = String(index);
    node.appendChild(rerun);

    container.appendChild(node);
  });
  renderBlueprintThreadList();
};

const apiGet = async (url) => {
  const response = await fetch(url);
  const text = await response.text();
  const parsed = parseMaybeJSON(text || "{}");
  if (!response.ok) {
    throw new Error(toJSON(parsed));
  }
  return parsed;
};

const apiPost = async (url, body) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = parseMaybeJSON(text || "{}");
  if (!response.ok) {
    throw new Error(toJSON(parsed));
  }
  return parsed;
};

const toInt = (raw, fallback) => {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.trunc(value);
};

const refreshProviderStatus = async () => {
  const result = await apiGet("/api/providers/status");
  state.providerStatus = result?.status || null;
  renderCoworkShellBanner();
  setText("provider-status-output", result);
  return result;
};

const refreshIntegrations = async () => {
  const result = await apiGet("/api/integrations/status");
  state.integrations = result?.integrations || null;
  renderIntegrationBadges();
  renderCoworkShellBanner();
  setText("integrations-output", result);
  return result;
};

const renderIntegrationBadges = () => {
  const node = $("integration-badges");
  if (!node) {
    return;
  }
  const readiness = state.integrations?.readiness || {};
  const rows = [
    {
      label: "social-agent",
      value: Boolean(readiness.socialAgentReady),
      text: readiness.socialAgentReady ? "ready" : "blocked",
    },
    {
      label: "watch",
      value: Boolean(readiness.watchReady),
      text: readiness.watchReady ? "ready" : "blocked",
    },
    {
      label: "livekit",
      value: Boolean(state.integrations?.livekit?.configured),
      text: state.integrations?.livekit?.configured ? "configured" : "needs config",
    },
  ];
  node.innerHTML = "";
  rows.forEach((row) => {
    const badge = document.createElement("div");
    badge.className = `integration-badge ${row.value ? "ready" : "blocked"}`;
    badge.innerHTML = `<strong>${row.label}</strong><span>${row.text}</span>`;
    node.appendChild(badge);
  });
};

const refreshIntegrationActionCatalog = async () => {
  const result = await apiGet("/api/integrations/actions/catalog");
  state.integrationActionCatalog = Array.isArray(result?.actions) ? result.actions : [];
  const select = $("integration-runbook-select");
  if (select) {
    const current = select.value;
    select.innerHTML = "";
    state.integrationActionCatalog.forEach((runbook) => {
      const option = document.createElement("option");
      option.value = runbook.id;
      option.textContent = `${runbook.title} (${runbook.id})`;
      select.appendChild(option);
    });
    if (current && state.integrationActionCatalog.some((runbook) => runbook.id === current)) {
      select.value = current;
    }
  }
  setText("integration-action-output", result);
  return result;
};

const refreshIntegrationActionHistory = async () => {
  const result = await apiGet("/api/integrations/actions/history?limit=80");
  state.integrationActionHistory = Array.isArray(result?.history) ? result.history : [];
  setText("integration-actions-history-output", result);
  return result;
};

const refreshIntegrationSubscribers = async () => {
  const result = await apiGet("/api/integrations/subscriptions");
  state.integrationSubscribers = Array.isArray(result?.subscriptions) ? result.subscriptions : [];
  setText("integration-subs-output", result);
  return result;
};

const refreshIntegrationBridgeStatus = async () => {
  const result = await apiGet("/api/integrations/bridge/status");
  state.integrationBridgeStatus = result?.bridge || null;
  setText("integration-bridge-output", result);
  return result;
};

const parseJsonField = (id, fallback = {}) => {
  const raw = ($(id)?.value || "").trim();
  if (!raw) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fallback;
    }
    return parsed;
  } catch {
    throw new Error(`${id} must be valid JSON object.`);
  }
};

const runIntegrationActionFlow = async (mode) => {
  const actionId = ($("integration-runbook-select")?.value || "").trim();
  if (!actionId) {
    throw new Error("Select an integration runbook.");
  }
  const params = parseJsonField("integration-params-json", {});
  if (mode === "dry_run") {
    const result = await apiPost("/api/integrations/actions", {
      mode: "dry_run",
      actionId,
      params,
    });
    if ($("integration-confirm-token")) {
      $("integration-confirm-token").value = result?.confirmToken || "";
    }
    setText("integration-action-output", result);
    await refreshIntegrations();
    await refreshIntegrationBridgeStatus();
    await refreshIntegrationActionHistory();
    return result;
  }
  const confirmToken = ($("integration-confirm-token")?.value || "").trim();
  const result = await apiPost("/api/integrations/actions", {
    mode: "execute",
    actionId,
    params,
    confirmToken,
  });
  setText("integration-action-output", result);
  await refreshIntegrations();
  await refreshMacApps();
  await refreshCoworkState();
  await refreshIntegrationBridgeStatus();
  await refreshIntegrationActionHistory();
  return result;
};

const refreshExtensions = async () => {
  const result = await apiGet("/api/extensions");
  state.extensions = result?.extensions || null;
  setText("extensions-output", result);
  return result;
};

const refreshAutonomy = async () => {
  const result = await apiGet("/api/agent/autonomy");
  state.autonomy = result || null;
  setText("autonomy-output", result);
  return result;
};

const refreshApprovals = async () => {
  const result = await apiGet("/api/agent/approvals");
  const approvals = result?.approvals;
  if (Array.isArray(approvals)) {
    state.approvals = approvals;
  } else if (approvals && typeof approvals === "object") {
    state.approvals = [
      ...(Array.isArray(approvals.x) ? approvals.x : []),
      ...(Array.isArray(approvals.code) ? approvals.code : []),
      ...(Array.isArray(approvals.skills) ? approvals.skills : []),
    ];
  } else {
    state.approvals = [];
  }
  setText("approvals-output", result);
  return result;
};

const populateSkillSelectors = () => {
  const ids = (state.skills || []).map((item) => item.id);
  const targets = ["skill-select", "task-skill-select"];
  targets.forEach((targetId) => {
    const node = $(targetId);
    if (!node) return;
    const current = node.value;
    node.innerHTML = "";
    if (targetId === "task-skill-select") {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "auto-route";
      node.appendChild(opt);
    }
    ids.forEach((id) => {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = id;
      node.appendChild(option);
    });
    if (current && ids.includes(current)) {
      node.value = current;
    }
  });
};

const refreshSkills = async () => {
  const result = await apiGet("/api/skills");
  state.skills = Array.isArray(result?.skills) ? result.skills : [];
  populateSkillSelectors();
  setText("skills-output", result);
  return result;
};

const refreshTasks = async () => {
  const result = await apiGet("/api/agent/tasks");
  state.tasks = Array.isArray(result?.tasks) ? result.tasks : [];
  const logTaskSelect = $("cowork-log-task-select");
  if (logTaskSelect) {
    const current = logTaskSelect.value;
    logTaskSelect.innerHTML = "";
    const optLatest = document.createElement("option");
    optLatest.value = "";
    optLatest.textContent = "latest task";
    logTaskSelect.appendChild(optLatest);
    (state.tasks || []).slice(0, 30).forEach((task) => {
      const option = document.createElement("option");
      option.value = task.id;
      option.textContent = `${task.id} (${task.status})`;
      logTaskSelect.appendChild(option);
    });
    if (current && (state.tasks || []).some((task) => task.id === current)) {
      logTaskSelect.value = current;
    }
  }
  renderCoworkTaskBoard();
  setText("tasks-output", result);
  return result;
};

const renderCoworkMetrics = () => {
  const node = $("cowork-metrics");
  if (!node) {
    return;
  }
  const summary = state.coworkState?.summary;
  if (!summary) {
    node.innerHTML = "";
    return;
  }
  const cards = [
    { label: "running tasks", value: summary.tasks?.running ?? 0 },
    { label: "queued tasks", value: summary.tasks?.queued ?? 0 },
    { label: "pending approvals", value: summary.approvals?.total ?? 0 },
    { label: "active watch", value: summary.watch?.active ?? 0 },
  ];
  node.innerHTML = "";
  cards.forEach((card) => {
    const item = document.createElement("div");
    item.className = "cowork-metric";
    const label = document.createElement("strong");
    label.textContent = card.label;
    const value = document.createElement("span");
    value.textContent = String(card.value);
    item.appendChild(label);
    item.appendChild(value);
    node.appendChild(item);
  });
};

const renderCoworkShellBanner = () => {
  const node = $("cowork-shell-banner");
  if (!node) {
    return;
  }
  const summary = state.coworkState?.summary || {};
  const running = Number(summary.tasks?.running || 0);
  const queued = Number(summary.tasks?.queued || 0);
  const approvals = Number(summary.approvals?.total || 0);
  const watch = Number(summary.watch?.active || 0);
  const route = state.providerStatus?.activeRoute || state.providerStatus?.mode || "unknown";
  const livekit = state.integrations?.livekit?.configured ? "configured" : "off";
  node.textContent = [
    "milady cowork gateway",
    `route=${route} tasks=${running}/${queued} approvals=${approvals} watch=${watch}`,
    `livekit=${livekit}`,
    "slash: /status /help /new /compact /watch",
  ].join("\n");
};

const renderCoworkTaskBoard = () => {
  const node = $("cowork-task-board");
  if (!node) {
    return;
  }
  node.innerHTML = "";
  const rows = (state.tasks || []).slice(0, 8);
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "history-item";
    empty.textContent = "No tasks yet.";
    node.appendChild(empty);
    return;
  }
  rows.forEach((task) => {
    const card = document.createElement("div");
    card.className = "cowork-task-card";

    const head = document.createElement("div");
    head.className = "cowork-task-card-head";

    const taskId = document.createElement("code");
    taskId.textContent = task.id;
    head.appendChild(taskId);

    const status = document.createElement("span");
    status.className = `cowork-task-status status-${String(task.status || "").toLowerCase()}`;
    status.textContent = String(task.status || "unknown");
    head.appendChild(status);
    card.appendChild(head);

    const prompt = document.createElement("div");
    prompt.className = "cowork-task-prompt";
    prompt.textContent = String(task.prompt || "").slice(0, 220);
    card.appendChild(prompt);

    if (task.dependsOnTaskId || task.chainId) {
      const meta = document.createElement("code");
      meta.textContent = `dependsOn=${task.dependsOnTaskId || "none"} chain=${task.chainId || "none"} step=${
        typeof task.chainIndex === "number" && typeof task.chainLength === "number"
          ? `${task.chainIndex + 1}/${task.chainLength}`
          : "n/a"
      }`;
      card.appendChild(meta);
    }

    const actions = document.createElement("div");
    actions.className = "cowork-task-actions";

    [
      { label: "Load", action: "load" },
      { label: "Retry", action: "retry" },
      { label: "Watch", action: "watch" },
    ].forEach((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost";
      button.textContent = item.label;
      button.dataset.taskAction = item.action;
      button.dataset.taskId = task.id;
      actions.appendChild(button);
    });

    card.appendChild(actions);
    node.appendChild(card);
  });
};

const readSelectedWatchSessionId = () => {
  const selectValue = ($("watch-session-select")?.value || "").trim();
  if (selectValue) {
    return selectValue;
  }
  return ($("watch-session-id")?.value || "").trim();
};

const syncWatchSessionSelection = (sessionId) => {
  const normalized = String(sessionId || "").trim();
  if ($("watch-session-id")) {
    $("watch-session-id").value = normalized;
  }
  const select = $("watch-session-select");
  if (!select) {
    return;
  }
  if (!normalized) {
    select.value = "";
    return;
  }
  const exists = [...select.options].some((option) => option.value === normalized);
  if (exists) {
    select.value = normalized;
  }
};

const renderWatchSessionOptions = () => {
  const select = $("watch-session-select");
  if (!select) {
    return;
  }
  const activeSessions = Array.isArray(state.coworkState?.active?.watchSessions) ? state.coworkState.active.watchSessions : [];
  const current = readSelectedWatchSessionId();
  select.innerHTML = "";
  const autoOption = document.createElement("option");
  autoOption.value = "";
  autoOption.textContent = "auto (most recent active)";
  select.appendChild(autoOption);
  activeSessions.forEach((session) => {
    const option = document.createElement("option");
    option.value = session.id;
    option.textContent = `${session.id} • ${session.sourceId}${session.taskId ? ` • ${session.taskId}` : ""}`;
    select.appendChild(option);
  });
  if (current && activeSessions.some((session) => session.id === current)) {
    select.value = current;
  } else {
    select.value = "";
  }
};

const resolveActiveWatchSession = () => {
  const activeSessions = Array.isArray(state.coworkState?.active?.watchSessions) ? state.coworkState.active.watchSessions : [];
  const selectedSessionId = readSelectedWatchSessionId();
  if (selectedSessionId) {
    const selected = activeSessions.find((session) => session.id === selectedSessionId);
    if (selected) {
      return selected;
    }
  }
  return activeSessions[0] || null;
};

const setObserverIframeSession = (session) => {
  const iframe = $("cowork-live-iframe");
  if (!iframe) {
    return;
  }
  const basePath = "/live.html";
  if (!session?.id) {
    iframe.setAttribute("src", basePath);
    return;
  }
  const params = new URLSearchParams();
  params.set("sessionId", String(session.id));
  params.set("sourceId", String(session.sourceId || "embedded-browser"));
  if (session.taskId) {
    params.set("taskId", String(session.taskId));
  }
  iframe.setAttribute("src", `${basePath}?${params.toString()}`);
};

const renderWatchObserverMeta = () => {
  const node = $("cowork-watch-meta");
  if (!node) {
    return;
  }
  const session = resolveActiveWatchSession();
  const selectedSessionId = readSelectedWatchSessionId();
  if (!session && selectedSessionId) {
    node.textContent = `Selected session ${selectedSessionId} is not active.`;
    return;
  }
  if (!session) {
    node.textContent = "No active watch session.";
    return;
  }
  const lastFrame = session.lastFrameAt ? new Date(session.lastFrameAt).toLocaleTimeString() : "n/a";
  const transport = session.transport || "local";
  const room = session.livekitRoom ? ` room=${session.livekitRoom}` : "";
  node.textContent = `session=${session.id} source=${session.sourceId} task=${session.taskId || "none"} transport=${transport}${room} frames=${
    session.frameCount || 0
  } last=${lastFrame}`;
};

const startWatchSessionFlow = async ({ sourceId, taskId, fps, outputId = "mac-policy-output" }) => {
  const result = await apiPost("/api/watch/start", {
    sourceId,
    taskId: taskId || undefined,
    fps: typeof fps === "number" && Number.isFinite(fps) ? fps : undefined,
  });
  setText(outputId, result);
  syncWatchSessionSelection(result?.session?.id || "");
  setText("watch-output", {
    session: result?.session || null,
    remoteTransport: result?.remoteTransport || null,
  });
  await refreshMacApps();
  await refreshCoworkState();
  if (taskId && $("cowork-log-task-select")) {
    $("cowork-log-task-select").value = taskId;
  }
  await refreshTaskLogTail();
  renderWatchObserverMeta();
  if (result?.session) {
    setObserverIframeSession(result.session);
  }
  return result;
};

const mintLivekitViewerToken = async (outputId = "watch-output") => {
  const activeSession = resolveActiveWatchSession();
  const sessionId = (readSelectedWatchSessionId() || activeSession?.id || "").trim();
  const sourceId = ($("watch-source-select")?.value || activeSession?.sourceId || "embedded-browser").trim();
  const taskId = ($("task-id")?.value || activeSession?.taskId || "").trim();
  const result = await apiPost("/api/livekit/token", {
    sessionId: sessionId || undefined,
    sourceId: sourceId || undefined,
    taskId: taskId || undefined,
  });
  let copiedToClipboard = false;
  if (result?.livekit?.token && navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(String(result.livekit.token));
      copiedToClipboard = true;
    } catch {
      copiedToClipboard = false;
    }
  }
  const payload = {
    ...result,
    copiedToClipboard,
  };
  setText(outputId, payload);
  if (outputId !== "watch-output") {
    setText("watch-output", payload);
  }
  return result;
};

const refreshCoworkState = async () => {
  const result = await apiGet("/api/cowork/state");
  state.coworkState = result || null;
  renderWatchSessionOptions();
  renderCoworkMetrics();
  renderCoworkShellBanner();
  renderWatchObserverMeta();
  setText("cowork-state-output", result);
  return result;
};

const refreshCoworkMissions = async () => {
  const result = await apiGet("/api/cowork/missions");
  const missions = Array.isArray(result?.missions) ? result.missions : [];
  state.coworkMissions = missions.filter((mission) => String(mission?.lane || "").toLowerCase() === "social");
  const select = $("cowork-mission-select");
  if (select) {
    const current = select.value;
    select.innerHTML = "";
    state.coworkMissions.forEach((mission) => {
      const option = document.createElement("option");
      option.value = mission.id;
      option.textContent = `${mission.title} (${mission.lane})`;
      select.appendChild(option);
    });
    if (current && state.coworkMissions.some((mission) => mission.id === current)) {
      select.value = current;
    }
  }
  return result;
};

const refreshTaskLogTail = async () => {
  const selectedTaskId = ($("cowork-log-task-select")?.value || "").trim();
  const sourceTaskId = selectedTaskId || state.tasks?.[0]?.id;
  if (!sourceTaskId) {
    setText("cowork-log-output", "No tasks yet.");
    return null;
  }
  const typeFilter = ($("cowork-log-type-filter")?.value || "").trim();
  const query = typeFilter ? `?limit=120&type=${encodeURIComponent(typeFilter)}` : "?limit=120";
  const result = await apiGet(`/api/agent/tasks/${encodeURIComponent(sourceTaskId)}/logs${query}`);
  state.taskLogs = Array.isArray(result?.logs) ? result.logs : [];
  const lines = state.taskLogs.map((entry) => {
    const payload = entry?.payload && typeof entry.payload === "object" ? entry.payload : null;
    const payloadText = payload ? ` ${JSON.stringify(payload)}` : "";
    return `[${entry.at || ""}] ${entry.type || "event"} ${entry.message || ""}${payloadText}`;
  });
  setText("cowork-log-output", {
    taskId: sourceTaskId,
    count: state.taskLogs.length,
    lines,
  });
  return result;
};

const refreshMacApps = async () => {
  const [apps, policy, watch] = await Promise.all([
    apiGet("/api/mac/apps"),
    apiGet("/api/mac/policy"),
    apiGet("/api/watch/sources"),
  ]);
  state.macApps = Array.isArray(apps?.apps) ? apps.apps : [];
  state.watchSources = Array.isArray(watch?.sources) ? watch.sources : [];
  const allowedUiAppIds = new Set(["antigravity", "chrome"]);
  const uiMacApps = state.macApps.filter((app) => allowedUiAppIds.has(app.id));
  const uiWatchSources = state.watchSources.filter((source) => source.id === "embedded-browser" || allowedUiAppIds.has(source.id));
  const allowlist = Array.isArray(policy?.macControl?.appAllowlist) ? policy.macControl.appAllowlist : [];
  if ($("mac-allow-antigravity")) {
    $("mac-allow-antigravity").checked = allowlist.includes("antigravity");
  }
  if ($("mac-allow-chrome")) {
    $("mac-allow-chrome").checked = allowlist.includes("chrome");
  }
  const macAppSelect = $("mac-app-select");
  if (macAppSelect) {
    const current = macAppSelect.value;
    macAppSelect.innerHTML = "";
    uiMacApps.forEach((app) => {
      const option = document.createElement("option");
      option.value = app.id;
      option.textContent = `${app.id}${app.available ? "" : " (unavailable)"}`;
      option.disabled = !app.available;
      macAppSelect.appendChild(option);
    });
    const availableIds = uiMacApps.filter((app) => app.available).map((app) => app.id);
    if (current && availableIds.includes(current)) {
      macAppSelect.value = current;
    } else if (availableIds.length) {
      macAppSelect.value = availableIds[0];
    }
  }
  setText("mac-policy-output", {
    apps,
    policy,
    watch,
  });
  const watchSelect = $("watch-source-select");
  if (watchSelect) {
    const current = watchSelect.value;
    watchSelect.innerHTML = "";
    uiWatchSources.forEach((source) => {
      const option = document.createElement("option");
      option.value = source.id;
      option.textContent = `${source.id}${source.available ? "" : " (unavailable)"}`;
      option.disabled = !source.available;
      watchSelect.appendChild(option);
    });
    const availableSourceIds = uiWatchSources.filter((source) => source.available).map((source) => source.id);
    if (current && availableSourceIds.includes(current)) {
      watchSelect.value = current;
    } else if (availableSourceIds.length) {
      watchSelect.value = availableSourceIds[0];
    }
  }
  renderWatchSessionOptions();
  renderWatchObserverMeta();
  return {
    apps,
    policy,
    watch,
  };
};

const refreshLivekitStatus = async () => {
  const result = await apiGet("/api/livekit/status");
  state.livekitStatus = result?.livekit || null;
  if ($("livekit-enabled")) {
    $("livekit-enabled").checked = Boolean(result?.livekit?.enabled);
  }
  if ($("livekit-ws-url")) {
    $("livekit-ws-url").value = result?.livekit?.wsUrl || "";
  }
  if ($("livekit-api-key")) {
    const input = $("livekit-api-key");
    if (!input.dataset.userEdited) {
      input.value = "";
    }
    input.placeholder = result?.livekit?.apiKeySet ? "configured (hidden)" : "LIVEKIT_API_KEY";
  }
  if ($("livekit-room-prefix")) {
    $("livekit-room-prefix").value = result?.livekit?.roomPrefix || "milady-cowork";
  }
  if ($("livekit-stream-mode")) {
    $("livekit-stream-mode").value =
      result?.livekit?.streamMode === "events_and_frames" ? "events_and_frames" : "events_only";
  }
  setText("livekit-output", result);
  return result;
};

const runIntegrationAppOpen = async (appId, url) => {
  const result = await apiPost("/api/mac/apps/open", {
    appId,
    url: url || undefined,
  });
  setText("integrations-output", result);
  await refreshMacApps();
  await refreshCoworkState();
  await refreshIntegrations();
  return result;
};

const runCoworkQuickAction = async (action) => {
  const prompt = ($("cowork-quick-prompt")?.value || "").trim();
  const url = ($("cowork-quick-url")?.value || "").trim();
  const result = await apiPost("/api/cowork/quick-action", {
    action,
    prompt: prompt || undefined,
    url: url || undefined,
  });
  setText("cowork-output", result);
  const taskId = result?.task?.id;
  if (taskId && $("task-id")) {
    $("task-id").value = taskId;
  }
  await refreshTasks();
  await refreshCoworkState();
  await refreshTaskLogTail();
  return result;
};

const runCoworkSlashCommand = async (rawInput) => {
  const input = String(rawInput || "").trim();
  if (!input.startsWith("/")) {
    return false;
  }
  const [commandRaw, ...restParts] = input.split(" ");
  const command = commandRaw.toLowerCase();
  const args = restParts.join(" ").trim();

  if (command === "/help") {
    addCoworkMessage(
      "agent",
      "Commands: /status, /new, /reset, /compact, /watch, /help",
    );
    return true;
  }

  if (command === "/status") {
    await Promise.all([refreshProviderStatus(), refreshCoworkState(), refreshIntegrations()]);
    const summary = state.coworkState?.summary || {};
    addCoworkMessage(
      "agent",
      `route=${state.providerStatus?.activeRoute || "unknown"} running=${summary.tasks?.running || 0} queued=${
        summary.tasks?.queued || 0
      } approvals=${summary.approvals?.total || 0} watch=${summary.watch?.active || 0}`,
    );
    return true;
  }

  if (command === "/new" || command === "/reset") {
    state.coworkMessages = [];
    saveCoworkMessages();
    renderCoworkChat();
    addCoworkMessage("system", "Chat session reset.");
    return true;
  }

  if (command === "/compact") {
    const keep = 24;
    if (state.coworkMessages.length > keep) {
      state.coworkMessages = state.coworkMessages.slice(-keep);
      saveCoworkMessages();
      renderCoworkChat();
    }
    addCoworkMessage("system", `Compacted chat history to last ${Math.min(keep, state.coworkMessages.length)} messages.`);
    return true;
  }

  if (command === "/watch") {
    const sourceId = ($("watch-source-select")?.value || "").trim() || "embedded-browser";
    const fps = toInt($("watch-fps")?.value, 2);
    const candidateTask = (state.tasks || []).find((task) => ["running", "queued", "waiting_approval"].includes(task.status))
      || (state.tasks || [])[0];
    if (!candidateTask?.id) {
      addCoworkMessage("system", "No task available to watch.");
      return true;
    }
    await startWatchSessionFlow({
      sourceId,
      taskId: candidateTask.id,
      fps,
      outputId: "watch-output",
    });
    addCoworkMessage("agent", `Watching task ${candidateTask.id} on ${sourceId}.`);
    return true;
  }

  if (command === "/think" || command === "/usage" || command === "/model" || command === "/verbose" || command === "/restart") {
    addCoworkMessage("system", `${command} is not wired in dashboard mode yet. Use provider and autonomy controls in this panel.`);
    return true;
  }

  addCoworkMessage("system", `Unknown command: ${command}. Try /help.`);
  return true;
};

const runMissionTemplate = async (missionId) => {
  const prompt = ($("cowork-mission-prompt")?.value || "").trim();
  const query = ($("cowork-mission-query")?.value || "").trim();
  const result = await apiPost(`/api/cowork/missions/${encodeURIComponent(missionId)}/run`, {
    prompt: prompt || undefined,
    query: query || undefined,
    startTask: true,
  });
  if ($("task-id") && result?.task?.id) {
    $("task-id").value = result.task.id;
  }
  if ($("cowork-log-task-select") && result?.task?.id) {
    $("cowork-log-task-select").value = result.task.id;
  }
  setText("cowork-output", result);
  await refreshTasks();
  await refreshCoworkState();
  await refreshTaskLogTail();
  return result;
};

const getGlobalArgs = () => {
  const browser = $("cfg-browser")?.value || "chrome";
  const compatProvider = $("cfg-compat")?.value || "none";
  const chromeProfile = ($("cfg-profile")?.value || "").trim();
  const chromeProfileName = ($("cfg-profile-name")?.value || "").trim();
  const notifyWebhook = ($("cfg-webhook")?.value || "").trim();
  const visible = Boolean($("cfg-visible")?.checked);
  const notify = Boolean($("cfg-notify")?.checked);

  const globalArgs = {
    browser,
    compatProvider,
  };
  if (chromeProfile) {
    globalArgs.chromeProfile = chromeProfile;
  }
  if (chromeProfileName) {
    globalArgs.chromeProfileName = chromeProfileName;
  }
  if (notifyWebhook) {
    globalArgs.notifyWebhook = notifyWebhook;
  }
  if (visible) {
    globalArgs.visible = true;
  }
  if (notify) {
    globalArgs.notify = true;
  }
  return globalArgs;
};

const setOnboardingVisibility = (showOnboarding) => {
  $("onboarding-root")?.classList.toggle("hidden", !showOnboarding);
  $("dashboard-root")?.classList.toggle("hidden", showOnboarding);
  document.body.classList.toggle("dashboard-visible", !showOnboarding);
  document.body.classList.toggle("onboarding-visible", Boolean(showOnboarding));
  if (!showOnboarding) {
    initBlueprintShell();
  }
};

const updatePordieScopeHint = () => {
  const scope = $("onb-pordie-scope")?.value || "global";
  const node = $("onb-pordie-target");
  if (!node) {
    return;
  }
  node.textContent = scope === "project" ? "- scope: project (./.pordie)" : "- scope: global (~/.pordie)";
};

const getSelectedEndpoint = () => {
  const value = $("endpoint-select")?.value || "";
  return state.catalog.find((entry) => entry.endpoint === value) || null;
};

const renderEndpointOptions = () => {
  const select = $("endpoint-select");
  if (!select) {
    return;
  }

  const filter = ($("endpoint-filter")?.value || "").trim().toLowerCase();
  const prev = select.value;
  select.innerHTML = "";

  const filtered = state.catalog.filter((entry) => {
    if (!filter) {
      return true;
    }
    return (
      entry.endpoint.toLowerCase().includes(filter) ||
      entry.summary.toLowerCase().includes(filter) ||
      entry.category.toLowerCase().includes(filter)
    );
  });

  filtered.forEach((entry) => {
    const option = document.createElement("option");
    option.value = entry.endpoint;
    option.textContent = `${entry.endpoint}  [${entry.category}]`;
    select.appendChild(option);
  });

  if (!filtered.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No matching endpoints";
    select.appendChild(option);
  }

  if (filtered.some((entry) => entry.endpoint === prev)) {
    select.value = prev;
  }

  renderEndpointArgs();
};

const renderEndpointArgs = () => {
  const endpoint = getSelectedEndpoint();
  const argsNode = $("endpoint-args");
  const summaryNode = $("endpoint-summary");
  if (!argsNode || !summaryNode) {
    return;
  }
  argsNode.innerHTML = "";

  if (!endpoint) {
    summaryNode.textContent = "Choose an endpoint.";
    return;
  }

  summaryNode.textContent = endpoint.summary;

  if (!endpoint.args.length) {
    const hint = document.createElement("p");
    hint.className = "summary";
    hint.textContent = "No arguments required.";
    argsNode.appendChild(hint);
    return;
  }

  endpoint.args.forEach((arg) => {
    const row = document.createElement("div");
    row.className = `arg-row ${arg.type === "boolean" ? "bool" : ""}`;

    if (arg.type === "boolean") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = Boolean(arg.defaultValue);
      input.dataset.argKey = arg.key;
      input.dataset.argType = arg.type;
      input.dataset.argRequired = String(Boolean(arg.required));
      row.appendChild(input);

      const label = document.createElement("label");
      label.textContent = `${arg.label}${arg.required ? " *" : ""}`;
      row.appendChild(label);
      argsNode.appendChild(row);
      return;
    }

    const label = document.createElement("label");
    label.textContent = `${arg.label}${arg.required ? " *" : ""}`;
    row.appendChild(label);

    const input = document.createElement("input");
    input.type = arg.type === "number" ? "number" : "text";
    if (arg.placeholder) {
      input.placeholder = arg.placeholder;
    }
    if (arg.defaultValue !== undefined) {
      input.value = String(arg.defaultValue);
    }
    input.dataset.argKey = arg.key;
    input.dataset.argType = arg.type;
    input.dataset.argRequired = String(Boolean(arg.required));
    row.appendChild(input);

    argsNode.appendChild(row);
  });
};

const collectEndpointArgs = () => {
  const args = {};
  const inputNodes = [...document.querySelectorAll("#endpoint-args [data-arg-key]")];
  for (const node of inputNodes) {
    const key = node.dataset.argKey;
    const type = node.dataset.argType;
    const required = node.dataset.argRequired === "true";
    if (!key || !type) {
      continue;
    }
    if (type === "boolean") {
      if (node.checked) {
        args[key] = true;
      } else if (required) {
        args[key] = false;
      }
      continue;
    }
    const raw = String(node.value || "").trim();
    if (!raw) {
      if (required) {
        throw new Error(`${key} is required.`);
      }
      continue;
    }
    if (type === "number") {
      const numeric = Number(raw);
      if (!Number.isFinite(numeric)) {
        throw new Error(`${key} must be a number.`);
      }
      args[key] = numeric;
      continue;
    }
    args[key] = raw;
  }
  return args;
};

const runEndpoint = async (endpoint, args, outputId) => {
  const result = await apiPost("/api/x/run", {
    endpoint,
    args,
    globalArgs: getGlobalArgs(),
  });
  setText(outputId, result);
  logActivity(`Endpoint executed: ${endpoint}`, result);
  recordHistory({ endpoint, args, ok: Boolean(result.ok) });
  return result;
};

const runWorkflow = async (workflow, outputId) => {
  const payload = {
    stopOnError: workflow.stopOnError !== false,
    steps: Array.isArray(workflow.steps) ? workflow.steps : [],
    globalArgs: getGlobalArgs(),
  };
  const result = await apiPost("/api/x/workflow", payload);
  setText(outputId, result);
  logActivity("Workflow executed", result);
  return result;
};

const runSuggestedQueryWorkflow = async (query, reason = "manual") => {
  const normalized = String(query || "").trim();
  if (!normalized) {
    throw new Error("query is required");
  }
  const workflow = suggestedQueryWorkflow(normalized);
  if ($("workflow-json")) {
    $("workflow-json").value = toJSON(workflow);
  }
  setText("quick-output", "Running suggested query workflow...");
  const result = await runWorkflow(workflow, "quick-output");
  setText("workflow-output", result);
  logActivity("Suggested query workflow executed", {
    query: normalized,
    reason,
    steps: workflow.steps.length,
    ok: Boolean(result?.ok),
  });
  return result;
};

const refreshHeartbeat = async () => {
  const result = await apiGet("/api/heartbeat/status");
  setText("heartbeat-output", result);
  return result;
};

const formatWorkflowEditor = () => {
  const node = $("workflow-json");
  if (!node) {
    return;
  }
  node.value = toJSON(JSON.parse(node.value || "{}"));
};

const quickSessionWorkflow = () => ({
  stopOnError: true,
  steps: [
    { endpoint: "get_my_x_account_detail_v3", args: {}, waitMs: 0 },
    { endpoint: "trends", args: { limit: 10 }, waitMs: 400 },
    { endpoint: "stream_status", args: {}, waitMs: 0 },
  ],
});

const quickDiscoveryWorkflow = (keyword) => ({
  stopOnError: true,
  steps: [
    { endpoint: "user_search", args: { keyword, limit: 20 }, waitMs: 0 },
    { endpoint: "tweet_advanced_search", args: { query: keyword, tab: "latest", limit: 20 }, waitMs: 450 },
    { endpoint: "spaces_live", args: { limit: 12 }, waitMs: 0 },
  ],
});

const quickTrendScanWorkflow = (query) => ({
  stopOnError: true,
  steps: [
    { endpoint: "trends", args: { limit: 20 }, waitMs: 0 },
    { endpoint: "tweet_advanced_search", args: { query, tab: "latest", limit: 25 }, waitMs: 400 },
    { endpoint: "stream_live_search", args: { query, duration: 20, interval: 5, maxEvents: 25 }, waitMs: 0 },
  ],
});

const suggestedQueryWorkflow = (query) => ({
  stopOnError: true,
  steps: [
    { endpoint: "tweet_advanced_search", args: { query, tab: "latest", limit: 30 }, waitMs: 0 },
    { endpoint: "stream_live_search", args: { query, duration: 30, interval: 5, maxEvents: 40 }, waitMs: 350 },
    { endpoint: "trends", args: { limit: 20 }, waitMs: 0 },
  ],
});

const getXAlgoSuggestedQueries = () => {
  const queries = state.latestXAlgo?.retrieval?.recommendedQueries;
  if (!Array.isArray(queries)) {
    return [];
  }
  return queries.map((item) => String(item || "").trim()).filter(Boolean);
};

const populateXAlgoQuerySelect = () => {
  const select = $("x-algo-query-select");
  if (!select) {
    return;
  }
  const previous = select.value;
  const queries = getXAlgoSuggestedQueries();
  select.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = queries.length ? "Select suggested query" : "Run X Algorithm Intel first";
  select.appendChild(placeholder);

  queries.forEach((query) => {
    const option = document.createElement("option");
    option.value = query;
    option.textContent = query;
    select.appendChild(option);
  });

  if (previous && queries.includes(previous)) {
    select.value = previous;
  } else if (queries[0]) {
    select.value = queries[0];
  } else {
    select.value = "";
  }
};

const populateModelSelect = (id, options, selectedValue) => {
  const select = $(id);
  if (!select) {
    return;
  }
  const modelMap = new Map((state.modelCache?.models || []).map((model) => [model.id, model]));
  const prev = selectedValue ?? select.value;
  select.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "<none>";
  select.appendChild(none);
  options.forEach((modelId) => {
    const model = modelMap.get(modelId);
    const inMods = Array.isArray(model?.inputModalities) ? model.inputModalities : [];
    const outMods = Array.isArray(model?.outputModalities) ? model.outputModalities : [];
    const modalityText = [...new Set([...inMods, ...outMods])].filter(Boolean).join(",");
    const option = document.createElement("option");
    option.value = modelId;
    option.textContent = `${model?.name ? `${model.name}  |  ` : ""}${modelId}${modalityText ? `  [${modalityText}]` : ""}`;
    select.appendChild(option);
  });
  if (prev && options.includes(prev)) {
    select.value = prev;
  } else {
    select.value = "";
  }
};

const populateOnboardingModelSelectors = () => {
  const cache = state.modelCache;
  const groups = cache?.groups || { text: [], image: [], video: [], embedding: [], voice: [] };
  const defaults = state.onboarding?.openrouter?.defaults || {};
  const fallbacks = state.onboarding?.openrouter?.fallbacks || {};

  populateModelSelect("onb-model-text-small", groups.text, defaults.textSmall || cache?.recommendations?.textSmall);
  populateModelSelect("onb-model-text-large", groups.text, defaults.textLarge || cache?.recommendations?.textLarge);
  populateModelSelect("onb-model-text-fallback", groups.text, fallbacks.textFallback || "");
  populateModelSelect("onb-model-image-primary", groups.image, defaults.imagePrimary || cache?.recommendations?.imagePrimary);
  populateModelSelect("onb-model-image-fallback", groups.image, fallbacks.imageFallback || "");
  populateModelSelect("onb-model-video-primary", groups.video, defaults.videoPrimary || cache?.recommendations?.videoPrimary);
  populateModelSelect("onb-model-video-fallback", groups.video, fallbacks.videoFallback || "");
  populateModelSelect(
    "onb-model-embedding-primary",
    groups.embedding,
    defaults.embeddingPrimary || cache?.recommendations?.embeddingPrimary,
  );
  populateModelSelect("onb-model-embedding-fallback", groups.embedding, fallbacks.embeddingFallback || "");
  populateModelSelect("onb-model-voice-primary", groups.voice, defaults.voicePrimary || cache?.recommendations?.voicePrimary);
  populateModelSelect("onb-model-voice-fallback", groups.voice, fallbacks.voiceFallback || "");
  populateDashboardModelSelectors();
};

const populateDashboardModelSelectors = () => {
  const cache = state.modelCache;
  const groups = cache?.groups || { text: [], image: [], video: [], embedding: [], voice: [] };

  populateModelSelect(
    "ai-model-select",
    groups.text,
    $("ai-model")?.value || cache?.recommendations?.textLarge || cache?.recommendations?.textSmall,
  );
  populateModelSelect(
    "plan-model-select",
    groups.text,
    $("plan-model")?.value || cache?.recommendations?.textLarge || cache?.recommendations?.textSmall,
  );
  populateModelSelect(
    "ai-image-model-select",
    groups.image,
    $("ai-image-model")?.value || state.onboarding?.openrouter?.defaults?.imagePrimary || cache?.recommendations?.imagePrimary,
  );
  populateModelSelect(
    "ai-video-model-select",
    groups.video,
    $("ai-video-model")?.value || state.onboarding?.openrouter?.defaults?.videoPrimary || cache?.recommendations?.videoPrimary,
  );

  if ($("ai-model") && !$("ai-model").value && $("ai-model-select")?.value) {
    $("ai-model").value = $("ai-model-select").value;
  }
  if ($("plan-model") && !$("plan-model").value && $("plan-model-select")?.value) {
    $("plan-model").value = $("plan-model-select").value;
  }
  if ($("ai-image-model") && !$("ai-image-model").value && $("ai-image-model-select")?.value) {
    $("ai-image-model").value = $("ai-image-model-select").value;
  }
  if ($("ai-video-model") && !$("ai-video-model").value && $("ai-video-model-select")?.value) {
    $("ai-video-model").value = $("ai-video-model-select").value;
  }

  setText("model-lanes-output", {
    fetchedAt: cache?.fetchedAt || null,
    totalCount: cache?.totalCount || 0,
    groupCounts: {
      text: groups.text.length,
      image: groups.image.length,
      video: groups.video.length,
      embedding: groups.embedding.length,
      voice: groups.voice.length,
    },
    recommendations: cache?.recommendations || {},
  });
};

const fillOnboardingForm = () => {
  const onboarding = state.onboarding;
  if (!onboarding) {
    return;
  }
  state.derivedPersona = onboarding.persona
    ? {
        characterPrompt: onboarding.persona.characterPrompt || "",
        stylePrompt: onboarding.persona.stylePrompt || "",
        voiceStyle: onboarding.persona.voiceStyle || "",
        postExamples: Array.isArray(onboarding.persona.postExamples) ? onboarding.persona.postExamples : [],
      }
    : state.derivedPersona;
  if ($("onb-api-key")) {
    $("onb-api-key").value = onboarding.openrouter?.apiKey || "";
  }
  if ($("onb-save-key")) {
    $("onb-save-key").checked = Boolean(onboarding.openrouter?.saveApiKeyLocally);
  }
  if ($("onb-provider-mode")) {
    $("onb-provider-mode").value = onboarding.providers?.mode || "openrouter";
  }
  if ($("onb-x-username")) {
    $("onb-x-username").value = onboarding.x?.username || "";
  }
  if ($("onb-x-email")) {
    $("onb-x-email").value = onboarding.x?.email || "";
  }
  if ($("onb-save-x-password")) {
    $("onb-save-x-password").checked = Boolean(onboarding.x?.savePasswordLocally);
  }
  if ($("onb-x-extension-enabled")) {
    $("onb-x-extension-enabled").checked = Boolean(onboarding.extensions?.x?.enabled);
  }
  if ($("onb-x-extension-mode")) {
    $("onb-x-extension-mode").value = onboarding.extensions?.x?.mode || "manual";
  }
  if ($("onb-x-approval-write")) {
    $("onb-x-approval-write").checked = Boolean(onboarding.extensions?.x?.approvalRequiredForWrite);
  }
  if ($("onb-style-prompt")) {
    $("onb-style-prompt").value = onboarding.persona?.stylePrompt || "";
  }
  if ($("onb-voice-style")) {
    $("onb-voice-style").value = onboarding.persona?.voiceStyle || "";
  }
  if ($("onb-derive-mode")) {
    $("onb-derive-mode").value = onboarding.persona?.deriveMode || "manual";
  }
  if ($("onb-source-value")) {
    $("onb-source-value").value = onboarding.persona?.sourceValue || "";
  }
  if ($("onb-auto-derive")) {
    $("onb-auto-derive").checked = Boolean(onboarding.persona?.autoDeriveFromProfile);
  }
  if ($("onb-pordie-enabled")) {
    $("onb-pordie-enabled").checked = Boolean(onboarding.pordie?.enabled);
  }
  if ($("onb-pordie-scope")) {
    $("onb-pordie-scope").value = onboarding.pordie?.scope || "global";
  }
  if ($("onb-pordie-auto-export")) {
    $("onb-pordie-auto-export").checked = Boolean(onboarding.pordie?.autoExportOnComplete);
  }
  if ($("onb-pordie-sync-env")) {
    $("onb-pordie-sync-env").checked = Boolean(onboarding.pordie?.syncProjectEnv);
  }
  if ($("onb-autonomy-enabled")) {
    $("onb-autonomy-enabled").checked = Boolean(onboarding.autonomy?.enabled);
  }
  if ($("onb-autonomy-policy")) {
    $("onb-autonomy-policy").value = onboarding.autonomy?.policy || "mixed_auto";
  }
  if ($("onb-autonomy-max-actions")) {
    $("onb-autonomy-max-actions").value = String(onboarding.autonomy?.maxActionsPerCycle || 8);
  }
  if ($("onb-autonomy-approval-ttl")) {
    $("onb-autonomy-approval-ttl").value = String(onboarding.autonomy?.approvalTTLMinutes || 30);
  }
  const allowlist = Array.isArray(onboarding.macControl?.appAllowlist) ? onboarding.macControl.appAllowlist : [];
  if ($("onb-app-antigravity")) {
    $("onb-app-antigravity").checked = allowlist.includes("antigravity");
  }
  if ($("onb-app-chrome")) {
    $("onb-app-chrome").checked = allowlist.includes("chrome");
  }
  const requireApprovalFor = Array.isArray(onboarding.macControl?.requireApprovalFor)
    ? onboarding.macControl.requireApprovalFor
    : [];
  if ($("onb-approval-app-launch")) {
    $("onb-approval-app-launch").checked = requireApprovalFor.includes("app_launch");
  }
  if ($("onb-approval-browser-external")) {
    $("onb-approval-browser-external").checked = requireApprovalFor.includes("browser_external");
  }
  if ($("onb-approval-write-command")) {
    $("onb-approval-write-command").checked = requireApprovalFor.includes("write_command");
  }
  if ($("onb-watch-enabled")) {
    $("onb-watch-enabled").checked = Boolean(onboarding.watch?.enabled);
  }
  if ($("onb-watch-fps")) {
    $("onb-watch-fps").value = String(onboarding.watch?.fps || 2);
  }
  if ($("onb-watch-scope")) {
    $("onb-watch-scope").value = onboarding.watch?.captureScope || "agent_surfaces_only";
  }
  if ($("watch-fps")) {
    $("watch-fps").value = String(onboarding.watch?.fps || 2);
  }
  updatePordieScopeHint();
  populateOnboardingModelSelectors();
};

const collectOnboardingPayload = () => {
  const derived = state.derivedPersona || {};
  const existingOnboarding = state.onboarding || {};
  const preservedCodeExtension = existingOnboarding.extensions?.code || {};
  const existingAllowlist = Array.isArray(existingOnboarding.macControl?.appAllowlist)
    ? existingOnboarding.macControl.appAllowlist
    : [];
  const existingRequireApprovalFor = Array.isArray(existingOnboarding.macControl?.requireApprovalFor)
    ? existingOnboarding.macControl.requireApprovalFor
    : [];
  const derivedExamples = Array.isArray(derived.postExamples)
    ? derived.postExamples.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 20)
    : [];
  const visibleAllowlist = [
    $("onb-app-antigravity")?.checked ? "antigravity" : null,
    $("onb-app-chrome")?.checked ? "chrome" : null,
  ].filter(Boolean);
  const preservedAllowlist = existingAllowlist.filter((entry) => entry === "terminal");
  const visibleRequireApprovalFor = [
    $("onb-approval-app-launch")?.checked ? "app_launch" : null,
    $("onb-approval-browser-external")?.checked ? "browser_external" : null,
    $("onb-approval-write-command")?.checked ? "write_command" : null,
  ].filter(Boolean);
  const preservedRequireApprovalFor = existingRequireApprovalFor.filter(
    (entry) => entry === "terminal_exec" || entry === "codex_exec",
  );
  return {
    providers: {
      mode: $("onb-provider-mode")?.value || "openrouter",
    },
    openrouter: {
      saveApiKeyLocally: Boolean($("onb-save-key")?.checked),
      apiKey: ($("onb-save-key")?.checked ? $("onb-api-key")?.value?.trim() : "") || undefined,
      defaults: {
        textSmall: $("onb-model-text-small")?.value || undefined,
        textLarge: $("onb-model-text-large")?.value || undefined,
        imagePrimary: $("onb-model-image-primary")?.value || undefined,
        videoPrimary: $("onb-model-video-primary")?.value || undefined,
        embeddingPrimary: $("onb-model-embedding-primary")?.value || undefined,
        voicePrimary: $("onb-model-voice-primary")?.value || undefined,
      },
      fallbacks: {
        textFallback: $("onb-model-text-fallback")?.value || undefined,
        imageFallback: $("onb-model-image-fallback")?.value || undefined,
        videoFallback: $("onb-model-video-fallback")?.value || undefined,
        embeddingFallback: $("onb-model-embedding-fallback")?.value || undefined,
        voiceFallback: $("onb-model-voice-fallback")?.value || undefined,
      },
    },
    extensions: {
      x: {
        enabled: Boolean($("onb-x-extension-enabled")?.checked),
        mode: $("onb-x-extension-mode")?.value || "manual",
        approvalRequiredForWrite: Boolean($("onb-x-approval-write")?.checked),
      },
      code: {
        enabled: Boolean(preservedCodeExtension.enabled),
        mode: preservedCodeExtension.mode || "manual",
        approvalRequiredForWrite: Boolean(preservedCodeExtension.approvalRequiredForWrite),
        allowReadOnlyAutonomy: Boolean(preservedCodeExtension.allowReadOnlyAutonomy),
        workingDirectory: preservedCodeExtension.workingDirectory || undefined,
      },
    },
    x: {
      username: $("onb-x-username")?.value?.trim() || undefined,
      email: $("onb-x-email")?.value?.trim() || undefined,
      savePasswordLocally: Boolean($("onb-save-x-password")?.checked),
      password: $("onb-save-x-password")?.checked ? $("onb-x-password")?.value || undefined : undefined,
    },
    persona: {
      stylePrompt: $("onb-style-prompt")?.value?.trim() || undefined,
      voiceStyle: $("onb-voice-style")?.value?.trim() || undefined,
      deriveMode: $("onb-derive-mode")?.value || "manual",
      sourceValue: $("onb-source-value")?.value?.trim() || undefined,
      autoDeriveFromProfile: Boolean($("onb-auto-derive")?.checked),
      characterPrompt: (derived.characterPrompt || "").trim() || undefined,
      postExamples: derivedExamples.length ? derivedExamples : undefined,
    },
    pordie: {
      enabled: Boolean($("onb-pordie-enabled")?.checked),
      scope: $("onb-pordie-scope")?.value || "global",
      autoExportOnComplete: Boolean($("onb-pordie-auto-export")?.checked),
      syncProjectEnv: Boolean($("onb-pordie-sync-env")?.checked),
    },
    autonomy: {
      enabled: Boolean($("onb-autonomy-enabled")?.checked),
      policy: $("onb-autonomy-policy")?.value || "mixed_auto",
      maxActionsPerCycle: toInt($("onb-autonomy-max-actions")?.value, 8),
      approvalTTLMinutes: toInt($("onb-autonomy-approval-ttl")?.value, 30),
    },
    macControl: {
      appAllowlist: [...new Set([...visibleAllowlist, ...preservedAllowlist])],
      requireApprovalFor: [...new Set([...visibleRequireApprovalFor, ...preservedRequireApprovalFor])],
    },
    watch: {
      enabled: Boolean($("onb-watch-enabled")?.checked),
      mode: "screenshare",
      fps: toInt($("onb-watch-fps")?.value, 2),
      captureScope: "agent_surfaces_only",
    },
  };
};

const collectLocalImportPayload = () => {
  return {
    allowLocalSecretsRead: Boolean($("onb-import-allow")?.checked),
    includeProcessEnv: Boolean($("onb-import-env")?.checked),
    includeHomeDefaults: Boolean($("onb-import-home")?.checked),
    includeShellProfiles: Boolean($("onb-import-shell")?.checked),
    includeClaudeAuth: Boolean($("onb-import-claude")?.checked),
    overrideExisting: Boolean($("onb-import-override")?.checked),
    additionalPaths: splitPathInput($("onb-import-paths")?.value || ""),
    exportEnv: Boolean($("onb-import-export")?.checked),
    syncProjectEnv: Boolean($("onb-pordie-sync-env")?.checked),
  };
};

const refreshOnboardingState = async () => {
  const data = await apiGet("/api/onboarding/state");
  state.onboarding = data.onboarding || null;
  state.modelCache = data.modelCache || null;
  fillOnboardingForm();
  const completed = Boolean(state.onboarding?.completed);
  setOnboardingVisibility(!completed);
  $("onboarding-chip").textContent = completed ? "Onboarding: complete" : "Onboarding: required";
};

const refreshHealth = async () => {
  const data = await apiGet("/api/health");
  $("health-chip").textContent = data.ok ? "API: online" : "API: offline";
  $("onboarding-chip").textContent = data.onboardingCompleted ? "Onboarding: complete" : "Onboarding: required";
  logActivity("Health check", data);
};

const loadCatalog = async () => {
  const data = await apiGet("/api/x/catalog");
  state.catalog = Array.isArray(data.endpoints) ? data.endpoints : [];
  renderEndpointOptions();
  logActivity(`Loaded endpoint catalog (${state.catalog.length})`);
};

const bindOnboardingEvents = () => {
  $("onb-pordie-scope")?.addEventListener("change", updatePordieScopeHint);

  $("onb-test-key")?.addEventListener("click", async () => {
    try {
      setText("onb-key-output", "Testing...");
      const apiKey = ($("onb-api-key")?.value || "").trim();
      const result = await apiPost("/api/onboarding/test-openrouter-key", {
        apiKey: apiKey || undefined,
      });
      setText("onb-key-output", result);
      logActivity("OpenRouter key test", result);
    } catch (error) {
      setText("onb-key-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("onb-refresh-models")?.addEventListener("click", async () => {
    try {
      setText("onb-key-output", "Refreshing model cache...");
      const apiKey = ($("onb-api-key")?.value || "").trim();
      const result = await apiPost("/api/onboarding/refresh-model-cache", {
        apiKey: apiKey || undefined,
      });
      state.modelCache = result.cache || null;
      populateOnboardingModelSelectors();
      setText("onb-key-output", {
        ok: true,
        fetchedAt: result?.cache?.fetchedAt || null,
        totalCount: result?.cache?.totalCount || 0,
        recommendations: result?.cache?.recommendations || {},
        groupCounts: {
          text: result?.cache?.groups?.text?.length || 0,
          image: result?.cache?.groups?.image?.length || 0,
          video: result?.cache?.groups?.video?.length || 0,
          embedding: result?.cache?.groups?.embedding?.length || 0,
          voice: result?.cache?.groups?.voice?.length || 0,
        },
      });
      logActivity("Model cache refreshed", {
        fetchedAt: result?.cache?.fetchedAt,
        totalCount: result?.cache?.totalCount,
      });
    } catch (error) {
      setText("onb-key-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("onb-claude-login-start")?.addEventListener("click", async () => {
    try {
      setText("onb-claude-output", "Preparing CLI login instructions...");
      const result = await apiPost("/api/claude/login/start", {});
      setText("onb-claude-output", result);
      logActivity("Claude CLI login start", result);
    } catch (error) {
      setText("onb-claude-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("onb-claude-check")?.addEventListener("click", async () => {
    try {
      setText("onb-claude-output", "Checking session...");
      const result = await apiGet("/api/claude/login/status");
      setText("onb-claude-output", result);
      await refreshProviderStatus();
      logActivity("Claude session check", result);
    } catch (error) {
      setText("onb-claude-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("onb-test-x-login")?.addEventListener("click", async () => {
    try {
      setText("onb-x-output", "Testing X session/login...");
      const username = ($("onb-x-username")?.value || "").trim();
      const password = $("onb-x-password")?.value || "";
      const email = ($("onb-x-email")?.value || "").trim();
      const result = await apiPost("/api/onboarding/test-x-login", {
        username,
        password,
        email: email || undefined,
        globalArgs: getGlobalArgs(),
      });
      setText("onb-x-output", result);
      logActivity("X login test", result);
    } catch (error) {
      setText("onb-x-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("onb-derive-persona")?.addEventListener("click", async () => {
    try {
      setText("onb-persona-output", "Deriving persona...");
      const result = await apiPost("/api/persona/derive", {
        sourceType: $("onb-derive-mode")?.value || "manual",
        sourceValue: $("onb-source-value")?.value || "",
        styleHint: $("onb-style-prompt")?.value || "",
        globalArgs: getGlobalArgs(),
      });
      if ($("onb-persona-output")) {
        $("onb-persona-output").textContent = toJSON(result);
      }
      if (result?.persona && typeof result.persona === "object") {
        state.derivedPersona = result.persona;
      }
      if (result?.persona?.stylePrompt && $("onb-style-prompt")) {
        $("onb-style-prompt").value = result.persona.stylePrompt;
      } else if (result?.persona?.characterPrompt && $("onb-style-prompt")) {
        $("onb-style-prompt").value = result.persona.characterPrompt;
      }
      if (result?.persona?.voiceStyle && $("onb-voice-style")) {
        $("onb-voice-style").value = result.persona.voiceStyle;
      }
      if (result?.resolvedHandle && $("onb-source-value")) {
        $("onb-source-value").value = result.resolvedHandle;
      }
      logActivity("Persona derivation", result);
    } catch (error) {
      setText("onb-persona-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("onb-import-local")?.addEventListener("click", async () => {
    try {
      setText("onb-import-output", "Importing local secrets...");
      const result = await apiPost("/api/onboarding/import-local-secrets", collectLocalImportPayload());
      state.onboarding = result.onboarding || state.onboarding;
      fillOnboardingForm();
      setText("onb-import-output", result.import || result);
      if (result.exported) {
        setText("onb-pordie-output", result.exported);
      }
      logActivity("Local secret import", result.import || result);
    } catch (error) {
      setText("onb-import-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("onb-save-draft")?.addEventListener("click", async () => {
    try {
      const payload = collectOnboardingPayload();
      const result = await apiPost("/api/onboarding/save", payload);
      state.onboarding = result.onboarding || state.onboarding;
      setText("onb-persona-output", result);
      await refreshProviderStatus();
      await refreshExtensions();
      await refreshAutonomy();
      logActivity("Onboarding draft saved", result);
    } catch (error) {
      setText("onb-persona-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("onb-export-now")?.addEventListener("click", async () => {
    try {
      setText("onb-pordie-output", "Saving onboarding draft...");
      const payload = collectOnboardingPayload();
      const saveResult = await apiPost("/api/onboarding/save", payload);
      state.onboarding = saveResult.onboarding || state.onboarding;
      fillOnboardingForm();

      setText("onb-pordie-output", "Exporting Prompt or Die env...");
      const exportResult = await apiPost("/api/onboarding/export-env", {
        syncProjectEnv: Boolean($("onb-pordie-sync-env")?.checked),
      });
      setText("onb-pordie-output", exportResult);
      logActivity("Prompt or Die env export", exportResult);
    } catch (error) {
      setText("onb-pordie-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("onboarding-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const payload = collectOnboardingPayload();
      const result = await apiPost("/api/onboarding/complete", {
        ...payload,
        exportEnv: Boolean($("onb-pordie-auto-export")?.checked),
      });
      state.onboarding = result.onboarding || state.onboarding;
      fillOnboardingForm();
      setOnboardingVisibility(false);
      $("onboarding-chip").textContent = "Onboarding: complete";
      setText("onb-persona-output", result);
      if (result.exported) {
        setText("onb-pordie-output", result.exported);
      }
      await refreshProviderStatus();
      await refreshExtensions();
      await refreshAutonomy();
      await refreshApprovals();
      await refreshSkills();
      await refreshTasks();
      await refreshMacApps();
      logActivity("Onboarding completed", result);
    } catch (error) {
      setText("onb-persona-output", error instanceof Error ? error.message : String(error));
    }
  });
};

const bindDashboardEvents = () => {
  $("refresh-health-btn")?.addEventListener("click", async () => {
    await refreshHealth();
  });

  $("open-onboarding-btn")?.addEventListener("click", () => {
    setOnboardingVisibility(true);
  });

  $("context-send-btn")?.addEventListener("click", () => {
    openContextPicker(contextPayloadFromSelection("toolbar-send-context"));
  });

  $("utility-rail-toggle")?.addEventListener("click", () => {
    state.utilityRail = {
      ...state.utilityRail,
      collapsed: !state.utilityRail.collapsed,
    };
    writeUtilityRailState();
    syncUtilityRailState();
  });

  $("utility-source-use-selection")?.addEventListener("click", () => {
    const selection = contextPayloadFromSelection("utility-rail-selection");
    const text = resolveContextText(selection);
    if (!text) {
      setContextFeedback("No active selection to send.");
      return;
    }
    setUtilityRailSourceText(text);
    setContextFeedback("Loaded current selection into utility rail.");
  });

  $("utility-source-use-latest")?.addEventListener("click", () => {
    const latest = state.contextInbox[0]?.text || "";
    if (!latest) {
      setContextFeedback("No captured context available yet.");
      return;
    }
    setUtilityRailSourceText(latest);
    setContextFeedback("Loaded latest inbox context into utility rail.");
  });

  $("context-inbox-list")?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const action = String(target.dataset.contextAction || "").trim();
    const itemId = String(target.dataset.contextItemId || "").trim();
    if (!action || !itemId) {
      return;
    }
    const item = state.contextInbox.find((entry) => entry.id === itemId);
    if (!item) {
      return;
    }
    if (action === "dispatch") {
      const contextTarget = String(target.dataset.contextTarget || "").trim();
      const actionId = contextTargetToActionId(contextTarget);
      const result = contextActionRouter({
        actionId,
        context: normalizeContextSourcePayload({
          selectionText: item.text,
          pageURL: window.location.href,
          sourceHint: `context-inbox:${item.id}`,
        }),
      });
      if (result.ok) {
        markContextInboxItemConsumed(item.id, contextTarget || "composer");
      }
      return;
    }
    if (action === "save-tags") {
      const input = document.querySelector(`[data-context-tag-input="${itemId}"]`);
      if (input instanceof HTMLInputElement) {
        saveContextTags(itemId, input.value || "");
        setContextFeedback(`Updated tags for ${item.source || "context"}.`);
      }
      return;
    }
    if (action === "pin-toggle") {
      togglePinnedContextInboxItem(itemId);
      return;
    }
    if (action === "remove") {
      removeContextInboxItem(itemId);
    }
  });

  const runUtilityPrefill = (actionId, sourceHint) => {
    const sourceText = getUtilityRailSourceText();
    if (!sourceText) {
      setContextFeedback("Add or capture context first.");
      return;
    }
    contextActionRouter({
      actionId,
      context: normalizeContextSourcePayload({
        selectionText: sourceText,
        pageURL: window.location.href,
        sourceHint,
      }),
    });
  };

  document.querySelectorAll("[data-context-transform]").forEach((node) => {
    node.addEventListener("click", () => {
      const transform = String(node.getAttribute("data-context-transform") || "").trim();
      const sourceText = getUtilityRailSourceText();
      if (!sourceText) {
        setContextFeedback("Add or capture context first.");
        return;
      }
      const transformed = contextTransformText(transform, sourceText);
      if (!transformed) {
        setContextFeedback("Unable to transform empty context.");
        return;
      }
      contextActionRouter({
        actionId: "post.replace_composer",
        context: normalizeContextSourcePayload({
          selectionText: transformed,
          pageURL: window.location.href,
          sourceHint: `utility-transform:${transform}`,
        }),
      });
    });
  });

  $("utility-prefill-planner")?.addEventListener("click", () => {
    runUtilityPrefill("tools.prefill_planner_goal", "utility-prefill-planner");
  });
  $("utility-prefill-mission")?.addEventListener("click", () => {
    runUtilityPrefill("tools.prefill_mission_query", "utility-prefill-mission");
  });
  $("utility-prefill-command")?.addEventListener("click", () => {
    runUtilityPrefill("tools.prefill_command_studio", "utility-prefill-command");
  });
  $("utility-archive-knowledge")?.addEventListener("click", () => {
    runUtilityPrefill("knowledge.capture", "utility-archive");
  });

  $("context-picker-close")?.addEventListener("click", closeContextPicker);
  $("context-picker-cancel")?.addEventListener("click", closeContextPicker);

  $("context-action-picker")?.addEventListener("click", (event) => {
    const target = event.target;
    if (target === $("context-action-picker")) {
      closeContextPicker();
      return;
    }
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const actionId = String(target.dataset.contextPickerAction || "").trim();
    if (!actionId) {
      return;
    }
    const text = ($("context-picker-text")?.value || "").trim();
    const context = normalizeContextSourcePayload({
      selectionText: text,
      pageURL: window.location.href,
      sourceHint: "web-context-picker",
    });
    const result = contextActionRouter({
      actionId,
      context,
    });
    if (result.ok) {
      closeContextPicker();
    }
  });

  document.addEventListener("keydown", (event) => {
    const openShortcut = (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "k";
    if (openShortcut) {
      if (state.desktopCapabilities.nativeContextMenu) {
        return;
      }
      event.preventDefault();
      openContextPicker(contextPayloadFromSelection("keyboard-send-context"));
      return;
    }
    if (event.key === "Escape" && $("context-action-picker")?.classList.contains("open")) {
      closeContextPicker();
    }
  });

  if (window.podDesktop?.onContextAction) {
    window.podDesktop.onContextAction((payload) => {
      contextActionRouter(payload);
    });
  }

  $("dashboard-json-render-generate")?.addEventListener("click", async () => {
    const prompt = ($("dashboard-json-render-prompt")?.value || "").trim();
    try {
      setText("dashboard-json-render-output", "Generating JSON Render dashboard spec...");
      const result = await apiPost("/api/ai/chat", {
        system:
          "You are a dashboard JSON generator. Output strict JSON only with layout + columns + widgets following the requested schema.",
        prompt: buildDashboardJsonRenderPrompt(prompt),
      });
      const raw = result?.data?.text || "";
      const parsed = extractJsonObjectFromText(raw);
      const normalized = normalizeDashboardJsonRenderSpec(parsed);
      if (!normalized) {
        throw new Error("Model returned invalid dashboard JSON. Try a simpler prompt.");
      }
      state.dashboardJsonRenderDraft = normalized;
      renderDashboardJsonRenderStatus();
      logActivity("Dashboard JSON render draft generated", {
        panelCount: Array.isArray(normalized.widgets) ? normalized.widgets.length : normalized.elements.length,
        title: normalized.root?.title || "Generated Dashboard",
      });
    } catch (error) {
      setText("dashboard-json-render-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("dashboard-json-render-apply")?.addEventListener("click", () => {
    const spec = state.dashboardJsonRenderDraft || state.dashboardJsonRenderSpec;
    if (!spec) {
      setText("dashboard-json-render-output", "Generate a dashboard spec first.");
      return;
    }
    applyDashboardJsonRenderSpec(spec);
    window.localStorage.removeItem(DASHBOARD_LAYOUT_KEY);
    window.localStorage.removeItem(DASHBOARD_VIEW_KEY);
    window.location.reload();
  });

  $("dashboard-json-render-clear")?.addEventListener("click", () => {
    state.dashboardJsonRenderDraft = null;
    applyDashboardJsonRenderSpec(null);
    window.localStorage.removeItem(DASHBOARD_LAYOUT_KEY);
    window.localStorage.removeItem(DASHBOARD_VIEW_KEY);
    window.location.reload();
  });

  $("cowork-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const task = ($("cowork-task-input")?.value || "").trim();
    const autoPlan = Boolean($("cowork-auto-plan")?.checked);
    const startTask = Boolean($("cowork-start-task")?.checked);
    if (!task) {
      setText("cowork-output", "task is required");
      return;
    }
    try {
      addCoworkMessage("user", task);
      if (await runCoworkSlashCommand(task)) {
        setText("cowork-output", {
          ok: true,
          mode: "slash_command",
          command: task.split(/\s+/)[0],
        });
        return;
      }
      setText("cowork-output", "Dispatching task...");
      const result = await apiPost("/api/cowork/dispatch", {
        task,
        autoPlan,
        startTask,
      });
      const text = result?.result?.text || "";
      addCoworkMessage("agent", text || "Task complete.");
      if (result?.result?.plan && $("workflow-json")) {
        $("workflow-json").value = toJSON({
          stopOnError: true,
          steps: result.result.plan.steps || [],
        });
      }
      setText("cowork-output", result);
      if ($("task-id") && result?.task?.id) {
        $("task-id").value = result.task.id;
      }
      await refreshTasks();
      logActivity("Cowork task dispatched", {
        task,
        provider: result?.result?.provider,
        hasPlan: Boolean(result?.result?.plan),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addCoworkMessage("system", message);
      setText("cowork-output", message);
    }
  });

  document.querySelectorAll("[data-cowork-command]").forEach((node) => {
    node.addEventListener("click", async () => {
      const command = String(node.getAttribute("data-cowork-command") || "").trimEnd();
      if (!command) {
        return;
      }
      addCoworkMessage("user", command);
      try {
        await runCoworkSlashCommand(command);
      } catch (error) {
        addCoworkMessage("system", error instanceof Error ? error.message : String(error));
      }
    });
  });

  $("cowork-clear-chat")?.addEventListener("click", () => {
    state.coworkMessages = [];
    saveCoworkMessages();
    renderCoworkChat();
    setText("cowork-output", "");
  });

  $("cowork-live-refresh")?.addEventListener("click", () => {
    const iframe = $("cowork-live-iframe");
    if (!iframe) {
      return;
    }
    const current = iframe.getAttribute("src") || "/live.html";
    try {
      const parsed = new URL(current, window.location.origin);
      parsed.searchParams.set("t", `${Date.now()}`);
      iframe.setAttribute("src", `${parsed.pathname}?${parsed.searchParams.toString()}`);
    } catch {
      iframe.setAttribute("src", `/live.html?t=${Date.now()}`);
    }
  });

  $("cowork-watch-active")?.addEventListener("click", async () => {
    const sourceId = ($("watch-source-select")?.value || "").trim() || "embedded-browser";
    const fps = toInt($("watch-fps")?.value, 2);
    const candidateTask = (state.tasks || []).find((task) => ["running", "queued", "waiting_approval"].includes(task.status))
      || (state.tasks || [])[0];
    if (!candidateTask?.id) {
      setText("watch-output", "No task available to watch.");
      return;
    }
    try {
      await startWatchSessionFlow({
        sourceId,
        taskId: candidateTask.id,
        fps,
        outputId: "watch-output",
      });
    } catch (error) {
      setText("watch-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("cowork-watch-token")?.addEventListener("click", async () => {
    try {
      await mintLivekitViewerToken("watch-output");
    } catch (error) {
      setText("watch-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("cowork-quick-antigravity")?.addEventListener("click", async () => {
    try {
      const result = await runCoworkQuickAction("open_antigravity");
      addCoworkMessage("agent", `Queued quick action: open_antigravity (${result?.task?.id || "task"})`);
    } catch (error) {
      setText("cowork-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("cowork-quick-chrome")?.addEventListener("click", async () => {
    try {
      const result = await runCoworkQuickAction("open_chrome");
      addCoworkMessage("agent", `Queued quick action: open_chrome (${result?.task?.id || "task"})`);
    } catch (error) {
      setText("cowork-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("cowork-mission-run")?.addEventListener("click", async () => {
    const missionId = ($("cowork-mission-select")?.value || "").trim();
    if (!missionId) {
      setText("cowork-output", "Select a mission template.");
      return;
    }
    try {
      const result = await runMissionTemplate(missionId);
      addCoworkMessage("agent", `Mission queued: ${result?.mission?.title || missionId} (${result?.task?.id || "task"})`);
    } catch (error) {
      setText("cowork-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("cowork-mission-social")?.addEventListener("click", async () => {
    try {
      const result = await apiPost("/api/agent/tasks/chain", {
        startTask: true,
        tasks: [
          {
            prompt: "Scan X for high-signal AI agent trend shifts and summarize actionable opportunities.",
            skillId: "x-social.run_endpoint",
            args: {
              endpoint: "search_x_v3",
              endpointArgs: {
                query: ($("cowork-mission-query")?.value || "").trim() || "AI agents trend",
                limit: 20,
              },
            },
          },
          {
            prompt: "Turn the social findings into a concise operator action brief.",
            skillId: "claude.run_task",
            args: {
              prompt: "Turn the social findings into a concise operator action brief.",
            },
          },
        ],
      });
      setText("cowork-output", result);
      const firstTaskId = result?.tasks?.[0]?.id;
      if (firstTaskId && $("task-id")) {
        $("task-id").value = firstTaskId;
      }
      if (firstTaskId && $("cowork-log-task-select")) {
        $("cowork-log-task-select").value = firstTaskId;
      }
      await refreshTasks();
      await refreshCoworkState();
      await refreshTaskLogTail();
      addCoworkMessage("agent", `Social mission chain queued (${result?.chain?.length || 0} tasks).`);
    } catch (error) {
      setText("cowork-output", error instanceof Error ? error.message : String(error));
    }
  });


  $("heartbeat-refresh")?.addEventListener("click", async () => {
    try {
      await refreshHeartbeat();
    } catch (error) {
      setText("heartbeat-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("heartbeat-run-now")?.addEventListener("click", async () => {
    try {
      setText("heartbeat-output", "Running heartbeat...");
      const result = await apiPost("/api/heartbeat/run-now", {});
      setText("heartbeat-output", result);
      logActivity("Heartbeat run-now", {
        ok: result?.ok,
        skipped: result?.skipped,
        reason: result?.reason,
      });
    } catch (error) {
      setText("heartbeat-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("provider-refresh")?.addEventListener("click", async () => {
    try {
      await refreshProviderStatus();
      await refreshIntegrations();
    } catch (error) {
      setText("provider-status-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("integrations-refresh")?.addEventListener("click", async () => {
    try {
      await refreshIntegrations();
    } catch (error) {
      setText("integrations-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("integration-open-antigravity")?.addEventListener("click", async () => {
    try {
      await runIntegrationAppOpen("antigravity", "antigravity://");
    } catch (error) {
      setText("integrations-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("integration-open-chrome")?.addEventListener("click", async () => {
    const url = ($("cowork-quick-url")?.value || "").trim() || "https://x.com/home";
    try {
      await runIntegrationAppOpen("chrome", url);
    } catch (error) {
      setText("integrations-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("integration-actions-refresh")?.addEventListener("click", async () => {
    try {
      await refreshIntegrationActionCatalog();
      await refreshIntegrationActionHistory();
    } catch (error) {
      setText("integration-action-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("integration-actions-history-refresh")?.addEventListener("click", async () => {
    try {
      await refreshIntegrationActionHistory();
    } catch (error) {
      setText("integration-actions-history-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("integration-action-dry-run")?.addEventListener("click", async () => {
    try {
      await runIntegrationActionFlow("dry_run");
    } catch (error) {
      setText("integration-action-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("integration-action-execute")?.addEventListener("click", async () => {
    try {
      await runIntegrationActionFlow("execute");
    } catch (error) {
      setText("integration-action-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("integration-subs-refresh")?.addEventListener("click", async () => {
    try {
      await refreshIntegrationSubscribers();
      await refreshIntegrationBridgeStatus();
    } catch (error) {
      setText("integration-subs-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("integration-sub-create")?.addEventListener("click", async () => {
    const url = ($("integration-sub-url")?.value || "").trim();
    const events = String($("integration-sub-events")?.value || "")
      .split(/,|\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    try {
      const result = await apiPost("/api/integrations/subscriptions", {
        url,
        events,
      });
      setText("integration-subs-output", result);
      if ($("integration-sub-id") && result?.subscriber?.id) {
        $("integration-sub-id").value = result.subscriber.id;
      }
      await refreshIntegrationSubscribers();
      await refreshIntegrationBridgeStatus();
    } catch (error) {
      setText("integration-subs-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("integration-sub-enable")?.addEventListener("click", async () => {
    const id = ($("integration-sub-id")?.value || "").trim();
    if (!id) {
      setText("integration-subs-output", "Subscriber ID is required.");
      return;
    }
    try {
      const result = await apiPost(`/api/integrations/subscriptions/${encodeURIComponent(id)}/enable`, {});
      setText("integration-subs-output", result);
      await refreshIntegrationSubscribers();
      await refreshIntegrationBridgeStatus();
    } catch (error) {
      setText("integration-subs-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("integration-sub-disable")?.addEventListener("click", async () => {
    const id = ($("integration-sub-id")?.value || "").trim();
    if (!id) {
      setText("integration-subs-output", "Subscriber ID is required.");
      return;
    }
    try {
      const result = await apiPost(`/api/integrations/subscriptions/${encodeURIComponent(id)}/disable`, {});
      setText("integration-subs-output", result);
      await refreshIntegrationSubscribers();
      await refreshIntegrationBridgeStatus();
    } catch (error) {
      setText("integration-subs-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("integration-sub-test")?.addEventListener("click", async () => {
    const id = ($("integration-sub-id")?.value || "").trim();
    if (!id) {
      setText("integration-subs-output", "Subscriber ID is required.");
      return;
    }
    try {
      const result = await apiPost(`/api/integrations/subscriptions/${encodeURIComponent(id)}/test`, {});
      setText("integration-subs-output", result);
      await refreshIntegrationBridgeStatus();
    } catch (error) {
      setText("integration-subs-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("integration-sub-delete")?.addEventListener("click", async () => {
    const id = ($("integration-sub-id")?.value || "").trim();
    if (!id) {
      setText("integration-subs-output", "Subscriber ID is required.");
      return;
    }
    try {
      const response = await fetch(`/api/integrations/subscriptions/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const text = await response.text();
      const parsed = parseMaybeJSON(text || "{}");
      if (!response.ok) {
        throw new Error(toJSON(parsed));
      }
      setText("integration-subs-output", parsed);
      await refreshIntegrationSubscribers();
      await refreshIntegrationBridgeStatus();
    } catch (error) {
      setText("integration-subs-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("integration-bridge-refresh")?.addEventListener("click", async () => {
    try {
      await refreshIntegrationBridgeStatus();
    } catch (error) {
      setText("integration-bridge-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("integration-control-token")?.addEventListener("click", async () => {
    try {
      const result = await apiPost("/api/livekit/token/control", {});
      setText("integration-bridge-output", result);
    } catch (error) {
      setText("integration-bridge-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("ext-refresh")?.addEventListener("click", async () => {
    try {
      await refreshExtensions();
    } catch (error) {
      setText("extensions-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("ext-x-enable")?.addEventListener("click", async () => {
    try {
      const result = await apiPost("/api/extensions/x-social/enable", {});
      setText("extensions-output", result);
      await refreshExtensions();
      logActivity("Enabled x-social extension", result);
    } catch (error) {
      setText("extensions-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("ext-x-disable")?.addEventListener("click", async () => {
    try {
      const result = await apiPost("/api/extensions/x-social/disable", {});
      setText("extensions-output", result);
      await refreshExtensions();
      logActivity("Disabled x-social extension", result);
    } catch (error) {
      setText("extensions-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("autonomy-refresh")?.addEventListener("click", async () => {
    try {
      await refreshAutonomy();
      await refreshApprovals();
    } catch (error) {
      setText("autonomy-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("autonomy-enable")?.addEventListener("click", async () => {
    try {
      const result = await apiPost("/api/agent/autonomy", { enabled: true });
      setText("autonomy-output", result);
      await refreshAutonomy();
      logActivity("Autonomy enabled", result);
    } catch (error) {
      setText("autonomy-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("autonomy-disable")?.addEventListener("click", async () => {
    try {
      const result = await apiPost("/api/agent/autonomy", { enabled: false });
      setText("autonomy-output", result);
      await refreshAutonomy();
      logActivity("Autonomy disabled", result);
    } catch (error) {
      setText("autonomy-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("approvals-refresh")?.addEventListener("click", async () => {
    try {
      await refreshApprovals();
    } catch (error) {
      setText("approvals-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("approval-approve")?.addEventListener("click", async () => {
    const id = ($("approval-id")?.value || "").trim();
    if (!id) {
      setText("approvals-output", "Approval ID is required.");
      return;
    }
    try {
      const result = await apiPost(`/api/agent/approvals/${encodeURIComponent(id)}/approve`, {});
      setText("approvals-output", result);
      await refreshApprovals();
      logActivity("Approval executed", { id, ok: result?.ok });
    } catch (error) {
      setText("approvals-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("approval-reject")?.addEventListener("click", async () => {
    const id = ($("approval-id")?.value || "").trim();
    if (!id) {
      setText("approvals-output", "Approval ID is required.");
      return;
    }
    try {
      const result = await apiPost(`/api/agent/approvals/${encodeURIComponent(id)}/reject`, {});
      setText("approvals-output", result);
      await refreshApprovals();
      logActivity("Approval rejected", { id, ok: result?.ok });
    } catch (error) {
      setText("approvals-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("skills-refresh")?.addEventListener("click", async () => {
    try {
      await refreshSkills();
    } catch (error) {
      setText("skills-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("skill-enable")?.addEventListener("click", async () => {
    const skillId = ($("skill-select")?.value || "").trim();
    if (!skillId) {
      setText("skills-output", "Skill ID is required.");
      return;
    }
    try {
      const result = await apiPost(`/api/skills/${encodeURIComponent(skillId)}/enable`, {});
      setText("skills-output", result);
      await refreshSkills();
    } catch (error) {
      setText("skills-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("skill-disable")?.addEventListener("click", async () => {
    const skillId = ($("skill-select")?.value || "").trim();
    if (!skillId) {
      setText("skills-output", "Skill ID is required.");
      return;
    }
    try {
      const result = await apiPost(`/api/skills/${encodeURIComponent(skillId)}/disable`, {});
      setText("skills-output", result);
      await refreshSkills();
    } catch (error) {
      setText("skills-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("skill-run")?.addEventListener("click", async () => {
    const skillId = ($("skill-select")?.value || "").trim();
    if (!skillId) {
      setText("skills-output", "Skill ID is required.");
      return;
    }
    let args = {};
    const rawArgs = ($("skill-args")?.value || "").trim();
    if (rawArgs) {
      const parsed = parseMaybeJSON(rawArgs);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed;
      } else {
        setText("skills-output", "Skill args must be a JSON object.");
        return;
      }
    }
    try {
      const result = await apiPost("/api/skills/run", {
        skillId,
        args,
      });
      setText("skills-output", result);
      await refreshApprovals();
      await refreshTasks();
    } catch (error) {
      setText("skills-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("task-create-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const prompt = ($("task-prompt")?.value || "").trim();
    const skillId = ($("task-skill-select")?.value || "").trim();
    const dependsOnTaskId = ($("task-depends-on")?.value || "").trim();
    if (!prompt && !skillId) {
      setText("tasks-output", "Task prompt or skill route is required.");
      return;
    }
    try {
      const result = await apiPost("/api/agent/tasks", {
        prompt,
        skillId: skillId || undefined,
        dependsOnTaskId: dependsOnTaskId || undefined,
      });
      setText("tasks-output", result);
      if ($("task-id") && result?.task?.id) {
        $("task-id").value = result.task.id;
      }
      await refreshTasks();
      await refreshCoworkState();
      await refreshTaskLogTail();
    } catch (error) {
      setText("tasks-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("tasks-refresh")?.addEventListener("click", async () => {
    try {
      await refreshTasks();
      await refreshCoworkState();
      await refreshTaskLogTail();
    } catch (error) {
      setText("tasks-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("task-cancel")?.addEventListener("click", async () => {
    const id = ($("task-id")?.value || "").trim();
    if (!id) {
      setText("tasks-output", "Task ID is required.");
      return;
    }
    try {
      const result = await apiPost(`/api/agent/tasks/${encodeURIComponent(id)}/cancel`, {});
      setText("tasks-output", result);
      await refreshTasks();
      await refreshCoworkState();
      await refreshTaskLogTail();
    } catch (error) {
      setText("tasks-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("task-retry")?.addEventListener("click", async () => {
    const id = ($("task-id")?.value || "").trim();
    if (!id) {
      setText("tasks-output", "Task ID is required.");
      return;
    }
    try {
      const result = await apiPost(`/api/agent/tasks/${encodeURIComponent(id)}/retry`, {});
      setText("tasks-output", result);
      if (result?.task?.id && $("task-id")) {
        $("task-id").value = result.task.id;
      }
      if (result?.task?.id && $("cowork-log-task-select")) {
        $("cowork-log-task-select").value = result.task.id;
      }
      await refreshTasks();
      await refreshCoworkState();
      await refreshTaskLogTail();
    } catch (error) {
      setText("tasks-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("task-watch")?.addEventListener("click", async () => {
    const id = ($("task-id")?.value || "").trim();
    const sourceId = ($("watch-source-select")?.value || "").trim() || "embedded-browser";
    const fps = toInt($("watch-fps")?.value, 2);
    if (!id) {
      setText("tasks-output", "Task ID is required.");
      return;
    }
    try {
      await startWatchSessionFlow({
        sourceId,
        taskId: id,
        fps,
        outputId: "mac-policy-output",
      });
    } catch (error) {
      setText("mac-policy-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("cowork-task-board")?.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const action = (target.dataset.taskAction || "").trim();
    const taskId = (target.dataset.taskId || "").trim();
    if (!action || !taskId) {
      return;
    }
    if ($("task-id")) {
      $("task-id").value = taskId;
    }
    if (action === "load") {
      try {
        if ($("cowork-log-task-select")) {
          $("cowork-log-task-select").value = taskId;
        }
        await refreshTaskLogTail();
      } catch {
        // ignore load-only refresh errors
      }
      return;
    }
    if (action === "retry") {
      try {
        const result = await apiPost(`/api/agent/tasks/${encodeURIComponent(taskId)}/retry`, {});
        setText("tasks-output", result);
        if (result?.task?.id && $("task-id")) {
          $("task-id").value = result.task.id;
        }
        await refreshTasks();
        await refreshCoworkState();
        await refreshTaskLogTail();
      } catch (error) {
        setText("tasks-output", error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (action === "watch") {
      try {
        const sourceId = ($("watch-source-select")?.value || "").trim() || "embedded-browser";
        const fps = toInt($("watch-fps")?.value, 2);
        await startWatchSessionFlow({
          sourceId,
          taskId,
          fps,
          outputId: "mac-policy-output",
        });
      } catch (error) {
        setText("mac-policy-output", error instanceof Error ? error.message : String(error));
      }
    }
  });

  $("cowork-log-refresh")?.addEventListener("click", async () => {
    try {
      await refreshTaskLogTail();
    } catch (error) {
      setText("cowork-log-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("cowork-log-task-select")?.addEventListener("change", async () => {
    try {
      await refreshTaskLogTail();
    } catch (error) {
      setText("cowork-log-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("cowork-log-type-filter")?.addEventListener("change", async () => {
    try {
      await refreshTaskLogTail();
    } catch (error) {
      setText("cowork-log-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("mac-apps-refresh")?.addEventListener("click", async () => {
    try {
      await refreshMacApps();
    } catch (error) {
      setText("mac-policy-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("mac-policy-save")?.addEventListener("click", async () => {
    try {
      const appAllowlist = [
        $("mac-allow-antigravity")?.checked ? "antigravity" : null,
        $("mac-allow-chrome")?.checked ? "chrome" : null,
      ].filter(Boolean);
      const result = await apiPost("/api/mac/policy", {
        appAllowlist,
      });
      setText("mac-policy-output", result);
      await refreshMacApps();
    } catch (error) {
      setText("mac-policy-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("mac-open-app")?.addEventListener("click", async () => {
    const appId = ($("mac-app-select")?.value || "").trim();
    const url = ($("mac-app-url")?.value || "").trim();
    if (!appId) {
      setText("mac-policy-output", "App ID is required.");
      return;
    }
    try {
      const result = await apiPost("/api/mac/apps/open", {
        appId,
        url: url || undefined,
      });
      setText("mac-policy-output", result);
      await refreshMacApps();
    } catch (error) {
      setText("mac-policy-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("mac-focus-app")?.addEventListener("click", async () => {
    const appId = ($("mac-app-select")?.value || "").trim();
    if (!appId) {
      setText("mac-policy-output", "App ID is required.");
      return;
    }
    try {
      const result = await apiPost("/api/mac/apps/focus", {
        appId,
      });
      setText("mac-policy-output", result);
      await refreshMacApps();
    } catch (error) {
      setText("mac-policy-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("watch-sources-refresh")?.addEventListener("click", async () => {
    try {
      await refreshMacApps();
    } catch (error) {
      setText("mac-policy-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("watch-start")?.addEventListener("click", async () => {
    const sourceId = ($("watch-source-select")?.value || "").trim();
    const taskId = ($("task-id")?.value || "").trim();
    const fps = toInt($("watch-fps")?.value, 2);
    if (!sourceId) {
      setText("mac-policy-output", "Watch source is required.");
      return;
    }
    try {
      await startWatchSessionFlow({
        sourceId,
        taskId: taskId || undefined,
        fps,
        outputId: "mac-policy-output",
      });
    } catch (error) {
      setText("mac-policy-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("watch-stop")?.addEventListener("click", async () => {
    const sessionId = (readSelectedWatchSessionId() || resolveActiveWatchSession()?.id || "").trim();
    if (!sessionId) {
      setText("mac-policy-output", "Watch session ID is required.");
      return;
    }
    try {
      const result = await apiPost("/api/watch/stop", {
        sessionId,
      });
      setText("mac-policy-output", result);
      await refreshMacApps();
      await refreshCoworkState();
      if ((readSelectedWatchSessionId() || "").trim() === sessionId) {
        syncWatchSessionSelection("");
      }
      renderWatchObserverMeta();
      if (!resolveActiveWatchSession()) {
        setObserverIframeSession(null);
      }
    } catch (error) {
      setText("mac-policy-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("watch-session-id")?.addEventListener("change", () => {
    const value = ($("watch-session-id")?.value || "").trim();
    syncWatchSessionSelection(value);
    renderWatchSessionOptions();
    renderWatchObserverMeta();
    const session = resolveActiveWatchSession();
    if (session) {
      setObserverIframeSession(session);
    } else if (!value) {
      setObserverIframeSession(null);
    }
  });

  $("watch-session-select")?.addEventListener("change", () => {
    const selected = ($("watch-session-select")?.value || "").trim();
    syncWatchSessionSelection(selected);
    renderWatchObserverMeta();
    const session = resolveActiveWatchSession();
    if (session) {
      setObserverIframeSession(session);
      return;
    }
    if (!selected) {
      const fallback = resolveActiveWatchSession();
      if (fallback) {
        setObserverIframeSession(fallback);
      } else {
        setObserverIframeSession(null);
      }
    }
  });

  $("livekit-refresh")?.addEventListener("click", async () => {
    try {
      await refreshLivekitStatus();
    } catch (error) {
      setText("livekit-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("livekit-api-key")?.addEventListener("input", () => {
    const input = $("livekit-api-key");
    if (input) {
      input.dataset.userEdited = "true";
    }
  });

  $("livekit-save")?.addEventListener("click", async () => {
    const enabled = Boolean($("livekit-enabled")?.checked);
    const wsUrl = ($("livekit-ws-url")?.value || "").trim();
    const apiKey = ($("livekit-api-key")?.value || "").trim();
    const roomPrefix = ($("livekit-room-prefix")?.value || "").trim();
    const streamMode = ($("livekit-stream-mode")?.value || "").trim();
    try {
      const result = await apiPost("/api/livekit/config", {
        enabled,
        wsUrl,
        apiKey: apiKey || undefined,
        roomPrefix: roomPrefix || undefined,
        streamMode,
      });
      if ($("livekit-api-key")) {
        $("livekit-api-key").value = "";
        delete $("livekit-api-key").dataset.userEdited;
      }
      setText("livekit-output", result);
      await refreshLivekitStatus();
      await refreshCoworkState();
    } catch (error) {
      setText("livekit-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("livekit-token")?.addEventListener("click", async () => {
    try {
      await mintLivekitViewerToken("livekit-output");
    } catch (error) {
      setText("livekit-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("endpoint-filter")?.addEventListener("input", renderEndpointOptions);
  $("endpoint-select")?.addEventListener("change", renderEndpointArgs);
  [
    ["ai-model-select", "ai-model"],
    ["plan-model-select", "plan-model"],
    ["ai-image-model-select", "ai-image-model"],
    ["ai-video-model-select", "ai-video-model"],
  ].forEach(([selectId, inputId]) => {
    $(selectId)?.addEventListener("change", () => {
      const value = ($(selectId)?.value || "").trim();
      if (!value || !$(inputId)) {
        return;
      }
      $(inputId).value = value;
    });
  });

  $("endpoint-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const endpoint = $("endpoint-select")?.value || "";
      if (!endpoint) {
        throw new Error("Endpoint is required.");
      }
      const args = collectEndpointArgs();
      setText("endpoint-output", "Running...");
      await runEndpoint(endpoint, args, "endpoint-output");
    } catch (error) {
      setText("endpoint-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("history-list")?.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const idx = target.dataset.historyIndex;
    if (idx == null) {
      return;
    }
    const item = state.history[Number(idx)];
    if (!item) {
      return;
    }
    try {
      setText("endpoint-output", "Running from history...");
      await runEndpoint(item.endpoint, item.args || {}, "endpoint-output");
    } catch (error) {
      setText("endpoint-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("login-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const username = ($("login-username")?.value || "").trim();
    const password = $("login-password")?.value || "";
    const email = ($("login-email")?.value || "").trim();
    if (!username || !password) {
      setText("login-output", "username and password are required");
      return;
    }
    try {
      setText("login-output", "Running...");
      const result = await apiPost("/api/x/login", {
        username,
        password,
        email: email || undefined,
        globalArgs: getGlobalArgs(),
      });
      setText("login-output", result);
      logActivity("Login refresh", result);
    } catch (error) {
      setText("login-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("tweet-generate")?.addEventListener("click", async () => {
    const style = ($("tweet-style")?.value || "").trim();
    const seed = ($("tweet-text")?.value || "").trim();
    const personaExamples = Array.isArray(state.derivedPersona?.postExamples)
      ? state.derivedPersona.postExamples.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 6)
      : [];
    try {
      setText("tweet-output", "Generating...");
      const result = await apiPost("/api/ai/chat", {
        system:
          "Write one single X post under 260 characters. Output only tweet text, no quotes and no markdown. If examples are provided, mirror cadence but do not copy lines verbatim.",
        prompt: [
          `Style: ${style || "concise, cryptic, high signal"}`,
          `Seed ideas: ${seed || "Operating from Prompt or Die."}`,
          personaExamples.length ? `Real post examples:\n- ${personaExamples.join("\n- ")}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
      const text = result?.data?.text || "";
      if ($("tweet-text")) {
        $("tweet-text").value = String(text).trim();
      }
      setText("tweet-output", result);
      logActivity("Tweet draft generated", result);
    } catch (error) {
      setText("tweet-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("tweet-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = ($("tweet-text")?.value || "").trim();
    if (!text) {
      setText("tweet-output", "tweet text is required");
      return;
    }
    try {
      setText("tweet-output", "Posting...");
      const result = await apiPost("/api/x/post", {
        text,
        globalArgs: getGlobalArgs(),
      });
      setText("tweet-output", result);
      logActivity("Tweet posted", result);
    } catch (error) {
      setText("tweet-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("plan-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const goal = ($("plan-goal")?.value || "").trim();
    const context = ($("plan-context")?.value || "").trim();
    const model = ($("plan-model")?.value || "").trim();
    if (!goal) {
      setText("plan-output", "goal is required");
      return;
    }
    try {
      setText("plan-output", "Generating plan...");
      const result = await apiPost("/api/ai/automation-plan", {
        goal,
        context: context || undefined,
        model: model || undefined,
      });
      state.latestPlan = result?.data?.plan || null;
      setText("plan-output", result);
      logActivity("AI plan generated", result);
    } catch (error) {
      setText("plan-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("plan-import")?.addEventListener("click", () => {
    if (!state.latestPlan) {
      setText("plan-output", "No generated plan to import yet.");
      return;
    }
    if ($("workflow-json")) {
      $("workflow-json").value = toJSON({
        stopOnError: true,
        steps: state.latestPlan.steps || [],
      });
    }
    logActivity("Plan imported into workflow runner");
  });

  $("workflow-format")?.addEventListener("click", () => {
    try {
      formatWorkflowEditor();
    } catch (error) {
      setText("workflow-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("workflow-clear")?.addEventListener("click", () => {
    if ($("workflow-json")) {
      $("workflow-json").value = '{\n  "stopOnError": true,\n  "steps": []\n}';
    }
    setText("workflow-output", "");
  });

  $("workflow-run")?.addEventListener("click", async () => {
    try {
      const workflow = JSON.parse($("workflow-json")?.value || "{}");
      setText("workflow-output", "Running workflow...");
      await runWorkflow(workflow, "workflow-output");
    } catch (error) {
      setText("workflow-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("qa-session")?.addEventListener("click", async () => {
    try {
      const workflow = quickSessionWorkflow();
      if ($("workflow-json")) {
        $("workflow-json").value = toJSON(workflow);
      }
      setText("quick-output", "Running...");
      const result = await runWorkflow(workflow, "quick-output");
      setText("workflow-output", result);
    } catch (error) {
      setText("quick-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("qa-discovery")?.addEventListener("click", async () => {
    const keyword = window.prompt("Discovery keyword", "AI agents") || "AI agents";
    try {
      const workflow = quickDiscoveryWorkflow(keyword.trim() || "AI agents");
      if ($("workflow-json")) {
        $("workflow-json").value = toJSON(workflow);
      }
      setText("quick-output", "Running...");
      const result = await runWorkflow(workflow, "quick-output");
      setText("workflow-output", result);
    } catch (error) {
      setText("quick-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("qa-trendscan")?.addEventListener("click", async () => {
    const query = window.prompt("Trend scan query", "AI") || "AI";
    try {
      const workflow = quickTrendScanWorkflow(query.trim() || "AI");
      if ($("workflow-json")) {
        $("workflow-json").value = toJSON(workflow);
      }
      setText("quick-output", "Running...");
      const result = await runWorkflow(workflow, "quick-output");
      setText("workflow-output", result);
    } catch (error) {
      setText("quick-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("ai-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const model = ($("ai-model")?.value || "").trim();
    const system = ($("ai-system")?.value || "").trim();
    const prompt = ($("ai-prompt")?.value || "").trim();
    if (!prompt) {
      setText("ai-output", "prompt is required");
      return;
    }
    try {
      setText("ai-output", "Running...");
      const result = await apiPost("/api/ai/chat", {
        model: model || undefined,
        system: system || undefined,
        prompt,
      });
      setText("ai-output", result);
      logActivity("AI chat", result);
    } catch (error) {
      setText("ai-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("ai-image-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const model = ($("ai-image-model")?.value || "").trim();
    const prompt = ($("ai-image-prompt")?.value || "").trim();
    if (!prompt) {
      setText("ai-image-output", "prompt is required");
      return;
    }
    try {
      setText("ai-image-output", "Running...");
      const result = await apiPost("/api/ai/image", {
        model: model || undefined,
        prompt,
      });
      setText("ai-image-output", result);
      logActivity("AI image", result);
    } catch (error) {
      setText("ai-image-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("ai-video-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const model = ($("ai-video-model")?.value || "").trim();
    const videoUrl = ($("ai-video-url")?.value || "").trim();
    const prompt = ($("ai-video-prompt")?.value || "").trim();
    if (!videoUrl) {
      setText("ai-video-output", "video URL (or data URL) is required");
      return;
    }
    if (!prompt) {
      setText("ai-video-output", "prompt is required");
      return;
    }
    try {
      setText("ai-video-output", "Running...");
      const result = await apiPost("/api/ai/video", {
        model: model || undefined,
        prompt,
        videoUrl,
      });
      setText("ai-video-output", result);
      logActivity("AI video", result);
    } catch (error) {
      setText("ai-video-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("x-algo-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const handle = ($("x-algo-handle")?.value || "").trim();
    const draftInput = ($("x-algo-draft")?.value || "").trim();
    const styleHint = ($("x-algo-style")?.value || "").trim();
    const draft = draftInput || ($("tweet-text")?.value || "").trim();
    if (!draft) {
      setText("x-algo-output", "draft is required");
      return;
    }
    if (!draftInput && $("x-algo-draft")) {
      $("x-algo-draft").value = draft;
    }
    try {
      setText("x-algo-output", "Running...");
      const result = await apiPost("/api/ai/x-algorithm-intel", {
        handle: handle || undefined,
        draft,
        styleHint: styleHint || undefined,
        globalArgs: getGlobalArgs(),
      });
      state.latestXAlgo = result?.data || null;
      setText("x-algo-output", result);
      if (result?.data?.model?.weights) {
        setText("x-algo-weights", result.data.model.weights);
      }
      populateXAlgoQuerySelect();
      const best = result?.data?.draftIntel?.bestDraft;
      if (typeof best === "string" && best.trim() && $("tweet-text")) {
        $("tweet-text").value = best.trim();
      }
      const autoRunEnabled = Boolean($("x-algo-auto-run")?.checked);
      const topSuggested = ($("x-algo-query-select")?.value || "").trim() || getXAlgoSuggestedQueries()[0] || "";
      if (autoRunEnabled && topSuggested) {
        try {
          await runSuggestedQueryWorkflow(topSuggested, "auto_after_intel");
        } catch (autoRunError) {
          setText("x-algo-output", {
            result,
            autoRunError: autoRunError instanceof Error ? autoRunError.message : String(autoRunError),
          });
        }
      }
      logActivity("X algorithm intel", {
        handle: result?.data?.source?.handle,
        score: result?.data?.model?.score,
        artifactCounts: result?.data?.artifactCounts,
      });
    } catch (error) {
      setText("x-algo-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("x-algo-apply-best")?.addEventListener("click", () => {
    const best = state.latestXAlgo?.draftIntel?.bestDraft;
    if (!best || typeof best !== "string" || !best.trim()) {
      setText("x-algo-output", "No best draft available yet. Run X Algorithm Intel first.");
      return;
    }
    if ($("tweet-text")) {
      $("tweet-text").value = best.trim();
    }
    logActivity("Applied best draft from X Algorithm Intel");
  });

  $("x-algo-run-suggested")?.addEventListener("click", async () => {
    const explicit = ($("x-algo-query-select")?.value || "").trim();
    const fallback = getXAlgoSuggestedQueries()[0] || "";
    const query = explicit || fallback;
    if (!query) {
      setText("x-algo-output", "No suggested query available yet. Run X Algorithm Intel first.");
      return;
    }
    try {
      await runSuggestedQueryWorkflow(query, "manual_button");
    } catch (error) {
      setText("quick-output", error instanceof Error ? error.message : String(error));
    }
  });

};

const boot = async () => {
  state.history = loadHistory();
  state.coworkMessages = loadCoworkMessages();
  state.dashboardJsonRenderSpec = readDashboardJsonRenderSpec();
  state.dashboardJsonRenderDraft = null;
  state.contextInbox = readContextInbox();
  state.contextPrefs = readContextPrefs();
  state.utilityRail = readUtilityRailState();
  if (window.podDesktop?.getDesktopCapabilities) {
    try {
      const caps = window.podDesktop.getDesktopCapabilities();
      state.desktopCapabilities = {
        nativeContextMenu: Boolean(caps?.nativeContextMenu),
      };
    } catch {
      state.desktopCapabilities = {
        nativeContextMenu: false,
      };
    }
  }
  renderHistory();
  renderCoworkChat();
  renderCoworkConversations();
  hydrateGeneratedDashboardPanels();
  initDashboardWorkbench();
  renderDashboardJsonRenderStatus();
  renderContextInbox();
  syncUtilityRailState();
  syncContextSurfaceAvailability();
  if (!(($("context-rail-source")?.value || "").trim()) && state.contextInbox[0]?.text) {
    setUtilityRailSourceText(state.contextInbox[0].text);
  }
  bindOnboardingEvents();
  bindDashboardEvents();
  await refreshHealth();
  await loadCatalog();
  await refreshOnboardingState();
  await refreshHeartbeat();
  await refreshProviderStatus();
  await refreshExtensions();
  await refreshAutonomy();
  await refreshApprovals();
  await refreshSkills();
  await refreshTasks();
  await refreshCoworkState();
  await refreshCoworkMissions();
  await refreshMacApps();
  await refreshLivekitStatus();
  await refreshIntegrations();
  await refreshIntegrationActionCatalog();
  await refreshIntegrationActionHistory();
  await refreshIntegrationSubscribers();
  await refreshIntegrationBridgeStatus();
  await refreshTaskLogTail();
  renderWatchObserverMeta();
  const initialWatchSession = resolveActiveWatchSession();
  if (initialWatchSession) {
    setObserverIframeSession(initialWatchSession);
  }
  setInterval(async () => {
    try {
      await Promise.all([
        refreshTasks(),
        refreshApprovals(),
        refreshCoworkState(),
        refreshTaskLogTail(),
        refreshIntegrations(),
        refreshIntegrationBridgeStatus(),
        refreshIntegrationActionHistory(),
      ]);
    } catch {
      // keep dashboard responsive even if one refresh cycle fails
    }
  }, 6000);
  populateXAlgoQuerySelect();
  setText("activity-log", "Prompt or Die Social Suite ready.");
};

boot().catch((error) => {
  setText("activity-log", error instanceof Error ? error.message : String(error));
});
