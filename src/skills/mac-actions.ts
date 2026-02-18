import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { MacAppId } from "../types.js";

const appMetadata: Record<MacAppId, { appName: string; bundlePath: string; bundleId: string }> = {
  antigravity: {
    appName: "Antigravity",
    bundlePath: "/Applications/Antigravity.app",
    bundleId: "com.google.antigravity",
  },
  terminal: {
    appName: "Terminal",
    bundlePath: "/Applications/Utilities/Terminal.app",
    bundleId: "com.apple.Terminal",
  },
  chrome: {
    appName: "Google Chrome",
    bundlePath: "/Applications/Google Chrome.app",
    bundleId: "com.google.Chrome",
  },
};

const runCommand = async (command: string, args: string[]) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout.push(chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr.push(chunk.toString());
    });
    child.on("close", (code) => {
      resolve(typeof code === "number" ? code : 1);
    });
    child.on("error", (error) => {
      stderr.push(error.message);
    });
  });
  return {
    ok: exitCode === 0,
    exitCode,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
  };
};

export const listKnownMacApps = () => {
  return (Object.keys(appMetadata) as MacAppId[]).map((id) => {
    const info = appMetadata[id];
    return {
      id,
      title: info.appName,
      bundlePath: info.bundlePath,
      bundleId: info.bundleId,
      available: path.isAbsolute(info.bundlePath) ? fs.existsSync(info.bundlePath) : false,
    };
  });
};

export const openMacApp = async (
  appId: MacAppId,
  options?: { url?: string },
): Promise<{ ok: boolean; message: string }> => {
  const app = appMetadata[appId];
  if (!app) {
    return { ok: false, message: `Unsupported app: ${appId}` };
  }
  const args = ["-a", app.appName];
  if (options?.url?.trim()) {
    args.push(options.url.trim());
  }
  const result = await runCommand("/usr/bin/open", args);
  if (!result.ok) {
    return { ok: false, message: result.stderr || `Failed to open ${app.appName}` };
  }
  return { ok: true, message: `${app.appName} opened` };
};

export const focusMacApp = async (appId: MacAppId): Promise<{ ok: boolean; message: string }> => {
  const app = appMetadata[appId];
  if (!app) {
    return { ok: false, message: `Unsupported app: ${appId}` };
  }
  const script = `tell application "${app.appName}" to activate`;
  const result = await runCommand("/usr/bin/osascript", ["-e", script]);
  if (!result.ok) {
    return { ok: false, message: result.stderr || `Failed to focus ${app.appName}` };
  }
  return { ok: true, message: `${app.appName} focused` };
};
