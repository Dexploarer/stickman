import path from "node:path";
import { chmod, readFile, writeFile } from "node:fs/promises";

import { projectRoot, type PordieScope, resolvePordiePaths, resolvePordieScope } from "./config.js";
import { ensureDirectoryForFile, writeJsonFile } from "./state/store.js";
import type { OnboardingState } from "./types.js";

interface ExportOptions {
  syncProjectEnv: boolean;
  scope?: PordieScope;
}

interface ExportResult {
  scope: PordieScope;
  pordieDir: string;
  configPath: string;
  envPath: string;
  envScriptPath: string;
  projectEnvPath: string | null;
  keysWritten: string[];
}

const toEnvValue = (value: unknown): string | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }
  const text = String(value);
  return text.trim() === "" ? undefined : text;
};

const shellQuote = (value: string): string => {
  return `'${value.replace(/'/g, `'\\''`)}'`;
};

const serializeEnv = (entries: Record<string, string>): string => {
  return Object.entries(entries)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n");
};

const parseEnvLines = (raw: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const idx = trimmed.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!key) {
      continue;
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      out[key] = value.slice(1, -1);
    } else {
      out[key] = value;
    }
  }
  return out;
};

const buildEnvMap = (state: OnboardingState): Record<string, string> => {
  const entries: Record<string, string> = {};
  const push = (key: string, value: unknown) => {
    const text = toEnvValue(value);
    if (!text) {
      return;
    }
    entries[key] = text;
  };

  push("OPENROUTER_API_KEY", state.openrouter.apiKey);
  push("POD_PROVIDER_MODE", state.providers.mode);
  push("POD_CLAUDE_ENABLED", state.providers.claude.enabled ? "true" : "false");
  push("POD_CLAUDE_REQUIRE_CLI_LOGIN", state.providers.claude.requireCliLogin ? "true" : "false");
  push("CLAUDE_SESSION_PATH", state.providers.claude.sessionPath);
  push("POD_TEXT_SMALL_MODEL", state.openrouter.defaults.textSmall);
  push("POD_TEXT_LARGE_MODEL", state.openrouter.defaults.textLarge);
  push("POD_TEXT_FALLBACK_MODEL", state.openrouter.fallbacks.textFallback);
  push("POD_IMAGE_MODEL", state.openrouter.defaults.imagePrimary);
  push("POD_IMAGE_FALLBACK_MODEL", state.openrouter.fallbacks.imageFallback);
  push("POD_VIDEO_MODEL", state.openrouter.defaults.videoPrimary);
  push("POD_VIDEO_FALLBACK_MODEL", state.openrouter.fallbacks.videoFallback);
  push("POD_EMBEDDING_MODEL", state.openrouter.defaults.embeddingPrimary);
  push("POD_EMBEDDING_FALLBACK_MODEL", state.openrouter.fallbacks.embeddingFallback);
  push("POD_VOICE_MODEL", state.openrouter.defaults.voicePrimary);
  push("POD_VOICE_FALLBACK_MODEL", state.openrouter.fallbacks.voiceFallback);

  push("POD_X_USERNAME", state.x.username);
  push("POD_X_EMAIL", state.x.email);
  push("POD_X_PASSWORD", state.x.password);
  push("POD_X_EXTENSION_ENABLED", state.extensions.x.enabled ? "true" : "false");
  push("POD_X_EXTENSION_MODE", state.extensions.x.mode);
  push(
    "POD_X_APPROVAL_REQUIRED_FOR_WRITE",
    state.extensions.x.approvalRequiredForWrite ? "true" : "false",
  );

  push("POD_AGENT_STYLE_PROMPT", state.persona.stylePrompt);
  push("POD_AGENT_VOICE_STYLE", state.persona.voiceStyle);
  push("POD_AGENT_DERIVE_MODE", state.persona.deriveMode);
  push("POD_AGENT_SOURCE_VALUE", state.persona.sourceValue);
  push("POD_AGENT_AUTO_DERIVE_PROFILE", state.persona.autoDeriveFromProfile ? "true" : "false");
  push("POD_AGENT_CHARACTER_PROMPT", state.persona.characterPrompt);
  if (Array.isArray(state.persona.postExamples) && state.persona.postExamples.length > 0) {
    push("POD_AGENT_POST_EXAMPLES_JSON", JSON.stringify(state.persona.postExamples));
  }

  push("POD_AUTONOMY_ENABLED", state.autonomy.enabled ? "true" : "false");
  push("POD_AUTONOMY_POLICY", state.autonomy.policy);
  push("POD_AUTONOMY_MAX_ACTIONS", String(state.autonomy.maxActionsPerCycle));
  push("POD_AUTONOMY_APPROVAL_TTL_MINUTES", String(state.autonomy.approvalTTLMinutes));

  return entries;
};

const buildPordieShellScript = (entries: Record<string, string>): string => {
  const lines = Object.entries(entries)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`);

  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    "# Prompt or Die exported environment",
    ...lines,
    "",
    'echo "Prompt or Die environment loaded."',
    "",
  ].join("\n");
};

const syncProjectEnv = async (entries: Record<string, string>): Promise<string> => {
  const projectEnvPath = path.resolve(projectRoot, ".env");
  let existingRaw = "";
  try {
    existingRaw = await readFile(projectEnvPath, "utf-8");
  } catch {
    existingRaw = "";
  }
  const parsed = parseEnvLines(existingRaw);
  for (const [key, value] of Object.entries(entries)) {
    parsed[key] = value;
  }
  await ensureDirectoryForFile(projectEnvPath);
  await writeFile(projectEnvPath, `${serializeEnv(parsed)}\n`, "utf-8");
  return projectEnvPath;
};

export const exportPromptOrDieConfig = async (
  onboarding: OnboardingState,
  options: ExportOptions,
): Promise<ExportResult> => {
  if (!onboarding.pordie.enabled) {
    throw new Error("Prompt or Die export is disabled in onboarding settings.");
  }

  const scope = resolvePordieScope(options.scope || onboarding.pordie.scope);
  const paths = resolvePordiePaths(scope);
  const envEntries = buildEnvMap(onboarding);
  await ensureDirectoryForFile(paths.configPath);
  await writeJsonFile(paths.configPath, {
    ...onboarding,
    pordie: {
      ...onboarding.pordie,
      scope,
    },
  });
  await writeFile(paths.envPath, `${serializeEnv(envEntries)}\n`, "utf-8");
  await writeFile(paths.envScriptPath, buildPordieShellScript(envEntries), "utf-8");
  await chmod(paths.envScriptPath, 0o755);

  let projectEnvPath: string | null = null;
  if (options.syncProjectEnv) {
    projectEnvPath = await syncProjectEnv(envEntries);
  }

  return {
    scope,
    pordieDir: paths.dir,
    configPath: paths.configPath,
    envPath: paths.envPath,
    envScriptPath: paths.envScriptPath,
    projectEnvPath,
    keysWritten: Object.keys(envEntries).sort(),
  };
};
