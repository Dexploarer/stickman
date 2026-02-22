const { app, BrowserWindow, ipcMain, shell, Menu, Tray, nativeImage, Notification } = require("electron");
const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const projectRoot = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 8787);
const appUrl = process.env.POD_APP_URL || `http://127.0.0.1:${port}`;
const shouldStartServer = process.env.POD_ELECTRON_START_SERVER !== "false";
const ELECTRON_DOCS_URL = "https://www.electronjs.org/docs/latest/tutorial/examples";

const DEFAULT_DESKTOP_PREFERENCES = Object.freeze({
  titleBarOverlayMode: "auto",
  backgroundModeEnabled: true,
  notificationsEnabled: true,
});

const DESKTOP_COMMANDS = [
  { id: "palette.open", label: "Open Command Palette", accelerator: "CmdOrCtrl+Shift+P", keywords: ["palette", "search", "command"] },
  { id: "app.new_thread", label: "New Thread", accelerator: "CmdOrCtrl+N", keywords: ["new", "thread"] },
  { id: "run.refresh_status", label: "Refresh Status", accelerator: "CmdOrCtrl+Shift+R", keywords: ["refresh", "status"] },
  { id: "run.heartbeat", label: "Run Heartbeat", accelerator: "CmdOrCtrl+Shift+H", keywords: ["heartbeat", "status"] },
  { id: "context.send", label: "Send Context", accelerator: "CmdOrCtrl+Shift+K", keywords: ["context", "capture"] },
  { id: "watch.active", label: "Watch Active Task", accelerator: "CmdOrCtrl+Shift+W", keywords: ["watch", "task"] },
  { id: "quick.open_antigravity", label: "Open Antigravity", keywords: ["antigravity", "quick"] },
  { id: "quick.open_chrome", label: "Open Chrome", keywords: ["chrome", "quick"] },
  { id: "run.social_mission", label: "Run Social Mission", keywords: ["social", "mission"] },
  { id: "run.plan", label: "Generate Plan", keywords: ["plan", "workflow"] },
  { id: "run.workflow", label: "Run Workflow", keywords: ["workflow", "execute"] },
  { id: "run.ai_chat", label: "Run AI Chat", keywords: ["ai", "chat"] },
  { id: "run.ai_image", label: "Generate Image", keywords: ["image", "ai"] },
  { id: "run.x_algo", label: "Run X Algo", keywords: ["x", "algo", "signal"] },
  { id: "tweet.generate", label: "Draft Tweet", keywords: ["tweet", "draft"] },
  { id: "tweet.post", label: "Post Tweet", keywords: ["tweet", "post"] },
  { id: "integration.dry_run", label: "Integration Dry Run", keywords: ["integration", "dry"] },
  { id: "integration.execute", label: "Integration Execute", keywords: ["integration", "execute"] },
  { id: "view.toggle_workbench", label: "Toggle Workbench", accelerator: "CmdOrCtrl+Shift+B", keywords: ["workbench", "layout", "dashboard"] },
  { id: "view.open_onboarding", label: "Open Onboarding", keywords: ["onboarding", "settings"] },
  { id: "help.electron_docs", label: "Electron UI Examples", keywords: ["docs", "electron"] },
  { id: "window.show", label: "Show Dashboard", accelerator: "CmdOrCtrl+Shift+O", keywords: ["show", "dashboard", "focus"] },
  { id: "app.quit", label: "Quit", accelerator: "CmdOrCtrl+Q", keywords: ["quit", "exit"] },
];

const DESKTOP_COMMAND_LOOKUP = new Map(DESKTOP_COMMANDS.map((entry) => [entry.id, entry]));

let mainWindow = null;
let tray = null;
let serverProcess = null;
let inProcessServerStarted = false;
let desktopPreferences = { ...DEFAULT_DESKTOP_PREFERENCES };
let traySummary = { running: 0, approvals: 0, watch: 0 };
let traySummaryTimer = null;
let traySummaryRefreshTimer = null;

let liveBridgeEnabled = false;
let liveBridgeRequest = null;
let liveBridgeResponse = null;
let liveBridgeReconnectTimer = null;
let liveBridgeBuffer = "";
let liveBridgeReady = false;
const liveBridgeSeenIds = [];
const LIVE_SEEN_LIMIT = 600;

const CONTEXT_ACTION_ALLOWLIST = new Set([
  "post.append_to_composer",
  "post.replace_composer",
  "post.build_thread_outline",
  "tools.prefill_planner_goal",
  "tools.prefill_mission_query",
  "tools.prefill_command_studio",
  "knowledge.capture",
  "chat.prefill_prompt",
]);

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

const normalizeContextSourcePayload = (payload) => ({
  selectionText: toSafeString(payload?.selectionText).trim(),
  linkURL: toSafeString(payload?.linkURL, 2000).trim(),
  pageURL: toSafeString(payload?.pageURL, 2000).trim(),
  isEditable: Boolean(payload?.isEditable),
  mediaType: toSafeString(payload?.mediaType, 80).trim(),
  x: toSafeNumber(payload?.x),
  y: toSafeNumber(payload?.y),
  ts: toSafeNumber(payload?.ts, Date.now()),
  sourceHint: toSafeString(payload?.sourceHint, 80).trim() || "desktop",
});

const sanitizePayloadObject = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const entries = Object.entries(value).slice(0, 60);
  const output = {};
  for (const [key, raw] of entries) {
    if (!key || typeof key !== "string") {
      continue;
    }
    if (typeof raw === "string") {
      output[key] = raw.slice(0, 3000);
      continue;
    }
    if (typeof raw === "number" || typeof raw === "boolean" || raw === null) {
      output[key] = raw;
      continue;
    }
    try {
      output[key] = JSON.parse(JSON.stringify(raw));
    } catch {
      output[key] = toSafeString(String(raw), 3000);
    }
  }
  return output;
};

const isAllowedContextAction = (actionId) => CONTEXT_ACTION_ALLOWLIST.has(String(actionId || "").trim());

const normalizeTitleBarOverlayMode = (value) => {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "on" || mode === "off" || mode === "auto") {
    return mode;
  }
  return DEFAULT_DESKTOP_PREFERENCES.titleBarOverlayMode;
};

const normalizeDesktopPreferencesPatch = (patch) => {
  const next = {};
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return next;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "titleBarOverlayMode")) {
    next.titleBarOverlayMode = normalizeTitleBarOverlayMode(patch.titleBarOverlayMode);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "backgroundModeEnabled")) {
    next.backgroundModeEnabled = Boolean(patch.backgroundModeEnabled);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "notificationsEnabled")) {
    next.notificationsEnabled = Boolean(patch.notificationsEnabled);
  }
  return next;
};

const resolveTitleBarOverlayEnabled = (prefs = desktopPreferences) => {
  const mode = normalizeTitleBarOverlayMode(prefs?.titleBarOverlayMode);
  if (mode === "on") {
    return true;
  }
  if (mode === "off") {
    return false;
  }
  return process.platform !== "darwin";
};

const resolveDesktopPreferencesPath = () => path.join(app.getPath("userData"), "desktop-preferences.json");

const loadDesktopPreferences = () => {
  const filePath = resolveDesktopPreferencesPath();
  let parsed = {};
  try {
    if (existsSync(filePath)) {
      parsed = JSON.parse(readFileSync(filePath, "utf8"));
    }
  } catch {
    parsed = {};
  }
  const merged = {
    ...DEFAULT_DESKTOP_PREFERENCES,
    ...normalizeDesktopPreferencesPatch(parsed),
  };
  desktopPreferences = merged;
  return merged;
};

const saveDesktopPreferences = () => {
  const filePath = resolveDesktopPreferencesPath();
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(desktopPreferences, null, 2)}\n`, "utf8");
  } catch (error) {
    console.warn(`[electron] unable to persist desktop preferences: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const applyDesktopPreferences = (patch) => {
  const normalizedPatch = normalizeDesktopPreferencesPatch(patch);
  desktopPreferences = {
    ...desktopPreferences,
    ...normalizedPatch,
  };
  saveDesktopPreferences();
  rebuildApplicationMenu();
  updateTrayContextMenu();
  sendDesktopCapabilities();
  sendDesktopPreferences();
  return { ...desktopPreferences };
};

const resolveDesktopCapabilities = () => ({
  nativeContextMenu: true,
  nativeMenus: true,
  commandPalette: true,
  tray: true,
  backgroundMode: Boolean(desktopPreferences.backgroundModeEnabled),
  notifications: Boolean(Notification?.isSupported?.() && desktopPreferences.notificationsEnabled),
  titleBarOverlay: resolveTitleBarOverlayEnabled(desktopPreferences),
  platform: process.platform,
});

const getPublicDesktopCommands = () =>
  DESKTOP_COMMANDS.map((entry) => ({
    id: entry.id,
    label: entry.label,
    accelerator: entry.accelerator || "",
    keywords: Array.isArray(entry.keywords) ? [...entry.keywords] : [],
  }));

const sendToRenderer = (channel, payload) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }
  mainWindow.webContents.send(channel, payload);
  return true;
};

const sendDesktopCapabilities = () => {
  sendToRenderer("pod:desktop-capabilities", resolveDesktopCapabilities());
};

const sendDesktopPreferences = () => {
  sendToRenderer("pod:desktop-preferences", { ...desktopPreferences });
};

const focusMainWindow = () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
};

const dispatchContextAction = (targetWindow, actionId, payload) => {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return false;
  }
  if (!isAllowedContextAction(actionId)) {
    return false;
  }
  const context = normalizeContextSourcePayload(payload);
  targetWindow.webContents.send("pod:context-action", {
    actionId,
    context,
  });
  return true;
};

const buildNativeContextMenu = (targetWindow, params) => {
  const context = normalizeContextSourcePayload({
    selectionText: params?.selectionText,
    linkURL: params?.linkURL,
    pageURL: params?.pageURL,
    isEditable: params?.isEditable,
    mediaType: params?.mediaType,
    x: params?.x,
    y: params?.y,
    ts: Date.now(),
    sourceHint: "electron-native-context-menu",
  });
  const hasSelection = context.selectionText.length > 0;
  const hasLink = context.linkURL.length > 0;
  const hasAnyContext = hasSelection || hasLink || context.pageURL.length > 0;
  const template = [];

  if (hasAnyContext) {
    template.push({
      label: "Post",
      submenu: [
        {
          label: "Append to Composer",
          enabled: hasSelection,
          click: () => dispatchContextAction(targetWindow, "post.append_to_composer", context),
        },
        {
          label: "Replace Composer Draft",
          enabled: hasSelection,
          click: () => dispatchContextAction(targetWindow, "post.replace_composer", context),
        },
        {
          label: "Build Thread Outline",
          enabled: hasSelection || hasLink,
          click: () => dispatchContextAction(targetWindow, "post.build_thread_outline", context),
        },
      ],
    });
    template.push({
      label: "Context",
      submenu: [
        {
          label: "Prefill Chat Prompt",
          enabled: hasSelection || hasLink,
          click: () => dispatchContextAction(targetWindow, "chat.prefill_prompt", context),
        },
      ],
    });
    template.push({
      label: "Tools",
      submenu: [
        {
          label: "Prefill Planner Goal",
          enabled: hasSelection || hasLink,
          click: () => dispatchContextAction(targetWindow, "tools.prefill_planner_goal", context),
        },
        {
          label: "Prefill Mission Query",
          enabled: hasSelection || hasLink,
          click: () => dispatchContextAction(targetWindow, "tools.prefill_mission_query", context),
        },
        {
          label: "Prefill Command Studio",
          enabled: hasSelection || hasLink,
          click: () => dispatchContextAction(targetWindow, "tools.prefill_command_studio", context),
        },
      ],
    });
    template.push({
      label: "Knowledge",
      submenu: [
        {
          label: hasLink && !hasSelection ? "Capture Link to Inbox" : "Capture Context to Inbox",
          enabled: hasSelection || hasLink,
          click: () => dispatchContextAction(targetWindow, "knowledge.capture", context),
        },
      ],
    });
    template.push({ type: "separator" });
  }

  if (context.isEditable) {
    template.push(
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    );
  } else {
    template.push(
      { role: "copy", enabled: hasSelection },
      { role: "selectAll" },
    );
  }

  if (!template.length) {
    return null;
  }

  targetWindow.webContents.send("pod:context-menu:opened", {
    nativeContextMenu: true,
    context,
    actionIds: [...CONTEXT_ACTION_ALLOWLIST],
  });

  return Menu.buildFromTemplate(template);
};

const waitForServer = (url, timeoutMs = 60_000) =>
  new Promise((resolve, reject) => {
    const start = Date.now();

    const check = () => {
      const request = http.get(url, (response) => {
        response.resume();
        resolve();
      });

      request.on("error", () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timed out waiting for local server at ${url}`));
          return;
        }
        setTimeout(check, 500);
      });

      request.setTimeout(2_000, () => {
        request.destroy();
      });
    };

    check();
  });

const isLocalPortInUse = (portToCheck, host = "127.0.0.1", timeoutMs = 500) =>
  new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finalize = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore socket cleanup errors
      }
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finalize(true));
    socket.once("timeout", () => finalize(false));
    socket.once("error", (error) => {
      const code = typeof error?.code === "string" ? error.code : "";
      if (code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
        finalize(false);
        return;
      }
      finalize(true);
    });

    try {
      socket.connect(portToCheck, host);
    } catch {
      finalize(false);
    }
  });

const resolveBundledServerEntry = () => {
  const appPath = app.getAppPath();
  const candidates = [
    path.join(projectRoot, "dist", "server.js"),
    path.join(appPath, "dist", "server.js"),
    path.join(process.resourcesPath, "app", "dist", "server.js"),
    path.join(process.resourcesPath, "app.asar", "dist", "server.js"),
    path.join(process.resourcesPath, "dist", "server.js"),
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // ignore candidate lookup errors
    }
  }
  return null;
};

const startBundledServerInProcess = async () => {
  if (inProcessServerStarted) {
    return true;
  }
  const serverEntry = resolveBundledServerEntry();
  if (!serverEntry) {
    console.warn("[electron] unable to locate bundled server entry (dist/server.js).");
    return false;
  }
  try {
    await import(pathToFileURL(serverEntry).href);
    inProcessServerStarted = true;
    return true;
  } catch (error) {
    console.error(`[electron] failed to boot bundled server from ${serverEntry}:`, error);
    return false;
  }
};

const startServer = async () => {
  if (!shouldStartServer || serverProcess || inProcessServerStarted) {
    return shouldStartServer;
  }

  const env = {
    ...process.env,
    PORT: String(port),
  };

  const customCommand = String(process.env.POD_SERVER_COMMAND || "").trim();
  if (customCommand) {
    serverProcess = spawn(customCommand, {
      cwd: projectRoot,
      env,
      stdio: "inherit",
      shell: true,
    });
    serverProcess.on("error", (error) => {
      console.error(`[electron] failed to start custom server command: ${error?.message || String(error)}`);
      serverProcess = null;
    });
    serverProcess.on("exit", (code, signal) => {
      if (!app.isQuitting) {
        console.warn(`[electron] local server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`);
      }
      serverProcess = null;
    });
    return true;
  }

  if (app.isPackaged) {
    const started = await startBundledServerInProcess();
    if (!started) {
      console.warn("[electron] packaged app could not start embedded server.");
    }
    return started;
  }

  const portInUse = await isLocalPortInUse(port);
  if (portInUse) {
    let reachable = false;
    try {
      await waitForServer(appUrl, 2_500);
      reachable = true;
    } catch {
      reachable = false;
    }
    if (reachable) {
      console.warn(
        `[electron] startup guard: port ${port} is already in use. Skipping local Bun server spawn and attaching to ${appUrl}.`,
      );
    } else {
      console.warn(
        `[electron] startup guard: port ${port} is already in use, and ${appUrl} did not respond to HTTP checks. Stop the conflicting process or run with PORT=<free-port>.`,
      );
    }
    return false;
  }

  serverProcess = spawn("bun", ["src/server.ts"], {
    cwd: projectRoot,
    env,
    stdio: "inherit",
    shell: false,
  });

  serverProcess.on("error", (error) => {
    const message = error?.message || String(error);
    if (error?.code === "ENOENT") {
      console.error("[electron] Bun executable not found. Install Bun or set POD_SERVER_COMMAND.");
    }
    console.error(`[electron] failed to start local server: ${message}`);
    serverProcess = null;
  });

  serverProcess.on("exit", (code, signal) => {
    if (!app.isQuitting) {
      console.warn(`[electron] local server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`);
    }
    serverProcess = null;
  });

  return true;
};

const stopServer = () => {
  if (!serverProcess) {
    return;
  }
  try {
    serverProcess.kill("SIGTERM");
  } catch {
    // ignore shutdown errors
  }
  serverProcess = null;
};

const requestJson = (method, endpoint, body, timeoutMs = 9_000) =>
  new Promise((resolve, reject) => {
    let target;
    try {
      target = endpoint instanceof URL ? endpoint : new URL(endpoint, appUrl);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const transport = target.protocol === "https:" ? https : http;
    const payload = body === undefined ? "" : JSON.stringify(body);
    const request = transport.request(
      target,
      {
        method,
        headers: {
          Accept: "application/json",
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          const statusCode = Number(response.statusCode || 0);
          let parsed = text;
          if (text) {
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = text;
            }
          }
          if (statusCode >= 200 && statusCode < 300) {
            resolve(parsed || {});
            return;
          }
          reject(new Error(typeof parsed === "string" ? parsed : JSON.stringify(parsed)));
        });
      },
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("Request timed out."));
    });

    request.on("error", (error) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    });

    if (payload) {
      request.write(payload);
    }
    request.end();
  });

const queueTraySummaryRefresh = (delayMs = 1_200) => {
  if (!tray) {
    return;
  }
  if (traySummaryRefreshTimer) {
    clearTimeout(traySummaryRefreshTimer);
  }
  traySummaryRefreshTimer = setTimeout(() => {
    traySummaryRefreshTimer = null;
    void refreshTraySummary();
  }, Math.max(100, delayMs));
};

const updateTrayTooltip = () => {
  if (!tray) {
    return;
  }
  tray.setToolTip(
    `Prompt or Die Social Suite • tasks:${traySummary.running} approvals:${traySummary.approvals} watch:${traySummary.watch}`,
  );
};

const invokeDesktopCommand = (commandId, payload = {}) => {
  const normalizedId = String(commandId || "").trim();
  if (!DESKTOP_COMMAND_LOOKUP.has(normalizedId)) {
    return false;
  }

  if (normalizedId === "window.show") {
    focusMainWindow();
    return true;
  }

  if (normalizedId === "app.quit") {
    app.isQuitting = true;
    app.quit();
    return true;
  }

  const sent = sendToRenderer("pod:desktop-command", {
    commandId: normalizedId,
    payload: sanitizePayloadObject(payload),
    ts: Date.now(),
  });

  if (!sent) {
    if (normalizedId === "help.electron_docs") {
      void shell.openExternal(ELECTRON_DOCS_URL);
      return true;
    }
    return false;
  }

  return true;
};

const commandItem = (commandId, overrides = {}) => {
  const command = DESKTOP_COMMAND_LOOKUP.get(commandId);
  if (!command) {
    return null;
  }
  return {
    label: overrides.label || command.label,
    accelerator: overrides.accelerator !== undefined ? overrides.accelerator : command.accelerator,
    click: () => {
      invokeDesktopCommand(commandId, overrides.payload || {});
    },
  };
};

const updateTrayContextMenu = () => {
  if (!tray) {
    return;
  }

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: `Tasks ${traySummary.running} • Approvals ${traySummary.approvals} • Watch ${traySummary.watch}`,
        enabled: false,
      },
      { type: "separator" },
      {
        label: "Show Dashboard",
        click: () => invokeDesktopCommand("window.show"),
      },
      {
        label: "Run Heartbeat",
        click: () => invokeDesktopCommand("run.heartbeat"),
      },
      {
        label: "Open Antigravity",
        click: () => invokeDesktopCommand("quick.open_antigravity"),
      },
      {
        label: "Open Chrome",
        click: () => invokeDesktopCommand("quick.open_chrome"),
      },
      {
        label: "Watch Active Task",
        click: () => invokeDesktopCommand("watch.active"),
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => invokeDesktopCommand("app.quit"),
      },
    ]),
  );
  updateTrayTooltip();
};

const refreshTraySummary = async () => {
  if (!tray) {
    return;
  }
  try {
    const result = await requestJson("GET", "/api/cowork/state");
    const summary = result?.summary || {};
    traySummary = {
      running: Number(summary?.tasks?.running || 0),
      approvals: Number(summary?.approvals?.total || 0),
      watch: Number(summary?.watch?.active || 0),
    };
    updateTrayContextMenu();
  } catch {
    updateTrayTooltip();
  }
};

const createTrayIcon = () => {
  const candidates = [
    path.join(projectRoot, "electron", "trayTemplate.png"),
    path.join(projectRoot, "electron", "tray.png"),
    path.join(projectRoot, "build", "trayTemplate.png"),
    path.join(projectRoot, "build", "icon.png"),
  ];

  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) {
        continue;
      }
      const image = nativeImage.createFromPath(candidate);
      if (!image.isEmpty()) {
        return image;
      }
    } catch {
      // ignore path failures
    }
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?><svg width="64" height="64" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="14" fill="#0F2429"/><path d="M32 14L38 26L50 32L38 38L32 50L26 38L14 32L26 26L32 14Z" fill="#5FD1FF"/></svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
};

const createSystemTray = () => {
  if (tray) {
    return;
  }
  tray = new Tray(createTrayIcon());
  tray.on("click", () => {
    invokeDesktopCommand("window.show");
  });
  updateTrayContextMenu();
  void refreshTraySummary();

  if (traySummaryTimer) {
    clearInterval(traySummaryTimer);
  }
  traySummaryTimer = setInterval(() => {
    void refreshTraySummary();
  }, 20_000);
};

const destroySystemTray = () => {
  if (traySummaryTimer) {
    clearInterval(traySummaryTimer);
    traySummaryTimer = null;
  }
  if (traySummaryRefreshTimer) {
    clearTimeout(traySummaryRefreshTimer);
    traySummaryRefreshTimer = null;
  }
  if (!tray) {
    return;
  }
  tray.destroy();
  tray = null;
};

const showDesktopNotification = ({ title, body, commandId, payload }) => {
  if (!desktopPreferences.notificationsEnabled) {
    return;
  }
  if (!Notification?.isSupported?.()) {
    return;
  }
  try {
    const notification = new Notification({
      title: toSafeString(title, 140) || "Prompt or Die Social Suite",
      body: toSafeString(body, 280),
    });
    notification.on("click", () => {
      focusMainWindow();
      if (commandId) {
        invokeDesktopCommand(commandId, payload || {});
      }
    });
    notification.show();
  } catch {
    // notification failures should not break desktop shell
  }
};

const buildLiveEventNotification = (eventRecord) => {
  const type = String(eventRecord?.type || "").trim();
  const payload = eventRecord?.payload && typeof eventRecord.payload === "object" ? eventRecord.payload : {};

  if (type === "approval_queued" || type === "code_approval_queued" || type === "skill_approval_queued") {
    const approvalId = toSafeString(payload.approvalId || "", 120);
    const reason = toSafeString(payload.reason || "Manual approval required", 180);
    return {
      title: "Approval Required",
      body: approvalId ? `${reason} (${approvalId})` : reason,
      commandId: "window.show",
      payload: { route: "approvals", approvalId },
    };
  }

  if (type === "task_state") {
    const status = String(payload.status || "").trim().toLowerCase();
    if (status !== "completed" && status !== "failed" && status !== "cancelled") {
      return null;
    }
    const taskId = toSafeString(payload.taskId || "", 120);
    const baseTitle =
      status === "completed" ? "Task Completed" : status === "failed" ? "Task Failed" : "Task Cancelled";
    const detail = status === "failed" ? toSafeString(payload.error || payload.message || "See task log for details.", 200) : "";
    return {
      title: baseTitle,
      body: taskId ? `${taskId}${detail ? ` • ${detail}` : ""}` : detail || "Task update available.",
      commandId: "window.show",
      payload: { route: "tasks", taskId },
    };
  }

  if (type === "watch_session_started" || type === "watch_session_stopped") {
    const watchSessionId = toSafeString(payload.watchSessionId || "", 120);
    const sourceId = toSafeString(payload.sourceId || "embedded-browser", 80);
    return {
      title: type === "watch_session_started" ? "Watch Session Started" : "Watch Session Stopped",
      body: watchSessionId ? `${sourceId} • ${watchSessionId}` : sourceId,
      commandId: "window.show",
      payload: { route: "watch", watchSessionId },
    };
  }

  return null;
};

const rememberLiveEventId = (id) => {
  const normalized = String(id || "").trim();
  if (!normalized) {
    return false;
  }
  if (liveBridgeSeenIds.includes(normalized)) {
    return false;
  }
  liveBridgeSeenIds.push(normalized);
  if (liveBridgeSeenIds.length > LIVE_SEEN_LIMIT) {
    liveBridgeSeenIds.splice(0, liveBridgeSeenIds.length - LIVE_SEEN_LIMIT);
  }
  return true;
};

const handleLiveEventRecord = (record, allowNotifications) => {
  if (!record || typeof record !== "object") {
    return;
  }
  const eventId = toSafeString(record.id || "", 140);
  if (eventId && !rememberLiveEventId(eventId)) {
    return;
  }

  const normalized = {
    id: eventId || undefined,
    type: toSafeString(record.type || "", 120),
    ts: toSafeString(record.ts || "", 80),
    payload: sanitizePayloadObject(record.payload || {}),
  };

  sendToRenderer("pod:desktop-live-event", normalized);
  queueTraySummaryRefresh(900);

  if (!allowNotifications) {
    return;
  }

  const descriptor = buildLiveEventNotification(normalized);
  if (!descriptor) {
    return;
  }
  showDesktopNotification(descriptor);
};

const disconnectLiveBridge = () => {
  if (liveBridgeRequest) {
    try {
      liveBridgeRequest.destroy();
    } catch {
      // ignore destroy errors
    }
    liveBridgeRequest = null;
  }
  if (liveBridgeResponse) {
    try {
      liveBridgeResponse.destroy();
    } catch {
      // ignore destroy errors
    }
    liveBridgeResponse = null;
  }
};

const scheduleLiveBridgeReconnect = () => {
  if (!liveBridgeEnabled) {
    return;
  }
  if (liveBridgeReconnectTimer) {
    clearTimeout(liveBridgeReconnectTimer);
  }
  liveBridgeReconnectTimer = setTimeout(() => {
    liveBridgeReconnectTimer = null;
    connectLiveBridge();
  }, 3_200);
};

const parseLiveBridgeChunk = (chunk) => {
  liveBridgeBuffer += String(chunk || "");
  const blocks = liveBridgeBuffer.split(/\r?\n\r?\n/);
  liveBridgeBuffer = blocks.pop() || "";

  for (const block of blocks) {
    if (!block.trim()) {
      continue;
    }
    const lines = block.split(/\r?\n/);
    let eventName = "message";
    const dataLines = [];

    for (const rawLine of lines) {
      const line = String(rawLine || "");
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim() || "message";
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (!dataLines.length) {
      continue;
    }

    if (eventName === "ping") {
      continue;
    }

    if (eventName === "ready") {
      liveBridgeReady = true;
      continue;
    }

    if (eventName !== "message") {
      continue;
    }

    const payload = dataLines.join("\n");
    try {
      const record = JSON.parse(payload);
      handleLiveEventRecord(record, liveBridgeReady);
    } catch {
      // ignore malformed SSE payload frames
    }
  }
};

const connectLiveBridge = () => {
  if (!liveBridgeEnabled) {
    return;
  }
  disconnectLiveBridge();
  liveBridgeBuffer = "";
  liveBridgeReady = false;

  let endpoint;
  try {
    endpoint = new URL("/api/live/events", appUrl);
  } catch {
    scheduleLiveBridgeReconnect();
    return;
  }

  const transport = endpoint.protocol === "https:" ? https : http;
  const request = transport.request(
    endpoint,
    {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      },
    },
    (response) => {
      liveBridgeResponse = response;
      const statusCode = Number(response.statusCode || 0);
      if (statusCode < 200 || statusCode >= 300) {
        scheduleLiveBridgeReconnect();
        return;
      }

      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        parseLiveBridgeChunk(chunk);
      });

      response.on("end", () => {
        if (!liveBridgeEnabled) {
          return;
        }
        scheduleLiveBridgeReconnect();
      });

      response.on("error", () => {
        if (!liveBridgeEnabled) {
          return;
        }
        scheduleLiveBridgeReconnect();
      });
    },
  );

  request.setTimeout(12_000, () => {
    request.destroy();
  });

  request.on("error", () => {
    if (!liveBridgeEnabled) {
      return;
    }
    scheduleLiveBridgeReconnect();
  });

  request.end();
  liveBridgeRequest = request;
};

const startLiveBridge = () => {
  if (liveBridgeEnabled) {
    return;
  }
  liveBridgeEnabled = true;
  connectLiveBridge();
};

const stopLiveBridge = () => {
  liveBridgeEnabled = false;
  if (liveBridgeReconnectTimer) {
    clearTimeout(liveBridgeReconnectTimer);
    liveBridgeReconnectTimer = null;
  }
  disconnectLiveBridge();
};

const updateTitleBarOverlayPreference = (mode) => {
  applyDesktopPreferences({ titleBarOverlayMode: mode });
  sendToRenderer("pod:desktop-command", {
    commandId: "system.notice",
    payload: {
      message: "Title bar mode updated. Restart app to fully apply frame changes.",
      mode,
    },
    ts: Date.now(),
  });
};

const rebuildApplicationMenu = () => {
  const fileMenu = [
    commandItem("app.new_thread"),
    commandItem("palette.open"),
    { type: "separator" },
    commandItem("window.show"),
    { type: "separator" },
    process.platform === "darwin" ? { role: "close" } : commandItem("app.quit"),
  ].filter(Boolean);

  const viewMenu = [
    { role: "reload" },
    { role: "forceReload" },
    { role: "toggleDevTools" },
    { type: "separator" },
    commandItem("view.toggle_workbench"),
    commandItem("view.open_onboarding"),
    { type: "separator" },
    {
      label: "Hide To Tray On Close",
      type: "checkbox",
      checked: Boolean(desktopPreferences.backgroundModeEnabled),
      click: (menuItem) => {
        applyDesktopPreferences({ backgroundModeEnabled: Boolean(menuItem.checked) });
      },
    },
    {
      label: "Desktop Notifications",
      type: "checkbox",
      checked: Boolean(desktopPreferences.notificationsEnabled),
      click: (menuItem) => {
        applyDesktopPreferences({ notificationsEnabled: Boolean(menuItem.checked) });
      },
    },
    {
      label: "Title Bar Overlay",
      submenu: [
        {
          label: "Auto (Platform Aware)",
          type: "radio",
          checked: normalizeTitleBarOverlayMode(desktopPreferences.titleBarOverlayMode) === "auto",
          click: () => updateTitleBarOverlayPreference("auto"),
        },
        {
          label: "On",
          type: "radio",
          checked: normalizeTitleBarOverlayMode(desktopPreferences.titleBarOverlayMode) === "on",
          click: () => updateTitleBarOverlayPreference("on"),
        },
        {
          label: "Off",
          type: "radio",
          checked: normalizeTitleBarOverlayMode(desktopPreferences.titleBarOverlayMode) === "off",
          click: () => updateTitleBarOverlayPreference("off"),
        },
      ],
    },
    { type: "separator" },
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" },
  ];

  const runMenu = [
    commandItem("run.refresh_status"),
    commandItem("run.heartbeat"),
    { type: "separator" },
    commandItem("context.send"),
    commandItem("watch.active"),
    { type: "separator" },
    commandItem("quick.open_antigravity"),
    commandItem("quick.open_chrome"),
    commandItem("run.social_mission"),
    commandItem("run.plan"),
    commandItem("run.workflow"),
    commandItem("run.ai_chat"),
    commandItem("run.ai_image"),
    commandItem("run.x_algo"),
    commandItem("tweet.generate"),
    commandItem("tweet.post"),
    commandItem("integration.dry_run"),
    commandItem("integration.execute"),
  ].filter(Boolean);

  const menuTemplate = [
    {
      label: "File",
      submenu: fileMenu,
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: viewMenu,
    },
    {
      label: "Run",
      submenu: runMenu,
    },
    {
      label: "Window",
      submenu: [
        commandItem("window.show"),
        { role: "minimize" },
        { role: "zoom" },
      ],
    },
    {
      label: "Help",
      submenu: [
        commandItem("help.electron_docs"),
      ],
    },
  ];

  if (process.platform === "darwin") {
    menuTemplate.unshift({
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        commandItem("app.quit"),
      ],
    });

    const windowMenu = menuTemplate.find((entry) => entry.label === "Window");
    if (windowMenu) {
      windowMenu.submenu = [
        commandItem("window.show"),
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" },
      ];
    }
  } else {
    const windowMenu = menuTemplate.find((entry) => entry.label === "Window");
    if (windowMenu && Array.isArray(windowMenu.submenu)) {
      windowMenu.submenu.push({ type: "separator" }, commandItem("app.quit"));
    }
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
};

const createMainWindow = () => {
  const overlayEnabled = resolveTitleBarOverlayEnabled(desktopPreferences);
  const windowOptions = {
    width: 1500,
    height: 980,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: "#0f2429",
    title: "Prompt or Die Social Suite",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };

  if (overlayEnabled) {
    if (process.platform === "darwin") {
      windowOptions.titleBarStyle = "hiddenInset";
    } else {
      windowOptions.titleBarStyle = "hidden";
      windowOptions.titleBarOverlay = {
        color: "#0f2429",
        symbolColor: "#e8f4ff",
        height: 36,
      };
    }
  }

  mainWindow = new BrowserWindow(windowOptions);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("context-menu", (_event, params) => {
    const menu = buildNativeContextMenu(mainWindow, params);
    if (!menu) {
      return;
    }
    menu.popup({
      window: mainWindow,
      x: toSafeNumber(params?.x),
      y: toSafeNumber(params?.y),
    });
  });

  mainWindow.on("close", (event) => {
    if (app.isQuitting || !desktopPreferences.backgroundModeEnabled) {
      return;
    }
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.once("did-finish-load", () => {
    sendDesktopCapabilities();
    sendDesktopPreferences();
    sendToRenderer("pod:desktop-commands", { commands: getPublicDesktopCommands() });
  });

  mainWindow.loadURL(appUrl);
};

ipcMain.handle("pod:get-app-info", () => ({
  name: app.getName(),
  version: app.getVersion(),
  url: appUrl,
  platform: process.platform,
}));

ipcMain.handle("pod:open-external", async (_event, url) => {
  if (typeof url !== "string" || !url.trim()) {
    throw new Error("A valid URL is required.");
  }
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle("pod:context-action:execute", (_event, payload) => {
  const actionId = String(payload?.actionId || "").trim();
  if (!isAllowedContextAction(actionId)) {
    throw new Error(`Unsupported context action: ${actionId || "<empty>"}`);
  }
  const sent = dispatchContextAction(mainWindow, actionId, payload?.context || payload);
  if (!sent) {
    throw new Error("Unable to dispatch context action.");
  }
  return {
    ok: true,
    actionId,
  };
});

ipcMain.handle("pod:desktop:capabilities:get", () => resolveDesktopCapabilities());
ipcMain.handle("pod:desktop:commands:get", () => ({ commands: getPublicDesktopCommands() }));
ipcMain.handle("pod:desktop:preferences:get", () => ({ ...desktopPreferences }));
ipcMain.handle("pod:desktop:preferences:set", (_event, patch) => ({
  ok: true,
  preferences: applyDesktopPreferences(patch),
}));
ipcMain.handle("pod:desktop:command:execute", (_event, payload) => {
  const commandId = String(payload?.commandId || "").trim();
  if (!DESKTOP_COMMAND_LOOKUP.has(commandId)) {
    throw new Error(`Unknown desktop command: ${commandId || "<empty>"}`);
  }
  const ok = invokeDesktopCommand(commandId, payload?.payload || {});
  return { ok, commandId };
});
ipcMain.handle("pod:app:quit", () => {
  app.isQuitting = true;
  app.quit();
  return { ok: true };
});

app.on("before-quit", () => {
  app.isQuitting = true;
  stopLiveBridge();
  destroySystemTray();
  stopServer();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  } else {
    focusMainWindow();
  }
});

app.whenReady().then(async () => {
  loadDesktopPreferences();
  rebuildApplicationMenu();

  const startedServer = await startServer();
  if (shouldStartServer && !startedServer) {
    console.warn(
      `[electron] local server process not started by this instance. Expecting an existing server at ${appUrl}.`,
    );
  }

  try {
    await waitForServer(appUrl, shouldStartServer && startedServer ? 90_000 : 8_000);
  } catch (error) {
    console.warn(`[electron] ${error instanceof Error ? error.message : String(error)}`);
  }

  createMainWindow();
  createSystemTray();
  startLiveBridge();
  queueTraySummaryRefresh(350);
});
