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
    item.className = "cowork-msg";
    const role = String(message.role || "agent");
    const title = role === "user" ? "You" : role === "agent" ? "Agent" : "System";
    item.innerHTML = `<strong>${title}</strong>${String(message.text || "").replace(/</g, "&lt;")}`;
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
  setText("provider-status-output", result);
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

const refreshCoworkState = async () => {
  const result = await apiGet("/api/cowork/state");
  state.coworkState = result || null;
  renderCoworkMetrics();
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
  return {
    apps,
    policy,
    watch,
  };
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
    iframe.setAttribute("src", `${current.split("?")[0]}?t=${Date.now()}`);
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
    } catch (error) {
      setText("provider-status-output", error instanceof Error ? error.message : String(error));
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
    if (!id) {
      setText("tasks-output", "Task ID is required.");
      return;
    }
    try {
      const result = await apiPost("/api/watch/start", {
        sourceId,
        taskId: id,
      });
      setText("mac-policy-output", result);
      if ($("watch-session-id") && result?.session?.id) {
        $("watch-session-id").value = result.session.id;
      }
      await refreshMacApps();
      await refreshCoworkState();
      if ($("cowork-log-task-select")) {
        $("cowork-log-task-select").value = id;
      }
      await refreshTaskLogTail();
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
        const result = await apiPost("/api/watch/start", {
          sourceId,
          taskId,
        });
        setText("mac-policy-output", result);
        if ($("watch-session-id") && result?.session?.id) {
          $("watch-session-id").value = result.session.id;
        }
        await refreshMacApps();
        await refreshCoworkState();
        await refreshTaskLogTail();
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
    if (!sourceId) {
      setText("mac-policy-output", "Watch source is required.");
      return;
    }
    try {
      const result = await apiPost("/api/watch/start", {
        sourceId,
        taskId: taskId || undefined,
      });
      setText("mac-policy-output", result);
      if ($("watch-session-id") && result?.session?.id) {
        $("watch-session-id").value = result.session.id;
      }
      await refreshMacApps();
    } catch (error) {
      setText("mac-policy-output", error instanceof Error ? error.message : String(error));
    }
  });

  $("watch-stop")?.addEventListener("click", async () => {
    const sessionId = ($("watch-session-id")?.value || "").trim();
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
    } catch (error) {
      setText("mac-policy-output", error instanceof Error ? error.message : String(error));
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
  await refreshSkills();
  await refreshTasks();
  await refreshCoworkState();
  await refreshCoworkMissions();
  await refreshMacApps();
  await refreshTaskLogTail();
  setInterval(async () => {
    try {
      await Promise.all([refreshTasks(), refreshApprovals(), refreshCoworkState(), refreshTaskLogTail()]);
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
