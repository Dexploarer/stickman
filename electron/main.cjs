const { app, BrowserWindow, ipcMain, shell, Menu } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 8787);
const appUrl = process.env.POD_APP_URL || `http://127.0.0.1:${port}`;
const shouldStartServer = process.env.POD_ELECTRON_START_SERVER !== "false";

let mainWindow = null;
let serverProcess = null;

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

const isAllowedContextAction = (actionId) => CONTEXT_ACTION_ALLOWLIST.has(String(actionId || "").trim());

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

const startServer = () => {
  if (!shouldStartServer || serverProcess) {
    return;
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
  } else {
    serverProcess = spawn("bun", ["src/server.ts"], {
      cwd: projectRoot,
      env,
      stdio: "inherit",
      shell: false,
    });
  }

  serverProcess.on("exit", (code, signal) => {
    if (!app.isQuitting) {
      console.warn(`[electron] local server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`);
    }
    serverProcess = null;
  });
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

const createMainWindow = () => {
  mainWindow = new BrowserWindow({
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
  });

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

  mainWindow.loadURL(appUrl);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
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

app.on("before-quit", () => {
  app.isQuitting = true;
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
  }
});

app.whenReady().then(async () => {
  startServer();

  try {
    await waitForServer(appUrl, shouldStartServer ? 90_000 : 8_000);
  } catch (error) {
    console.warn(`[electron] ${error instanceof Error ? error.message : String(error)}`);
  }

  createMainWindow();
});
