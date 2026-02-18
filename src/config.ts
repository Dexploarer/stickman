import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import type { ModelPreferences, OnboardingState, SkillId, XArgMap } from "./types.js";

const currentFile = fileURLToPath(import.meta.url);
const srcDir = path.dirname(currentFile);
export const projectRoot = path.resolve(srcDir, "..");
export const stateDir = path.resolve(projectRoot, ".state");
export const onboardingStatePath = path.resolve(stateDir, "onboarding.json");
export const modelCachePath = path.resolve(stateDir, "openrouter-models-cache.json");
export const workflowStorePath = path.resolve(stateDir, "workflows.json");
export const homePordieDir = path.resolve(os.homedir(), ".pordie");
export const projectPordieDir = path.resolve(projectRoot, ".pordie");

export type PordieScope = "global" | "project";

export interface ResolvedPordiePaths {
  scope: PordieScope;
  dir: string;
  configPath: string;
  envPath: string;
  envScriptPath: string;
}

const toBool = (value: string | undefined, fallback: boolean): boolean => {
  if (value == null || value.trim() === "") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};

const toOptional = (value: string | undefined): string | undefined => {
  if (value == null) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

const normalizePordieScope = (value: string | undefined): PordieScope | undefined => {
  const normalized = toOptional(value)?.toLowerCase();
  if (normalized === "global" || normalized === "project") {
    return normalized;
  }
  return undefined;
};

export const appConfig = {
  port: Number(process.env.PORT || 8787),
  claude: {
    sessionPath: toOptional(process.env.CLAUDE_SESSION_PATH),
    cliCommand: process.env.CLAUDE_CLI_COMMAND || "claude -p",
  },
  openrouter: {
    apiKey: toOptional(process.env.OPENROUTER_API_KEY),
    model: process.env.OPENROUTER_MODEL || "openai/gpt-4.1-mini",
    baseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    referer: process.env.OPENROUTER_HTTP_REFERER || "http://localhost:8787",
    appTitle: process.env.OPENROUTER_APP_TITLE || "Prompt or Die Social Suite",
  },
  xLocal: {
    scriptPath: path.resolve(projectRoot, process.env.X_LOCAL_SCRIPT || "x-local/x_v3_local.sh"),
    browser: process.env.X_BROWSER || "chrome",
    chromeProfile: toOptional(process.env.X_CHROME_PROFILE),
    chromeProfileName: process.env.X_CHROME_PROFILE_NAME || "Default",
    visible: toBool(process.env.X_VISIBLE, false),
    notify: toBool(process.env.X_NOTIFY, true),
    notifyWebhook: toOptional(process.env.X_NOTIFY_WEBHOOK),
    compatProvider: process.env.X_COMPAT_PROVIDER || "none",
  },
  pordie: {
    enabled: toBool(process.env.PORDIE_ENABLED, true),
    scopeOverride: normalizePordieScope(process.env.PORDIE_SCOPE),
    autoExportOnComplete: toBool(process.env.PORDIE_AUTO_EXPORT_ON_COMPLETE, true),
    syncProjectEnv: toBool(process.env.PORDIE_SYNC_PROJECT_ENV, false),
  },
  heartbeat: {
    enabled: toBool(process.env.HEARTBEAT_ENABLED, true),
    intervalMinutes: Math.max(1, Number(process.env.HEARTBEAT_INTERVAL_MINUTES || 20)),
    fetchLimit: Math.max(5, Number(process.env.HEARTBEAT_FETCH_LIMIT || 40)),
    autoAct: toBool(process.env.HEARTBEAT_AUTO_ACT, true),
  },
};

export const resolvePordieScope = (scope?: string): PordieScope => {
  if (appConfig.pordie.scopeOverride) {
    return appConfig.pordie.scopeOverride;
  }
  if (scope === "global" || scope === "project") {
    return scope;
  }
  return "global";
};

export const resolvePordiePaths = (scope?: PordieScope): ResolvedPordiePaths => {
  const resolvedScope = resolvePordieScope(scope);
  const dir = resolvedScope === "global" ? homePordieDir : projectPordieDir;
  return {
    scope: resolvedScope,
    dir,
    configPath: path.resolve(dir, "config.json"),
    envPath: path.resolve(dir, ".env"),
    envScriptPath: path.resolve(dir, "env.sh"),
  };
};

export const emptyModelPreferences = (): ModelPreferences => ({});

export const defaultOnboardingState = (): OnboardingState => ({
  completed: false,
  updatedAt: null,
  providers: {
    mode: "openrouter",
    claude: {
      enabled: true,
      sessionPath: appConfig.claude.sessionPath,
      requireCliLogin: true,
    },
  },
  openrouter: {
    saveApiKeyLocally: false,
    defaults: emptyModelPreferences(),
    fallbacks: emptyModelPreferences(),
  },
  extensions: {
    x: {
      enabled: true,
      mode: "manual",
      approvalRequiredForWrite: true,
    },
    code: {
      enabled: true,
      mode: "manual",
      approvalRequiredForWrite: true,
      allowReadOnlyAutonomy: true,
      workingDirectory: projectRoot,
    },
  },
  x: {
    savePasswordLocally: false,
  },
  persona: {
    deriveMode: "manual",
    autoDeriveFromProfile: false,
    stylePrompt: "",
    voiceStyle: "",
    sourceValue: "",
    characterPrompt: "",
    postExamples: [],
  },
  autonomy: {
    enabled: false,
    policy: "mixed_auto",
    maxActionsPerCycle: 8,
    approvalTTLMinutes: 30,
  },
  skills: {
    enabled: {
      "antigravity.open": true,
      "antigravity.open_mission_url": true,
      "terminal.open": true,
      "terminal.run_command": true,
      "codex.run_task": true,
      "claude.run_task": true,
      "browser.embedded.open_tab": true,
      "browser.external.chrome.open": true,
      "x-social.run_endpoint": true,
      "code-workspace.exec": true,
    } as Partial<Record<SkillId, boolean>>,
  },
  macControl: {
    appAllowlist: ["antigravity", "terminal", "chrome"],
    requireApprovalFor: ["terminal_exec", "codex_exec", "browser_external", "write_command"],
  },
  watch: {
    enabled: true,
    mode: "screenshare",
    fps: 2,
    captureScope: "agent_surfaces_only",
  },
  pordie: {
    enabled: appConfig.pordie.enabled,
    scope: resolvePordieScope("global"),
    autoExportOnComplete: appConfig.pordie.autoExportOnComplete,
    syncProjectEnv: appConfig.pordie.syncProjectEnv,
  },
});

export const buildDefaultXGlobalArgs = (): XArgMap => {
  const args: XArgMap = {
    browser: appConfig.xLocal.browser,
    chromeProfileName: appConfig.xLocal.chromeProfileName,
    visible: appConfig.xLocal.visible,
    notify: appConfig.xLocal.notify,
    compatProvider: appConfig.xLocal.compatProvider,
  };
  if (appConfig.xLocal.chromeProfile) {
    args.chromeProfile = appConfig.xLocal.chromeProfile;
  }
  if (appConfig.xLocal.notifyWebhook) {
    args.notifyWebhook = appConfig.xLocal.notifyWebhook;
  }
  return args;
};
