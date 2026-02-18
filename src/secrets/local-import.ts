import os from "node:os";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";

import type { OnboardingState } from "../types.js";

interface ImportOptions {
  includeProcessEnv: boolean;
  includeHomeDefaults: boolean;
  includeShellProfiles: boolean;
  includeClaudeAuth: boolean;
  additionalPaths: string[];
  overrideExisting: boolean;
}

interface ImportDetectedValues {
  providerMode?: string;
  claudeSessionPath?: string;
  xExtensionEnabled?: string;
  xExtensionMode?: string;
  xApprovalRequiredForWrite?: string;
  autonomyEnabled?: string;
  autonomyMaxActions?: string;
  autonomyApprovalTTL?: string;
  openrouterApiKey?: string;
  textSmall?: string;
  textLarge?: string;
  textFallback?: string;
  imagePrimary?: string;
  imageFallback?: string;
  videoPrimary?: string;
  videoFallback?: string;
  embeddingPrimary?: string;
  embeddingFallback?: string;
  voicePrimary?: string;
  voiceFallback?: string;
  xUsername?: string;
  xPassword?: string;
  xEmail?: string;
  stylePrompt?: string;
  voiceStyle?: string;
  deriveMode?: string;
  sourceValue?: string;
  postExamplesJson?: string;
}

export interface LocalImportResult {
  patch: Partial<OnboardingState>;
  updatedFields: string[];
  detectedFields: string[];
  sourcesRead: string[];
  sourcesWithMatches: string[];
  warnings: string[];
}

const hasValue = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

const maybeSet = (target: ImportDetectedValues, key: keyof ImportDetectedValues, value: unknown) => {
  if (!hasValue(value)) {
    return;
  }
  if (target[key]) {
    return;
  }
  target[key] = value.trim();
};

const normalizeEnvValue = (raw: string): string => {
  let value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value.trim();
};

const applyEnvPair = (key: string, value: string, detected: ImportDetectedValues) => {
  const k = key.trim().toUpperCase();
  const v = normalizeEnvValue(value);
  if (!v) {
    return;
  }

  switch (k) {
    case "POD_PROVIDER_MODE":
    case "POD_AI_PROVIDER_MODE":
      maybeSet(detected, "providerMode", v);
      return;
    case "CLAUDE_SESSION_PATH":
    case "POD_CLAUDE_SESSION_PATH":
      maybeSet(detected, "claudeSessionPath", v);
      return;
    case "POD_X_EXTENSION_ENABLED":
      maybeSet(detected, "xExtensionEnabled", v);
      return;
    case "POD_X_EXTENSION_MODE":
      maybeSet(detected, "xExtensionMode", v);
      return;
    case "POD_X_APPROVAL_REQUIRED_FOR_WRITE":
      maybeSet(detected, "xApprovalRequiredForWrite", v);
      return;
    case "POD_AUTONOMY_ENABLED":
      maybeSet(detected, "autonomyEnabled", v);
      return;
    case "POD_AUTONOMY_MAX_ACTIONS":
      maybeSet(detected, "autonomyMaxActions", v);
      return;
    case "POD_AUTONOMY_APPROVAL_TTL_MINUTES":
      maybeSet(detected, "autonomyApprovalTTL", v);
      return;
    case "OPENROUTER_API_KEY":
    case "OPEN_ROUTER_API_KEY":
    case "OPENROUTER_TOKEN":
    case "POD_OPENROUTER_API_KEY":
      maybeSet(detected, "openrouterApiKey", v);
      return;
    case "POD_TEXT_SMALL_MODEL":
      maybeSet(detected, "textSmall", v);
      return;
    case "POD_TEXT_LARGE_MODEL":
      maybeSet(detected, "textLarge", v);
      return;
    case "POD_TEXT_FALLBACK_MODEL":
      maybeSet(detected, "textFallback", v);
      return;
    case "POD_IMAGE_MODEL":
      maybeSet(detected, "imagePrimary", v);
      return;
    case "POD_IMAGE_FALLBACK_MODEL":
      maybeSet(detected, "imageFallback", v);
      return;
    case "POD_VIDEO_MODEL":
      maybeSet(detected, "videoPrimary", v);
      return;
    case "POD_VIDEO_FALLBACK_MODEL":
      maybeSet(detected, "videoFallback", v);
      return;
    case "POD_EMBEDDING_MODEL":
      maybeSet(detected, "embeddingPrimary", v);
      return;
    case "POD_EMBEDDING_FALLBACK_MODEL":
      maybeSet(detected, "embeddingFallback", v);
      return;
    case "POD_VOICE_MODEL":
      maybeSet(detected, "voicePrimary", v);
      return;
    case "POD_VOICE_FALLBACK_MODEL":
      maybeSet(detected, "voiceFallback", v);
      return;
    case "POD_X_USERNAME":
    case "X_USERNAME":
    case "TWITTER_USERNAME":
      maybeSet(detected, "xUsername", v);
      return;
    case "POD_X_PASSWORD":
    case "X_PASSWORD":
    case "TWITTER_PASSWORD":
      maybeSet(detected, "xPassword", v);
      return;
    case "POD_X_EMAIL":
    case "X_EMAIL":
    case "TWITTER_EMAIL":
      maybeSet(detected, "xEmail", v);
      return;
    case "POD_AGENT_STYLE_PROMPT":
      maybeSet(detected, "stylePrompt", v);
      return;
    case "POD_AGENT_VOICE_STYLE":
      maybeSet(detected, "voiceStyle", v);
      return;
    case "POD_AGENT_DERIVE_MODE":
      maybeSet(detected, "deriveMode", v);
      return;
    case "POD_AGENT_SOURCE_VALUE":
      maybeSet(detected, "sourceValue", v);
      return;
    case "POD_AGENT_POST_EXAMPLES_JSON":
      maybeSet(detected, "postExamplesJson", v);
      return;
    default:
      if (k.includes("OPENROUTER") && (k.includes("KEY") || k.includes("TOKEN"))) {
        maybeSet(detected, "openrouterApiKey", v);
      }
  }
};

const parseEnvStyleText = (raw: string, detected: ImportDetectedValues) => {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const normalized = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const idx = normalized.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = normalized.slice(0, idx).trim();
    const value = normalized.slice(idx + 1).trim();
    if (!key) {
      continue;
    }
    applyEnvPair(key, value, detected);
  }
};

const walkJson = (value: unknown, parts: string[], detected: ImportDetectedValues) => {
  if (value == null) {
    return;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const key = parts.join("_").toUpperCase();
    applyEnvPair(key, String(value), detected);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, idx) => walkJson(entry, [...parts, String(idx)], detected));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walkJson(v, [...parts, k], detected);
    }
  }
};

const readCandidateFile = async (
  filePath: string,
  detected: ImportDetectedValues,
  sourcesRead: string[],
  sourcesWithMatches: string[],
  warnings: string[],
) => {
  const before = JSON.stringify(detected);
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      return;
    }
    const raw = await readFile(filePath, "utf-8");
    sourcesRead.push(filePath);

    if (filePath.endsWith(".json")) {
      try {
        const parsed = JSON.parse(raw);
        walkJson(parsed, [], detected);
      } catch {
        parseEnvStyleText(raw, detected);
      }
    } else {
      parseEnvStyleText(raw, detected);
    }

    if (before !== JSON.stringify(detected)) {
      sourcesWithMatches.push(filePath);
    }
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR")
    ) {
      return;
    }
    warnings.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const home = os.homedir();
const expandHome = (value: string): string => {
  if (value.startsWith("~/")) {
    return path.join(home, value.slice(2));
  }
  return value;
};

const buildDefaultPaths = (options: Pick<ImportOptions, "includeHomeDefaults" | "includeShellProfiles" | "includeClaudeAuth">): string[] => {
  const out: string[] = [];

  if (options.includeShellProfiles) {
    out.push(
      "~/.zshrc",
      "~/.zprofile",
      "~/.bashrc",
      "~/.bash_profile",
      "~/.profile",
    );
  }

  if (options.includeHomeDefaults) {
    out.push(
      "~/.pordie/.env",
      "~/.config/pordie/.env",
      "~/.config/prompt-or-die/.env",
      "~/.claude/.env",
      "~/.config/claude/.env",
      "~/.codex/.env",
      "~/.config/codex/.env",
    );
  }

  if (options.includeClaudeAuth) {
    out.push(
      "~/.claude/config.json",
      "~/.claude/settings.json",
      "~/.claude/auth.json",
      "~/.claude/credentials.json",
      "~/.config/claude/config.json",
      "~/.config/claude/settings.json",
      "~/.config/claude/auth.json",
      "~/.config/claude/credentials.json",
    );
  }

  return out.map(expandHome);
};

const unique = <T>(rows: T[]): T[] => Array.from(new Set(rows));

const applyDetectedToPatch = (
  current: OnboardingState,
  detected: ImportDetectedValues,
  options: Pick<ImportOptions, "overrideExisting">,
): { patch: Partial<OnboardingState>; updatedFields: string[]; detectedFields: string[] } => {
  const patch: Partial<OnboardingState> = {};
  const updatedFields: string[] = [];
  const detectedFields: string[] = Object.entries(detected)
    .filter(([, value]) => hasValue(value))
    .map(([key]) => key);

  const pick = (currentValue: unknown, nextValue: unknown): string | undefined => {
    if (!hasValue(nextValue)) {
      return undefined;
    }
    if (options.overrideExisting) {
      return nextValue.trim();
    }
    return hasValue(currentValue) ? undefined : nextValue.trim();
  };

  const openrouterPatch: NonNullable<Partial<OnboardingState["openrouter"]>> = {
    defaults: {},
    fallbacks: {},
  };

  const providersPatch: Partial<OnboardingState["providers"]> = {};
  const normalizedProviderMode = pick(
    current.providers.mode,
    detected.providerMode,
  )?.toLowerCase();
  if (
    normalizedProviderMode === "claude_subscription" ||
    normalizedProviderMode === "openrouter" ||
    normalizedProviderMode === "hybrid"
  ) {
    providersPatch.mode = normalizedProviderMode;
    updatedFields.push("providers.mode");
  }
  const claudeSessionPath = pick(current.providers.claude.sessionPath, detected.claudeSessionPath);
  if (claudeSessionPath) {
    providersPatch.claude = {
      ...current.providers.claude,
      sessionPath: claudeSessionPath,
    };
    updatedFields.push("providers.claude.sessionPath");
  }
  if (Object.keys(providersPatch).length) {
    patch.providers = providersPatch as OnboardingState["providers"];
  }

  const apiKey = pick(current.openrouter.apiKey, detected.openrouterApiKey);
  if (apiKey) {
    openrouterPatch.apiKey = apiKey;
    openrouterPatch.saveApiKeyLocally = true;
    updatedFields.push("openrouter.apiKey");
  }

  const textSmall = pick(current.openrouter.defaults.textSmall, detected.textSmall);
  const textLarge = pick(current.openrouter.defaults.textLarge, detected.textLarge);
  const textFallback = pick(current.openrouter.fallbacks.textFallback, detected.textFallback);
  const imagePrimary = pick(current.openrouter.defaults.imagePrimary, detected.imagePrimary);
  const imageFallback = pick(current.openrouter.fallbacks.imageFallback, detected.imageFallback);
  const videoPrimary = pick(current.openrouter.defaults.videoPrimary, detected.videoPrimary);
  const videoFallback = pick(current.openrouter.fallbacks.videoFallback, detected.videoFallback);
  const embeddingPrimary = pick(current.openrouter.defaults.embeddingPrimary, detected.embeddingPrimary);
  const embeddingFallback = pick(current.openrouter.fallbacks.embeddingFallback, detected.embeddingFallback);
  const voicePrimary = pick(current.openrouter.defaults.voicePrimary, detected.voicePrimary);
  const voiceFallback = pick(current.openrouter.fallbacks.voiceFallback, detected.voiceFallback);

  if (textSmall) {
    openrouterPatch.defaults = { ...openrouterPatch.defaults, textSmall };
    updatedFields.push("openrouter.defaults.textSmall");
  }
  if (textLarge) {
    openrouterPatch.defaults = { ...openrouterPatch.defaults, textLarge };
    updatedFields.push("openrouter.defaults.textLarge");
  }
  if (imagePrimary) {
    openrouterPatch.defaults = { ...openrouterPatch.defaults, imagePrimary };
    updatedFields.push("openrouter.defaults.imagePrimary");
  }
  if (videoPrimary) {
    openrouterPatch.defaults = { ...openrouterPatch.defaults, videoPrimary };
    updatedFields.push("openrouter.defaults.videoPrimary");
  }
  if (embeddingPrimary) {
    openrouterPatch.defaults = { ...openrouterPatch.defaults, embeddingPrimary };
    updatedFields.push("openrouter.defaults.embeddingPrimary");
  }
  if (voicePrimary) {
    openrouterPatch.defaults = { ...openrouterPatch.defaults, voicePrimary };
    updatedFields.push("openrouter.defaults.voicePrimary");
  }
  if (textFallback) {
    openrouterPatch.fallbacks = { ...openrouterPatch.fallbacks, textFallback };
    updatedFields.push("openrouter.fallbacks.textFallback");
  }
  if (imageFallback) {
    openrouterPatch.fallbacks = { ...openrouterPatch.fallbacks, imageFallback };
    updatedFields.push("openrouter.fallbacks.imageFallback");
  }
  if (videoFallback) {
    openrouterPatch.fallbacks = { ...openrouterPatch.fallbacks, videoFallback };
    updatedFields.push("openrouter.fallbacks.videoFallback");
  }
  if (embeddingFallback) {
    openrouterPatch.fallbacks = { ...openrouterPatch.fallbacks, embeddingFallback };
    updatedFields.push("openrouter.fallbacks.embeddingFallback");
  }
  if (voiceFallback) {
    openrouterPatch.fallbacks = { ...openrouterPatch.fallbacks, voiceFallback };
    updatedFields.push("openrouter.fallbacks.voiceFallback");
  }

  if (
    openrouterPatch.apiKey ||
    Object.keys(openrouterPatch.defaults || {}).length ||
    Object.keys(openrouterPatch.fallbacks || {}).length
  ) {
    patch.openrouter = openrouterPatch as OnboardingState["openrouter"];
  }

  const xPatch: Partial<OnboardingState["x"]> = {};
  const xUsername = pick(current.x.username, detected.xUsername);
  const xPassword = pick(current.x.password, detected.xPassword);
  const xEmail = pick(current.x.email, detected.xEmail);
  if (xUsername) {
    xPatch.username = xUsername;
    updatedFields.push("x.username");
  }
  if (xEmail) {
    xPatch.email = xEmail;
    updatedFields.push("x.email");
  }
  if (xPassword) {
    xPatch.password = xPassword;
    xPatch.savePasswordLocally = true;
    updatedFields.push("x.password");
  }
  if (Object.keys(xPatch).length) {
    patch.x = xPatch as OnboardingState["x"];
  }

  const extensionsPatch: Partial<OnboardingState["extensions"]> = {};
  const normalizedXExtensionEnabled = pick(
    String(current.extensions.x.enabled),
    detected.xExtensionEnabled,
  )?.toLowerCase();
  const normalizedXExtensionMode = pick(
    current.extensions.x.mode,
    detected.xExtensionMode,
  )?.toLowerCase();
  const normalizedXApprovalRequired = pick(
    String(current.extensions.x.approvalRequiredForWrite),
    detected.xApprovalRequiredForWrite,
  )?.toLowerCase();
  const nextExtensionX: Partial<OnboardingState["extensions"]["x"]> = {};
  if (normalizedXExtensionEnabled === "true" || normalizedXExtensionEnabled === "false") {
    nextExtensionX.enabled = normalizedXExtensionEnabled === "true";
    updatedFields.push("extensions.x.enabled");
  }
  if (normalizedXExtensionMode === "manual" || normalizedXExtensionMode === "scheduled") {
    nextExtensionX.mode = normalizedXExtensionMode;
    updatedFields.push("extensions.x.mode");
  }
  if (normalizedXApprovalRequired === "true" || normalizedXApprovalRequired === "false") {
    nextExtensionX.approvalRequiredForWrite = normalizedXApprovalRequired === "true";
    updatedFields.push("extensions.x.approvalRequiredForWrite");
  }
  if (Object.keys(nextExtensionX).length) {
    extensionsPatch.x = {
      ...current.extensions.x,
      ...nextExtensionX,
    };
  }
  if (Object.keys(extensionsPatch).length) {
    patch.extensions = extensionsPatch as OnboardingState["extensions"];
  }

  const autonomyPatch: Partial<OnboardingState["autonomy"]> = {};
  const normalizedAutonomyEnabled = pick(
    String(current.autonomy.enabled),
    detected.autonomyEnabled,
  )?.toLowerCase();
  if (normalizedAutonomyEnabled === "true" || normalizedAutonomyEnabled === "false") {
    autonomyPatch.enabled = normalizedAutonomyEnabled === "true";
    updatedFields.push("autonomy.enabled");
  }
  const parsedMaxActions = Number(pick(String(current.autonomy.maxActionsPerCycle), detected.autonomyMaxActions));
  if (Number.isFinite(parsedMaxActions) && parsedMaxActions > 0) {
    autonomyPatch.maxActionsPerCycle = Math.trunc(parsedMaxActions);
    updatedFields.push("autonomy.maxActionsPerCycle");
  }
  const parsedApprovalTTL = Number(pick(String(current.autonomy.approvalTTLMinutes), detected.autonomyApprovalTTL));
  if (Number.isFinite(parsedApprovalTTL) && parsedApprovalTTL > 0) {
    autonomyPatch.approvalTTLMinutes = Math.trunc(parsedApprovalTTL);
    updatedFields.push("autonomy.approvalTTLMinutes");
  }
  if (Object.keys(autonomyPatch).length) {
    patch.autonomy = autonomyPatch as OnboardingState["autonomy"];
  }

  const personaPatch: Partial<OnboardingState["persona"]> = {};
  const stylePrompt = pick(current.persona.stylePrompt, detected.stylePrompt);
  const voiceStyle = pick(current.persona.voiceStyle, detected.voiceStyle);
  const deriveMode = pick(current.persona.deriveMode, detected.deriveMode);
  const sourceValue = pick(current.persona.sourceValue, detected.sourceValue);
  let detectedPostExamples: string[] = [];
  if (hasValue(detected.postExamplesJson)) {
    try {
      const parsed = JSON.parse(detected.postExamplesJson);
      if (Array.isArray(parsed)) {
        detectedPostExamples = parsed
          .map((item) => String(item || "").trim())
          .filter(Boolean);
      }
    } catch {
      detectedPostExamples = detected.postExamplesJson
        .split(/\r?\n|\|\|\|/)
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }
  const canSetPostExamples =
    detectedPostExamples.length > 0 &&
    (options.overrideExisting || !Array.isArray(current.persona.postExamples) || current.persona.postExamples.length === 0);
  if (stylePrompt) {
    personaPatch.stylePrompt = stylePrompt;
    updatedFields.push("persona.stylePrompt");
  }
  if (voiceStyle) {
    personaPatch.voiceStyle = voiceStyle;
    updatedFields.push("persona.voiceStyle");
  }
  if (deriveMode) {
    personaPatch.deriveMode = deriveMode as OnboardingState["persona"]["deriveMode"];
    updatedFields.push("persona.deriveMode");
  }
  if (sourceValue) {
    personaPatch.sourceValue = sourceValue;
    updatedFields.push("persona.sourceValue");
  }
  if (canSetPostExamples) {
    personaPatch.postExamples = detectedPostExamples.slice(0, 20);
    updatedFields.push("persona.postExamples");
  }
  if (Object.keys(personaPatch).length) {
    patch.persona = personaPatch as OnboardingState["persona"];
  }

  return {
    patch,
    updatedFields,
    detectedFields,
  };
};

export const importLocalSecrets = async (
  current: OnboardingState,
  options: ImportOptions,
): Promise<LocalImportResult> => {
  const detected: ImportDetectedValues = {};
  const sourcesRead: string[] = [];
  const sourcesWithMatches: string[] = [];
  const warnings: string[] = [];

  if (options.includeProcessEnv) {
    const before = JSON.stringify(detected);
    for (const [key, value] of Object.entries(process.env)) {
      if (!hasValue(value)) {
        continue;
      }
      applyEnvPair(key, value, detected);
    }
    if (before !== JSON.stringify(detected)) {
      sourcesWithMatches.push("process.env");
    }
    sourcesRead.push("process.env");
  }

  const additional = options.additionalPaths
    .map((value) => value.trim())
    .filter(Boolean)
    .map(expandHome);

  const candidates = unique([
    ...buildDefaultPaths(options),
    ...additional,
  ]);

  for (const filePath of candidates) {
    await readCandidateFile(filePath, detected, sourcesRead, sourcesWithMatches, warnings);
  }

  const { patch, updatedFields, detectedFields } = applyDetectedToPatch(current, detected, {
    overrideExisting: options.overrideExisting,
  });

  return {
    patch,
    updatedFields,
    detectedFields,
    sourcesRead,
    sourcesWithMatches,
    warnings,
  };
};
