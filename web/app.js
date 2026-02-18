const HISTORY_KEY = "prompt-or-die-social-suite.history.v1";
const COWORK_CHAT_KEY = "prompt-or-die-social-suite.cowork.chat.v1";
const MAX_HISTORY = 50;

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
  codeStatus: null,
  codeApprovals: [],
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
  terminalSessions: [],
  terminalActiveSessionId: "",
  workspaceTreeEntries: [],
  workspaceFileSha256: "",
  workspaceFileConfirmToken: "",
  gitStatus: null,
  gitConfirmTokens: {
    create_branch: "",
    commit: "",
    push: "",
  },
  terminalPtySessions: [],
  terminalPtyActiveSessionId: "",
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
    return;
  }
  node.innerHTML = "";
  if (!state.coworkMessages.length) {
    const empty = document.createElement("div");
    empty.className = "cowork-msg";
    empty.innerHTML = "<strong>System</strong>Dispatch tasks from here to run agent cowork flows.";
    node.appendChild(empty);
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
    return;
  }
  container.innerHTML = "";
  if (!state.history.length) {
    const empty = document.createElement("div");
    empty.className = "history-item";
    empty.textContent = "No runs yet.";
    container.appendChild(empty);
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
      label: "coding-agent",
      value: Boolean(readiness.codingAgentReady),
      text: readiness.codingAgentReady ? "ready" : "blocked",
    },
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
      label: "claude-session",
      value: Boolean(state.integrations?.claude?.sessionDetected),
      text: state.integrations?.claude?.sessionDetected ? "detected" : "missing",
    },
    {
      label: "codex",
      value: Boolean(state.integrations?.codex?.available),
      text: state.integrations?.codex?.available ? "available" : "missing",
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

const refreshCodeStatus = async () => {
  const result = await apiGet("/api/code/status");
  state.codeStatus = result || null;
  setText("code-status-output", result);
  return result;
};

const refreshTerminalSessions = async () => {
  const result = await apiGet("/api/code/sessions");
  state.terminalSessions = Array.isArray(result?.sessions) ? result.sessions : [];
  const select = $("terminal-session-select");
  if (select) {
    const current = state.terminalActiveSessionId || select.value;
    select.innerHTML = "";
    const fallback = document.createElement("option");
    fallback.value = "";
    fallback.textContent = "latest session";
    select.appendChild(fallback);
    state.terminalSessions.slice(0, 60).forEach((session) => {
      const option = document.createElement("option");
      option.value = session.id;
      option.textContent = `${session.id} • ${session.status} • ${session.command}`;
      select.appendChild(option);
    });
    if (current && state.terminalSessions.some((session) => session.id === current)) {
      select.value = current;
      state.terminalActiveSessionId = current;
    } else if (state.terminalSessions[0]) {
      select.value = state.terminalSessions[0].id;
      state.terminalActiveSessionId = state.terminalSessions[0].id;
    } else {
      select.value = "";
      state.terminalActiveSessionId = "";
    }
  }
  return result;
};

const loadTerminalSession = async (sessionIdRaw) => {
  const sessionId = String(sessionIdRaw || "").trim() || state.terminalSessions[0]?.id || "";
  if (!sessionId) {
    setText("terminal-output", "No terminal session found yet.");
    return null;
  }
  const result = await apiGet(`/api/code/sessions/${encodeURIComponent(sessionId)}`);
  state.terminalActiveSessionId = sessionId;
  const session = result?.session || null;
  const lines = [];
  if (session) {
    lines.push(`$ ${session.command}`);
    lines.push("");
    if (session.stdout) {
      lines.push(String(session.stdout));
    }
    if (session.stderr) {
      if (session.stdout) {
        lines.push("");
      }
      lines.push("[stderr]");
      lines.push(String(session.stderr));
    }
    lines.push("");
    lines.push(`[status=${session.status} exit=${session.exitCode} cwd=${session.cwd}]`);
  }
  setText("terminal-output", {
    ok: result?.ok,
    sessionId,
    output: lines.join("\n"),
  });
  return result;
};

const runEmbeddedTerminalCommand = async (command, cwd) => {
  const result = await apiPost("/api/code/exec", {
    command,
    cwd: cwd || undefined,
  });
  setText("terminal-output", result);
  await refreshCodeStatus();
  await refreshCodeApprovals();
  await refreshTerminalSessions();
  const sessionId = result?.session?.id || state.terminalSessions[0]?.id || "";
  if (sessionId) {
    await loadTerminalSession(sessionId);
  }
  return result;
};

const normalizeWorkbenchRelPath = (raw) => {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    return "";
  }
  const withSlashes = trimmed.replace(/\\/g, "/");
  const noLeading = withSlashes.replace(/^\/+/, "");
  const noTrailing = noLeading.replace(/\/+$/, "");
  if (noTrailing === "." || noTrailing === "./") {
    return "";
  }
  return noTrailing;
};

const parentWorkbenchRelDir = (relDirRaw) => {
  const relDir = normalizeWorkbenchRelPath(relDirRaw);
  if (!relDir) {
    return "";
  }
  const parts = relDir.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
};

const refreshWorkspaceTree = async () => {
  const relDir = normalizeWorkbenchRelPath($("workspace-tree-path")?.value || "");
  const result = await apiGet(`/api/workspace/tree?path=${encodeURIComponent(relDir)}`);
  state.workspaceTreeEntries = Array.isArray(result?.entries) ? result.entries : [];
  renderWorkspaceTree();
  setText("workspace-file-output", result);
  return result;
};

const renderWorkspaceTree = () => {
  const container = $("workspace-tree");
  if (!container) {
    return;
  }
  container.innerHTML = "";
  const entries = Array.isArray(state.workspaceTreeEntries) ? state.workspaceTreeEntries : [];
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "history-item";
    empty.textContent = "No entries found.";
    container.appendChild(empty);
    return;
  }
  entries.forEach((entry) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost";
    button.dataset.workspacePath = entry.relPath;
    button.dataset.workspaceType = entry.type;
    const prefix = entry.type === "dir" ? "[dir]" : "[file]";
    button.textContent = `${prefix} ${entry.name}`;
    container.appendChild(button);
  });
};

const loadWorkspaceFile = async (relPathRaw) => {
  const relPath = normalizeWorkbenchRelPath(relPathRaw || $("workspace-file-path")?.value || "");
  if (!relPath) {
    throw new Error("File path is required.");
  }
  if ($("workspace-file-path")) {
    $("workspace-file-path").value = relPath;
  }
  const result = await apiGet(`/api/workspace/file?path=${encodeURIComponent(relPath)}`);
  if ($("workspace-file-content")) {
    $("workspace-file-content").value = String(result?.content || "");
  }
  state.workspaceFileSha256 = String(result?.sha256 || "");
  state.workspaceFileConfirmToken = "";
  setText("workspace-file-output", result);
  return result;
};

const dryRunWorkspaceSave = async () => {
  const relPath = normalizeWorkbenchRelPath($("workspace-file-path")?.value || "");
  if (!relPath) {
    throw new Error("File path is required.");
  }
  const content = $("workspace-file-content")?.value || "";
  const baseSha256 = String(state.workspaceFileSha256 || "").trim();
  const result = await apiPost("/api/workspace/file", {
    mode: "dry_run",
    path: relPath,
    content,
    baseSha256,
  });
  state.workspaceFileConfirmToken = String(result?.confirmToken || "");
  setText("workspace-file-output", result);
  return result;
};

const executeWorkspaceSave = async () => {
  const relPath = normalizeWorkbenchRelPath($("workspace-file-path")?.value || "");
  if (!relPath) {
    throw new Error("File path is required.");
  }
  const content = $("workspace-file-content")?.value || "";
  const baseSha256 = String(state.workspaceFileSha256 || "").trim();
  const confirmToken = String(state.workspaceFileConfirmToken || "").trim();
  if (!confirmToken) {
    throw new Error("Missing confirm token. Run Dry-run Save first.");
  }
  const result = await apiPost("/api/workspace/file", {
    mode: "execute",
    path: relPath,
    content,
    baseSha256,
    confirmToken,
  });
  state.workspaceFileSha256 = String(result?.result?.sha256 || state.workspaceFileSha256 || "");
  state.workspaceFileConfirmToken = "";
  setText("workspace-file-output", result);
  return result;
};

const refreshGitStatus = async () => {
  const result = await apiGet("/api/git/status");
  state.gitStatus = result || null;
  setText("git-status-output", result);
  return result;
};

const refreshGitLog = async () => {
  const result = await apiGet("/api/git/log?limit=50");
  setText("git-action-output", result);
  return result;
};

const refreshGitDiff = async (staged, pathRaw) => {
  const relPath = normalizeWorkbenchRelPath(pathRaw || $("git-diff-path")?.value || "");
  const query = new URLSearchParams();
  query.set("staged", staged ? "1" : "0");
  if (relPath) {
    query.set("path", relPath);
  }
  const result = await apiGet(`/api/git/diff?${query.toString()}`);
  setText("git-diff-output", result);
  return result;
};

const collectGitActionParams = (action) => {
  if (action === "create_branch") {
    const name = ($("git-branch-name")?.value || "").trim();
    return { name, checkout: true };
  }
  if (action === "commit") {
    const message = ($("git-commit-message")?.value || "").trim();
    const addAll = Boolean($("git-commit-addall")?.checked);
    return { message, addAll };
  }
  if (action === "push") {
    const setUpstream = Boolean($("git-push-upstream")?.checked);
    return { remote: "origin", setUpstream };
  }
  return {};
};

const dryRunGitAction = async (action) => {
  const params = collectGitActionParams(action);
  const result = await apiPost("/api/git/actions", {
    mode: "dry_run",
    action,
    params,
  });
  state.gitConfirmTokens[action] = String(result?.confirmToken || "");
  setText("git-action-output", result);
  await refreshGitStatus();
  return result;
};

const executeGitAction = async (action) => {
  const params = collectGitActionParams(action);
  const confirmToken = String(state.gitConfirmTokens[action] || "").trim();
  if (!confirmToken) {
    throw new Error("Missing confirm token. Run dry-run first.");
  }
  const result = await apiPost("/api/git/actions", {
    mode: "execute",
    action,
    params,
    confirmToken,
  });
  state.gitConfirmTokens[action] = "";
  setText("git-action-output", result);
  await refreshGitStatus();
  return result;
};

let terminalPtyWs = null;

const appendTerminalPtyOutput = (chunk) => {
  const node = $("terminal-pty-output");
  if (!node) {
    return;
  }
  const next = `${node.textContent || ""}${String(chunk || "")}`;
  node.textContent = next.slice(Math.max(0, next.length - 200_000));
  node.scrollTop = node.scrollHeight;
};

const refreshTerminalPtySessions = async () => {
  const result = await apiGet("/api/terminal/sessions");
  state.terminalPtySessions = Array.isArray(result?.sessions) ? result.sessions : [];
  const select = $("terminal-pty-session-select");
  if (select) {
    const current = state.terminalPtyActiveSessionId || select.value;
    select.innerHTML = "";
    const fallback = document.createElement("option");
    fallback.value = "";
    fallback.textContent = "select session";
    select.appendChild(fallback);
    state.terminalPtySessions.slice(0, 50).forEach((session) => {
      const option = document.createElement("option");
      option.value = session.id;
      option.textContent = `${session.id} • ${session.status} • ${session.cwd}`;
      select.appendChild(option);
    });
    if (current && state.terminalPtySessions.some((session) => session.id === current)) {
      select.value = current;
      state.terminalPtyActiveSessionId = current;
    } else if (state.terminalPtySessions[0]) {
      select.value = state.terminalPtySessions[0].id;
      state.terminalPtyActiveSessionId = state.terminalPtySessions[0].id;
    } else {
      select.value = "";
      state.terminalPtyActiveSessionId = "";
    }
  }
  setText("terminal-pty-output", result);
  return result;
};

const readTerminalPtySessionId = () => {
  const selected = ($("terminal-pty-session-select")?.value || "").trim();
  if (selected) {
    return selected;
  }
  return String(state.terminalPtyActiveSessionId || "").trim();
};

const connectTerminalPtyWs = () => {
  const sessionId = readTerminalPtySessionId();
  if (!sessionId) {
    appendTerminalPtyOutput("\n[error] select a terminal session first.\n");
    return;
  }
  if (terminalPtyWs) {
    try {
      terminalPtyWs.close();
    } catch {
      // ignore
    }
    terminalPtyWs = null;
  }
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const url = `${scheme}://${window.location.host}/api/terminal/ws?sessionId=${encodeURIComponent(sessionId)}`;
  const ws = new WebSocket(url);
  terminalPtyWs = ws;
  appendTerminalPtyOutput(`\n[connect] ${sessionId}\n`);
  ws.addEventListener("message", (event) => {
    const raw = typeof event.data === "string" ? event.data : "";
    const parsed = parseMaybeJSON(raw);
    if (!parsed || typeof parsed !== "object") {
      appendTerminalPtyOutput(raw);
      return;
    }
    const type = parsed.type;
    const payload = parsed.payload || {};
    if (type === "terminal_bootstrap") {
      if (typeof payload.buffer === "string" && payload.buffer) {
        appendTerminalPtyOutput(payload.buffer);
      }
      return;
    }
    if (type === "terminal_output") {
      if (typeof payload.chunk === "string") {
        appendTerminalPtyOutput(payload.chunk);
      }
      return;
    }
    if (type === "terminal_exit") {
      appendTerminalPtyOutput(`\n[exit] ${payload.exitCode}\n`);
    }
  });
  ws.addEventListener("close", () => {
    appendTerminalPtyOutput("\n[disconnect]\n");
  });
  ws.addEventListener("error", () => {
    appendTerminalPtyOutput("\n[ws_error]\n");
  });
};

const disconnectTerminalPtyWs = () => {
  if (!terminalPtyWs) {
    return;
  }
  try {
    terminalPtyWs.close();
  } catch {
    // ignore
  }
  terminalPtyWs = null;
};

const createTerminalPtySession = async () => {
  const cwd = ($("terminal-pty-cwd")?.value || "").trim();
  const result = await apiPost("/api/terminal/sessions", {
    cwd: cwd || undefined,
  });
  if (result?.session?.id) {
    state.terminalPtyActiveSessionId = result.session.id;
  }
  await refreshTerminalPtySessions();
  appendTerminalPtyOutput(`\n[created] ${result?.session?.id || "unknown"}\n`);
  return result;
};

const closeTerminalPtySession = async () => {
  const sessionId = readTerminalPtySessionId();
  if (!sessionId) {
    throw new Error("Select a terminal session first.");
  }
  if (state.terminalPtyActiveSessionId === sessionId) {
    disconnectTerminalPtyWs();
  }
  const result = await apiPost(`/api/terminal/sessions/${encodeURIComponent(sessionId)}/close`, {});
  await refreshTerminalPtySessions();
  appendTerminalPtyOutput(`\n[closed] ${sessionId}\n`);
  return result;
};

const sendTerminalPtyInput = async (withNewline) => {
  const sessionId = readTerminalPtySessionId();
  if (!sessionId) {
    throw new Error("Select a terminal session first.");
  }
  const input = $("terminal-pty-input");
  const raw = String(input?.value || "");
  if (!raw.trim()) {
    return null;
  }
  const data = withNewline ? `${raw}\n` : raw;
  const result = await apiPost(`/api/terminal/sessions/${encodeURIComponent(sessionId)}/input`, {
    data,
  });
  if (input) {
    input.value = "";
  }
  return result;
};

const refreshCodeApprovals = async () => {
  const result = await apiGet("/api/code/approvals");
  state.codeApprovals = Array.isArray(result?.approvals) ? result.approvals : [];
  setText("code-approvals-output", result);
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
  const codex = state.integrations?.codex?.available ? "ready" : "missing";
  const claude = state.integrations?.claude?.sessionDetected ? "detected" : "missing";
  const livekit = state.integrations?.livekit?.configured ? "configured" : "off";
  node.textContent = [
    "milady cowork gateway",
    `route=${route} tasks=${running}/${queued} approvals=${approvals} watch=${watch}`,
    `codex=${codex} claude_session=${claude} livekit=${livekit}`,
    "slash: /status /help /new /compact /watch /terminal <command> /edit <path> /git status|diff",
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
  state.coworkMissions = Array.isArray(result?.missions) ? result.missions : [];
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
  const allowlist = Array.isArray(policy?.macControl?.appAllowlist) ? policy.macControl.appAllowlist : [];
  if ($("mac-allow-antigravity")) {
    $("mac-allow-antigravity").checked = allowlist.includes("antigravity");
  }
  if ($("mac-allow-terminal")) {
    $("mac-allow-terminal").checked = allowlist.includes("terminal");
  }
  if ($("mac-allow-chrome")) {
    $("mac-allow-chrome").checked = allowlist.includes("chrome");
  }
  const macAppSelect = $("mac-app-select");
  if (macAppSelect) {
    const current = macAppSelect.value;
    macAppSelect.innerHTML = "";
    (state.macApps || []).forEach((app) => {
      const option = document.createElement("option");
      option.value = app.id;
      option.textContent = `${app.id}${app.available ? "" : " (unavailable)"}`;
      option.disabled = !app.available;
      macAppSelect.appendChild(option);
    });
    const availableIds = (state.macApps || []).filter((app) => app.available).map((app) => app.id);
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
    (state.watchSources || []).forEach((source) => {
      const option = document.createElement("option");
      option.value = source.id;
      option.textContent = `${source.id}${source.available ? "" : " (unavailable)"}`;
      option.disabled = !source.available;
      watchSelect.appendChild(option);
    });
    const availableSourceIds = (state.watchSources || []).filter((source) => source.available).map((source) => source.id);
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
      "Commands: /status, /new, /reset, /compact, /watch, /terminal <command>, /edit <path>, /git status|diff, /help",
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

  if (command === "/terminal") {
    if (!args) {
      addCoworkMessage("system", "Usage: /terminal <command>");
      return true;
    }
    if ($("terminal-command")) {
      $("terminal-command").value = args;
    }
    const cwd = ($("terminal-cwd")?.value || "").trim();
    const result = await runEmbeddedTerminalCommand(args, cwd);
    addCoworkMessage("agent", `Terminal executed: ${args} (${result?.ok ? "ok" : "failed"})`);
    return true;
  }

  if (command === "/edit") {
    if (!args) {
      addCoworkMessage("system", "Usage: /edit <path>");
      return true;
    }
    const relPath = normalizeWorkbenchRelPath(args);
    if ($("workspace-file-path")) {
      $("workspace-file-path").value = relPath;
    }
    if ($("workspace-tree-path")) {
      $("workspace-tree-path").value = parentWorkbenchRelDir(relPath);
    }
    try {
      await refreshWorkspaceTree();
    } catch {
      // ignore tree refresh errors
    }
    const result = await loadWorkspaceFile(relPath);
    addCoworkMessage("agent", `Opened ${relPath} (${result?.ok ? "ok" : "failed"})`);
    return true;
  }

  if (command === "/git") {
    const parts = args.split(" ").map((part) => part.trim()).filter(Boolean);
    const sub = (parts[0] || "status").toLowerCase();
    if (sub === "status") {
      const result = await refreshGitStatus();
      const branch = result?.branch || "unknown";
      const changes = result?.changes || {};
      const stagedCount = Array.isArray(changes.staged) ? changes.staged.length : 0;
      const unstagedCount = Array.isArray(changes.unstaged) ? changes.unstaged.length : 0;
      const untrackedCount = Array.isArray(changes.untracked) ? changes.untracked.length : 0;
      addCoworkMessage("agent", `git status: ${branch} staged=${stagedCount} unstaged=${unstagedCount} untracked=${untrackedCount}`);
      return true;
    }
    if (sub === "diff") {
      const mode = (parts[1] || "").toLowerCase();
      const staged = mode === "staged";
      const pathArg = staged ? parts.slice(2).join(" ") : parts.slice(1).join(" ");
      if ($("git-diff-path")) {
        $("git-diff-path").value = pathArg;
      }
      const result = await refreshGitDiff(staged, pathArg);
      const diffText = typeof result?.diff === "string" ? result.diff : "";
      const snippet = diffText.trim() ? diffText.slice(0, 2200) : "(no diff)";
      addCoworkMessage("agent", `git diff ${staged ? "--staged" : ""} ${pathArg || ""}\n${snippet}`.trim());
      return true;
    }
    addCoworkMessage("system", "Usage: /git status | /git diff [staged] [path]");
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
  if ($("onb-code-extension-enabled")) {
    $("onb-code-extension-enabled").checked = Boolean(onboarding.extensions?.code?.enabled);
  }
  if ($("onb-code-extension-mode")) {
    $("onb-code-extension-mode").value = onboarding.extensions?.code?.mode || "manual";
  }
  if ($("onb-code-approval-write")) {
    $("onb-code-approval-write").checked = Boolean(onboarding.extensions?.code?.approvalRequiredForWrite);
  }
  if ($("onb-code-readonly-auto")) {
    $("onb-code-readonly-auto").checked = Boolean(onboarding.extensions?.code?.allowReadOnlyAutonomy);
  }
  if ($("onb-code-working-dir")) {
    $("onb-code-working-dir").value = onboarding.extensions?.code?.workingDirectory || "";
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
  if ($("onb-app-terminal")) {
    $("onb-app-terminal").checked = allowlist.includes("terminal");
  }
  if ($("onb-app-chrome")) {
    $("onb-app-chrome").checked = allowlist.includes("chrome");
  }
  const requireApprovalFor = Array.isArray(onboarding.macControl?.requireApprovalFor)
    ? onboarding.macControl.requireApprovalFor
    : [];
  if ($("onb-approval-terminal-exec")) {
    $("onb-approval-terminal-exec").checked = requireApprovalFor.includes("terminal_exec");
  }
  if ($("onb-approval-app-launch")) {
    $("onb-approval-app-launch").checked = requireApprovalFor.includes("app_launch");
  }
  if ($("onb-approval-codex-exec")) {
    $("onb-approval-codex-exec").checked = requireApprovalFor.includes("codex_exec");
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
  const derivedExamples = Array.isArray(derived.postExamples)
    ? derived.postExamples.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 20)
    : [];
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
        enabled: Boolean($("onb-code-extension-enabled")?.checked),
        mode: $("onb-code-extension-mode")?.value || "manual",
        approvalRequiredForWrite: Boolean($("onb-code-approval-write")?.checked),
        allowReadOnlyAutonomy: Boolean($("onb-code-readonly-auto")?.checked),
        workingDirectory: $("onb-code-working-dir")?.value?.trim() || undefined,
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
      appAllowlist: [
        $("onb-app-antigravity")?.checked ? "antigravity" : null,
        $("onb-app-terminal")?.checked ? "terminal" : null,
        $("onb-app-chrome")?.checked ? "chrome" : null,
      ].filter(Boolean),
      requireApprovalFor: [
        $("onb-approval-app-launch")?.checked ? "app_launch" : null,
        $("onb-approval-terminal-exec")?.checked ? "terminal_exec" : null,
        $("onb-approval-codex-exec")?.checked ? "codex_exec" : null,
        $("onb-approval-browser-external")?.checked ? "browser_external" : null,
        $("onb-approval-write-command")?.checked ? "write_command" : null,
      ].filter(Boolean),
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
      await refreshCodeStatus();
      await refreshCodeApprovals();
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
      if (command === "/terminal") {
        if ($("cowork-task-input")) {
          $("cowork-task-input").value = "/terminal ";
          $("cowork-task-input").focus();
        }
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

  $("cowork-quick-terminal")?.addEventListener("click", async () => {
    try {
      const result = await runCoworkQuickAction("open_terminal");
      addCoworkMessage("agent", `Queued quick action: open_terminal (${result?.task?.id || "task"})`);
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

  $("cowork-quick-codex")?.addEventListener("click", async () => {
    try {
      const result = await runCoworkQuickAction("run_codex");
      addCoworkMessage("agent", `Queued quick action: run_codex (${result?.task?.id || "task"})`);
    } catch (error) {
      setText("cowork-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("cowork-quick-claude")?.addEventListener("click", async () => {
    try {
      const result = await runCoworkQuickAction("run_claude");
      addCoworkMessage("agent", `Queued quick action: run_claude (${result?.task?.id || "task"})`);
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

  $("cowork-mission-coding")?.addEventListener("click", async () => {
    try {
      const seedPrompt = ($("cowork-mission-prompt")?.value || "").trim() || "Audit this repository and outline safe improvements.";
      const result = await apiPost("/api/agent/tasks/chain", {
        startTask: true,
        tasks: [
          {
            prompt: seedPrompt,
            skillId: "codex.run_task",
            args: {
              prompt: seedPrompt,
            },
          },
          {
            prompt: "Convert findings into a prioritized implementation sequence with guardrails.",
            skillId: "claude.run_task",
            args: {
              prompt: "Convert findings into a prioritized implementation sequence with guardrails.",
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
      addCoworkMessage("agent", `Coding mission chain queued (${result?.chain?.length || 0} tasks).`);
    } catch (error) {
      setText("cowork-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("code-plan-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const task = ($("code-plan-task")?.value || "").trim();
    if (!task) {
      setText("code-plan-output", "Task is required.");
      return;
    }
    try {
      setText("code-plan-output", "Generating coding plan...");
      const result = await apiPost("/api/code/plan", {
        task,
      });
      setText("code-plan-output", result);
      addCoworkMessage("agent", result?.plan || "Coding plan generated.");
      logActivity("Code plan generated", {
        task,
        provider: result?.provider,
      });
    } catch (error) {
      setText("code-plan-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("code-exec-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const command = ($("code-exec-command")?.value || "").trim();
    const cwd = ($("code-exec-cwd")?.value || "").trim();
    if (!command) {
      setText("code-exec-output", "Command is required.");
      return;
    }
    try {
      setText("code-exec-output", "Running command...");
      const result = await apiPost("/api/code/exec", {
        command,
        cwd: cwd || undefined,
      });
      setText("code-exec-output", result);
      await refreshCodeStatus();
      await refreshCodeApprovals();
      await refreshTerminalSessions();
      if (result?.session?.id) {
        await loadTerminalSession(result.session.id);
      }
      logActivity("Code command executed", {
        command,
        ok: result?.ok,
        approvalId: result?.approvalId || null,
      });
    } catch (error) {
      setText("code-exec-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("code-status-refresh")?.addEventListener("click", async () => {
    try {
      await refreshCodeStatus();
      await refreshCodeApprovals();
    } catch (error) {
      setText("code-status-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("code-approvals-refresh")?.addEventListener("click", async () => {
    try {
      await refreshCodeApprovals();
    } catch (error) {
      setText("code-approvals-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("code-approval-approve")?.addEventListener("click", async () => {
    const id = ($("code-approval-id")?.value || "").trim();
    if (!id) {
      setText("code-approvals-output", "Code approval ID is required.");
      return;
    }
    try {
      const result = await apiPost(`/api/code/approvals/${encodeURIComponent(id)}/approve`, {});
      setText("code-approvals-output", result);
      if (result?.result) {
        setText("code-exec-output", result.result);
      }
      await refreshCodeStatus();
      await refreshCodeApprovals();
      await refreshTerminalSessions();
      if (result?.result?.session?.id) {
        await loadTerminalSession(result.result.session.id);
      }
      logActivity("Code approval executed", { id, ok: result?.ok });
    } catch (error) {
      setText("code-approvals-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("code-approval-reject")?.addEventListener("click", async () => {
    const id = ($("code-approval-id")?.value || "").trim();
    if (!id) {
      setText("code-approvals-output", "Code approval ID is required.");
      return;
    }
    try {
      const result = await apiPost(`/api/code/approvals/${encodeURIComponent(id)}/reject`, {});
      setText("code-approvals-output", result);
      await refreshCodeStatus();
      await refreshCodeApprovals();
      logActivity("Code approval rejected", { id, ok: result?.ok });
    } catch (error) {
      setText("code-approvals-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("terminal-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const command = ($("terminal-command")?.value || "").trim();
    const cwd = ($("terminal-cwd")?.value || "").trim();
    if (!command) {
      setText("terminal-output", "Command is required.");
      return;
    }
    try {
      await runEmbeddedTerminalCommand(command, cwd);
      addCoworkMessage("agent", `Terminal command queued: ${command}`);
    } catch (error) {
      setText("terminal-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("terminal-refresh")?.addEventListener("click", async () => {
    try {
      await refreshTerminalSessions();
      if (state.terminalActiveSessionId) {
        await loadTerminalSession(state.terminalActiveSessionId);
      }
    } catch (error) {
      setText("terminal-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("terminal-load")?.addEventListener("click", async () => {
    const selected = ($("terminal-session-select")?.value || "").trim() || state.terminalActiveSessionId;
    try {
      await loadTerminalSession(selected);
    } catch (error) {
      setText("terminal-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("terminal-clear")?.addEventListener("click", () => {
    setText("terminal-output", "");
  });

  $("terminal-session-select")?.addEventListener("change", async () => {
    const selected = ($("terminal-session-select")?.value || "").trim();
    state.terminalActiveSessionId = selected;
    if (!selected) {
      return;
    }
    try {
      await loadTerminalSession(selected);
    } catch (error) {
      setText("terminal-output", error instanceof Error ? error.message : String(error));
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

  $("integration-open-terminal")?.addEventListener("click", async () => {
    try {
      await runIntegrationAppOpen("terminal");
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

  $("integration-claude-login")?.addEventListener("click", async () => {
    try {
      const result = await apiPost("/api/claude/login/start", {});
      setText("integrations-output", result);
      await refreshProviderStatus();
      await refreshIntegrations();
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
      await refreshCodeStatus();
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

  $("ext-code-enable")?.addEventListener("click", async () => {
    try {
      const result = await apiPost("/api/extensions/code-workspace/enable", {});
      setText("extensions-output", result);
      await refreshExtensions();
      await refreshCodeStatus();
      logActivity("Enabled code-workspace extension", result);
    } catch (error) {
      setText("extensions-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("ext-code-disable")?.addEventListener("click", async () => {
    try {
      const result = await apiPost("/api/extensions/code-workspace/disable", {});
      setText("extensions-output", result);
      await refreshExtensions();
      await refreshCodeStatus();
      logActivity("Disabled code-workspace extension", result);
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
        $("mac-allow-terminal")?.checked ? "terminal" : null,
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

  $("workspace-tree-refresh")?.addEventListener("click", async () => {
    try {
      await refreshWorkspaceTree();
    } catch (error) {
      setText("workspace-file-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("workspace-tree-up")?.addEventListener("click", async () => {
    try {
      const current = $("workspace-tree-path")?.value || "";
      const next = parentWorkbenchRelDir(current);
      if ($("workspace-tree-path")) {
        $("workspace-tree-path").value = next;
      }
      await refreshWorkspaceTree();
    } catch (error) {
      setText("workspace-file-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("workspace-tree")?.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const relPath = (target.dataset.workspacePath || "").trim();
    const type = (target.dataset.workspaceType || "").trim();
    if (!relPath || !type) {
      return;
    }
    if (type === "dir") {
      if ($("workspace-tree-path")) {
        $("workspace-tree-path").value = relPath;
      }
      try {
        await refreshWorkspaceTree();
      } catch (error) {
        setText("workspace-file-output", error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if ($("workspace-file-path")) {
      $("workspace-file-path").value = relPath;
    }
    try {
      await loadWorkspaceFile(relPath);
    } catch (error) {
      setText("workspace-file-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("workspace-file-load")?.addEventListener("click", async () => {
    try {
      await loadWorkspaceFile();
    } catch (error) {
      setText("workspace-file-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("workspace-file-dryrun")?.addEventListener("click", async () => {
    try {
      await dryRunWorkspaceSave();
    } catch (error) {
      setText("workspace-file-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("workspace-file-save")?.addEventListener("click", async () => {
    try {
      await executeWorkspaceSave();
    } catch (error) {
      setText("workspace-file-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("git-refresh")?.addEventListener("click", async () => {
    try {
      await refreshGitStatus();
    } catch (error) {
      setText("git-status-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("git-log")?.addEventListener("click", async () => {
    try {
      await refreshGitLog();
    } catch (error) {
      setText("git-action-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("git-diff-unstaged")?.addEventListener("click", async () => {
    try {
      await refreshGitDiff(false);
    } catch (error) {
      setText("git-diff-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("git-diff-staged")?.addEventListener("click", async () => {
    try {
      await refreshGitDiff(true);
    } catch (error) {
      setText("git-diff-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("git-branch-dryrun")?.addEventListener("click", async () => {
    try {
      await dryRunGitAction("create_branch");
    } catch (error) {
      setText("git-action-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("git-branch-exec")?.addEventListener("click", async () => {
    try {
      await executeGitAction("create_branch");
    } catch (error) {
      setText("git-action-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("git-commit-dryrun")?.addEventListener("click", async () => {
    try {
      await dryRunGitAction("commit");
    } catch (error) {
      setText("git-action-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("git-commit-exec")?.addEventListener("click", async () => {
    try {
      await executeGitAction("commit");
    } catch (error) {
      setText("git-action-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("git-push-dryrun")?.addEventListener("click", async () => {
    try {
      await dryRunGitAction("push");
    } catch (error) {
      setText("git-action-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("git-push-exec")?.addEventListener("click", async () => {
    try {
      await executeGitAction("push");
    } catch (error) {
      setText("git-action-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("terminal-pty-refresh")?.addEventListener("click", async () => {
    try {
      await refreshTerminalPtySessions();
    } catch (error) {
      setText("terminal-pty-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("terminal-pty-create")?.addEventListener("click", async () => {
    try {
      await createTerminalPtySession();
    } catch (error) {
      setText("terminal-pty-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("terminal-pty-close")?.addEventListener("click", async () => {
    try {
      await closeTerminalPtySession();
    } catch (error) {
      setText("terminal-pty-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("terminal-pty-connect")?.addEventListener("click", () => {
    connectTerminalPtyWs();
  });

  $("terminal-pty-disconnect")?.addEventListener("click", () => {
    disconnectTerminalPtyWs();
  });

  $("terminal-pty-send")?.addEventListener("click", async () => {
    try {
      await sendTerminalPtyInput(false);
    } catch (error) {
      setText("terminal-pty-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("terminal-pty-sendline")?.addEventListener("click", async () => {
    try {
      await sendTerminalPtyInput(true);
    } catch (error) {
      setText("terminal-pty-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("terminal-pty-input")?.addEventListener("keydown", async (event) => {
    if (!(event instanceof KeyboardEvent)) {
      return;
    }
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    try {
      await sendTerminalPtyInput(true);
    } catch (error) {
      setText("terminal-pty-output", error instanceof Error ? error.message : String(error));
    }
  });
};

const boot = async () => {
  state.history = loadHistory();
  state.coworkMessages = loadCoworkMessages();
  renderHistory();
  renderCoworkChat();
  renderCoworkConversations();
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
  await refreshCodeStatus();
  await refreshCodeApprovals();
  await refreshTerminalSessions();
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
  try {
    await refreshWorkspaceTree();
  } catch {
    // ignore workbench init errors
  }
  try {
    await refreshGitStatus();
  } catch {
    // ignore workbench init errors
  }
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
        refreshTerminalSessions(),
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
