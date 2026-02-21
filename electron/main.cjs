const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 8787);
const appUrl = process.env.POD_APP_URL || `http://127.0.0.1:${port}`;
const shouldStartServer = process.env.POD_ELECTRON_START_SERVER !== "false";

let mainWindow = null;
let serverProcess = null;

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
