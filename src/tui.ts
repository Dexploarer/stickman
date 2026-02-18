import "dotenv/config";

import { readFile, writeFile } from "node:fs/promises";

import prompts from "prompts";

import {
  getModelCache,
  refreshModelCache,
  runAIText,
  runAutomationPlanner,
  testOpenRouterKey,
} from "./ai/openrouter.js";
import { appConfig, resolvePordieScope, workflowStorePath } from "./config.js";
import { completeOnboarding, getOnboardingState, saveOnboardingState } from "./onboarding.js";
import { exportPromptOrDieConfig } from "./pordie.js";
import { importLocalSecrets } from "./secrets/local-import.js";
import { ensureDirectoryForFile } from "./state/store.js";
import type { OnboardingState, OpenRouterModelCache, PersonaSourceType, XArgMap, OnboardingPordie } from "./types.js";
import { xEndpointCatalog, type XEndpointCatalogEntry } from "./x/catalog.js";
import { runXEndpoint } from "./x/runner.js";

interface WorkflowStep {
  endpoint: string;
  args: XArgMap;
  waitMs: number;
}

interface SavedWorkflow {
  name: string;
  createdAt: string;
  steps: WorkflowStep[];
}

const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

const wait = async (ms: number) => {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const parsePathList = (raw: string): string[] => {
  return raw
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const promptOrThrow = async <T extends Record<string, unknown>>(question: prompts.PromptObject | prompts.PromptObject[]) => {
  const response = await prompts(question, {
    onCancel: () => {
      throw new Error("cancelled");
    },
  });
  return response as T;
};

const runX = async (endpoint: string, endpointArgs: XArgMap = {}, globalArgs: XArgMap = {}) => {
  return runXEndpoint({
    scriptPath: appConfig.xLocal.scriptPath,
    endpoint,
    endpointArgs,
    globalArgs: {
      browser: appConfig.xLocal.browser,
      chromeProfileName: appConfig.xLocal.chromeProfileName,
      visible: appConfig.xLocal.visible,
      notify: appConfig.xLocal.notify,
      compatProvider: appConfig.xLocal.compatProvider,
      ...(appConfig.xLocal.chromeProfile ? { chromeProfile: appConfig.xLocal.chromeProfile } : {}),
      ...(appConfig.xLocal.notifyWebhook ? { notifyWebhook: appConfig.xLocal.notifyWebhook } : {}),
      ...globalArgs,
    },
  });
};

const chooseModel = async (
  label: string,
  cache: OpenRouterModelCache | null,
  group: keyof OpenRouterModelCache["groups"],
  initialValue?: string,
) => {
  const choices = [
    { title: "<none>", value: "" },
    ...(cache?.groups[group] || []).map((id) => ({
      title: id,
      value: id,
    })),
  ];
  const initialIndex = initialValue ? Math.max(0, choices.findIndex((item) => item.value === initialValue)) : 0;
  const answer = await promptOrThrow<{ value: string }>({
    type: "select",
    name: "value",
    message: label,
    choices,
    initial: initialIndex,
  });
  return answer.value.trim();
};

const loadSavedWorkflows = async (): Promise<SavedWorkflow[]> => {
  await ensureDirectoryForFile(workflowStorePath);
  try {
    const raw = await readFile(workflowStorePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is SavedWorkflow => {
      return (
        Boolean(item) &&
        typeof item === "object" &&
        typeof (item as SavedWorkflow).name === "string" &&
        Array.isArray((item as SavedWorkflow).steps)
      );
    });
  } catch {
    return [];
  }
};

const saveSavedWorkflows = async (workflows: SavedWorkflow[]) => {
  await ensureDirectoryForFile(workflowStorePath);
  await writeFile(workflowStorePath, JSON.stringify(workflows, null, 2), "utf-8");
};

const askGlobalOverrides = async (): Promise<XArgMap> => {
  const toggle = await promptOrThrow<{ override: boolean }>({
    type: "toggle",
    name: "override",
    message: "Override runtime options for this action?",
    initial: false,
    active: "yes",
    inactive: "no",
  });

  if (!toggle.override) {
    return {};
  }

  const values = await promptOrThrow<{
    browser: string;
    visible: boolean;
    notify: boolean;
    compatProvider: string;
    chromeProfile: string;
    chromeProfileName: string;
    notifyWebhook: string;
  }>([
    {
      type: "select",
      name: "browser",
      message: "Browser",
      choices: [
        { title: "chrome", value: "chrome" },
        { title: "chromium", value: "chromium" },
        { title: "edge", value: "edge" },
      ],
      initial: 0,
    },
    {
      type: "toggle",
      name: "visible",
      message: "Visible browser window",
      initial: Boolean(appConfig.xLocal.visible),
      active: "on",
      inactive: "off",
    },
    {
      type: "toggle",
      name: "notify",
      message: "Desktop notifications",
      initial: Boolean(appConfig.xLocal.notify),
      active: "on",
      inactive: "off",
    },
    {
      type: "select",
      name: "compatProvider",
      message: "Compatibility mode",
      choices: [
        { title: "none", value: "none" },
        { title: "aisa", value: "aisa" },
      ],
      initial: appConfig.xLocal.compatProvider === "aisa" ? 1 : 0,
    },
    {
      type: "text",
      name: "chromeProfile",
      message: "Chrome profile path (optional)",
      initial: appConfig.xLocal.chromeProfile || "",
    },
    {
      type: "text",
      name: "chromeProfileName",
      message: "Chrome profile name",
      initial: appConfig.xLocal.chromeProfileName,
    },
    {
      type: "text",
      name: "notifyWebhook",
      message: "Notify webhook URL (optional)",
      initial: appConfig.xLocal.notifyWebhook || "",
    },
  ]);

  const out: XArgMap = {
    browser: values.browser,
    visible: values.visible,
    notify: values.notify,
    compatProvider: values.compatProvider,
  };
  if (values.chromeProfile.trim()) {
    out.chromeProfile = values.chromeProfile.trim();
  }
  if (values.chromeProfileName.trim()) {
    out.chromeProfileName = values.chromeProfileName.trim();
  }
  if (values.notifyWebhook.trim()) {
    out.notifyWebhook = values.notifyWebhook.trim();
  }
  return out;
};

const pickEndpoint = async (): Promise<XEndpointCatalogEntry> => {
  const keywordAnswer = await promptOrThrow<{ keyword: string }>({
    type: "text",
    name: "keyword",
    message: "Filter endpoints (optional)",
    initial: "",
  });
  const keyword = keywordAnswer.keyword.trim().toLowerCase();

  const filtered = xEndpointCatalog.filter((endpoint) => {
    if (!keyword) {
      return true;
    }
    return (
      endpoint.endpoint.toLowerCase().includes(keyword) ||
      endpoint.summary.toLowerCase().includes(keyword) ||
      endpoint.category.toLowerCase().includes(keyword)
    );
  });

  if (filtered.length === 0) {
    throw new Error("No endpoints match the filter.");
  }

  const selected = await promptOrThrow<{ endpoint: string }>({
    type: "select",
    name: "endpoint",
    message: "Choose endpoint",
    choices: filtered.map((endpoint) => ({
      title: `${endpoint.endpoint}  [${endpoint.category}]`,
      description: endpoint.summary,
      value: endpoint.endpoint,
    })),
    initial: 0,
  });

  const endpoint = xEndpointCatalog.find((item) => item.endpoint === selected.endpoint);
  if (!endpoint) {
    throw new Error("Endpoint selection failed.");
  }
  return endpoint;
};

const collectEndpointArgs = async (endpoint: XEndpointCatalogEntry): Promise<XArgMap> => {
  const args: XArgMap = {};
  for (const arg of endpoint.args) {
    if (arg.type === "boolean") {
      const answer = await promptOrThrow<{ value: boolean }>({
        type: "toggle",
        name: "value",
        message: `${arg.label}${arg.required ? " (required)" : ""}`,
        initial: Boolean(arg.defaultValue),
        active: "yes",
        inactive: "no",
      });
      if (answer.value) {
        args[arg.key] = true;
      } else if (arg.required) {
        args[arg.key] = false;
      }
      continue;
    }

    if (arg.type === "number") {
      const answer = await promptOrThrow<{ value: number | string }>({
        type: "number",
        name: "value",
        message: `${arg.label}${arg.required ? " (required)" : ""}`,
        initial: typeof arg.defaultValue === "number" ? arg.defaultValue : undefined,
      });
      const numeric = Number(answer.value);
      if (!Number.isFinite(numeric)) {
        if (arg.required) {
          throw new Error(`${arg.key} is required and must be a number.`);
        }
        continue;
      }
      args[arg.key] = numeric;
      continue;
    }

    const answer = await promptOrThrow<{ value: string }>({
      type: "text",
      name: "value",
      message: `${arg.label}${arg.required ? " (required)" : ""}`,
      initial: typeof arg.defaultValue === "string" ? arg.defaultValue : "",
    });
    const value = answer.value.trim();
    if (!value) {
      if (arg.required) {
        throw new Error(`${arg.key} is required.`);
      }
      continue;
    }
    args[arg.key] = value;
  }
  return args;
};

const runWorkflowSteps = async (steps: WorkflowStep[], stopOnError: boolean, globalArgs: XArgMap) => {
  const results: Array<{
    index: number;
    endpoint: string;
    waitMs: number;
    result: Awaited<ReturnType<typeof runX>>;
  }> = [];

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (step.waitMs > 0) {
      await wait(step.waitMs);
    }
    const result = await runX(step.endpoint, step.args, globalArgs);
    results.push({
      index: i,
      endpoint: step.endpoint,
      waitMs: step.waitMs,
      result,
    });
    if (stopOnError && !result.ok) {
      break;
    }
  }
  return results;
};

const runOnboardingWizard = async () => {
  let current = await getOnboardingState();

  const importToggle = await promptOrThrow<{ enabled: boolean }>({
    type: "toggle",
    name: "enabled",
    message: "Import local env/config secrets before onboarding?",
    initial: false,
    active: "yes",
    inactive: "no",
  });

  if (importToggle.enabled) {
    const importOptions = await promptOrThrow<{
      includeProcessEnv: boolean;
      includeHomeDefaults: boolean;
      includeShellProfiles: boolean;
      includeClaudeAuth: boolean;
      overrideExisting: boolean;
      additionalPaths: string;
    }>([
      {
        type: "toggle",
        name: "includeProcessEnv",
        message: "Include process.env",
        initial: false,
        active: "yes",
        inactive: "no",
      },
      {
        type: "toggle",
        name: "includeHomeDefaults",
        message: "Include home defaults (~/.config, ~/.claude, ~/.codex)",
        initial: true,
        active: "yes",
        inactive: "no",
      },
      {
        type: "toggle",
        name: "includeShellProfiles",
        message: "Include shell profiles (~/.zshrc, ~/.bashrc)",
        initial: false,
        active: "yes",
        inactive: "no",
      },
      {
        type: "toggle",
        name: "includeClaudeAuth",
        message: "Include Claude auth/config files",
        initial: true,
        active: "yes",
        inactive: "no",
      },
      {
        type: "toggle",
        name: "overrideExisting",
        message: "Override existing onboarding values",
        initial: false,
        active: "yes",
        inactive: "no",
      },
      {
        type: "text",
        name: "additionalPaths",
        message: "Additional file paths (optional, comma/newline separated)",
        initial: "",
      },
    ]);

    const imported = await importLocalSecrets(current, {
      includeProcessEnv: importOptions.includeProcessEnv,
      includeHomeDefaults: importOptions.includeHomeDefaults,
      includeShellProfiles: importOptions.includeShellProfiles,
      includeClaudeAuth: importOptions.includeClaudeAuth,
      additionalPaths: parsePathList(importOptions.additionalPaths),
      overrideExisting: importOptions.overrideExisting,
    });

    if (Object.keys(imported.patch).length > 0) {
      current = await saveOnboardingState(imported.patch);
    }

    // eslint-disable-next-line no-console
    console.log(
      pretty({
        detectedCount: imported.detectedFields.length,
        updatedCount: imported.updatedFields.length,
        detectedFields: imported.detectedFields,
        updatedFields: imported.updatedFields,
        sourcesRead: imported.sourcesRead,
        sourcesWithMatches: imported.sourcesWithMatches,
        warnings: imported.warnings,
      }),
    );
  }

  const apiPrompt = await promptOrThrow<{ apiKey: string; saveApiKeyLocally: boolean }>([
    {
      type: "password",
      name: "apiKey",
      message: "OpenRouter API key (optional, press enter to skip)",
      initial: current.openrouter.saveApiKeyLocally ? current.openrouter.apiKey || "" : "",
    },
    {
      type: "toggle",
      name: "saveApiKeyLocally",
      message: "Save OpenRouter key in local onboarding config",
      initial: current.openrouter.saveApiKeyLocally,
      active: "yes",
      inactive: "no",
    },
  ]);

  const apiKey = apiPrompt.apiKey.trim();
  let cache = await getModelCache();
  if (apiKey) {
    // eslint-disable-next-line no-console
    console.log("Testing OpenRouter key...");
    const test = await testOpenRouterKey(apiKey);
    // eslint-disable-next-line no-console
    console.log(pretty(test));
    // eslint-disable-next-line no-console
    console.log("Refreshing model cache...");
    cache = await refreshModelCache(apiKey);
    // eslint-disable-next-line no-console
    console.log(`Model cache updated with ${cache.totalCount} models.`);
  }

  const defaults = {
    textSmall: await chooseModel("Default text model (small)", cache, "text", current.openrouter.defaults.textSmall),
    textLarge: await chooseModel("Default text model (large)", cache, "text", current.openrouter.defaults.textLarge),
    imagePrimary: await chooseModel("Default image model", cache, "image", current.openrouter.defaults.imagePrimary),
    videoPrimary: await chooseModel("Default video model", cache, "video", current.openrouter.defaults.videoPrimary),
    embeddingPrimary: await chooseModel(
      "Default embedding model",
      cache,
      "embedding",
      current.openrouter.defaults.embeddingPrimary,
    ),
    voicePrimary: await chooseModel("Default voice model", cache, "voice", current.openrouter.defaults.voicePrimary),
  };

  const fallbacks = {
    textFallback: await chooseModel("Fallback text model", cache, "text", current.openrouter.fallbacks.textFallback),
    imageFallback: await chooseModel("Fallback image model", cache, "image", current.openrouter.fallbacks.imageFallback),
    videoFallback: await chooseModel("Fallback video model", cache, "video", current.openrouter.fallbacks.videoFallback),
    embeddingFallback: await chooseModel(
      "Fallback embedding model",
      cache,
      "embedding",
      current.openrouter.fallbacks.embeddingFallback,
    ),
    voiceFallback: await chooseModel("Fallback voice model", cache, "voice", current.openrouter.fallbacks.voiceFallback),
  };

  const xAccount = await promptOrThrow<{
    username: string;
    password: string;
    email: string;
    savePasswordLocally: boolean;
    testLoginNow: boolean;
  }>([
    { type: "text", name: "username", message: "X username (optional)", initial: current.x.username || "" },
    { type: "password", name: "password", message: "X password (optional)", initial: "" },
    { type: "text", name: "email", message: "X email (optional)", initial: current.x.email || "" },
    {
      type: "toggle",
      name: "savePasswordLocally",
      message: "Save X password in local onboarding config",
      initial: current.x.savePasswordLocally,
      active: "yes",
      inactive: "no",
    },
    {
      type: "toggle",
      name: "testLoginNow",
      message: "Test login now (opens browser flow)",
      initial: false,
      active: "yes",
      inactive: "no",
    },
  ]);

  if (xAccount.testLoginNow) {
    const hasCredentials = Boolean(xAccount.username.trim() && xAccount.password.trim());
    const result = hasCredentials
      ? await runX("refresh_login_v3", {
          userName: xAccount.username.trim(),
          password: xAccount.password,
          email: xAccount.email.trim() || undefined,
        })
      : await runX("user_login_v3", {
          userName: xAccount.username.trim() || undefined,
          email: xAccount.email.trim() || undefined,
        });
    // eslint-disable-next-line no-console
    console.log(pretty(result));
  }

  const persona = await promptOrThrow<{
    stylePrompt: string;
    voiceStyle: string;
    deriveMode: PersonaSourceType;
    sourceValue: string;
    autoDeriveFromProfile: boolean;
  }>([
    {
      type: "text",
      name: "stylePrompt",
      message: "Agent style prompt (optional)",
      initial: current.persona.stylePrompt || "",
    },
    {
      type: "text",
      name: "voiceStyle",
      message: "Agent voice/tone description (optional)",
      initial: current.persona.voiceStyle || "",
    },
    {
      type: "select",
      name: "deriveMode",
      message: "Persona source mode",
      choices: [
        { title: "manual", value: "manual" },
        { title: "active_profile", value: "active_profile" },
        { title: "x_username", value: "x_username" },
        { title: "x_url", value: "x_url" },
      ],
      initial: ["manual", "active_profile", "x_username", "x_url"].indexOf(current.persona.deriveMode),
    },
    {
      type: "text",
      name: "sourceValue",
      message: "Persona source value (username or URL when needed)",
      initial: current.persona.sourceValue || "",
    },
    {
      type: "toggle",
      name: "autoDeriveFromProfile",
      message: "Auto-derive persona on startup",
      initial: current.persona.autoDeriveFromProfile,
      active: "yes",
      inactive: "no",
    },
  ]);

  const pordie = await promptOrThrow<{
    scope: OnboardingPordie["scope"];
    enabled: boolean;
    autoExportOnComplete: boolean;
    syncProjectEnv: boolean;
  }>([
    {
      type: "select",
      name: "scope",
      message: "Prompt or Die config scope",
      choices: [
        { title: "global (~/.pordie)", value: "global" },
        { title: "project (./.pordie)", value: "project" },
      ],
      initial: resolvePordieScope(current.pordie.scope) === "project" ? 1 : 0,
    },
    {
      type: "toggle",
      name: "enabled",
      message: "Enable Prompt or Die config export (.pordie folder)",
      initial: current.pordie.enabled,
      active: "yes",
      inactive: "no",
    },
    {
      type: "toggle",
      name: "autoExportOnComplete",
      message: "Auto-export env/config on onboarding complete",
      initial: current.pordie.autoExportOnComplete,
      active: "yes",
      inactive: "no",
    },
    {
      type: "toggle",
      name: "syncProjectEnv",
      message: "Also sync exported values into project .env",
      initial: current.pordie.syncProjectEnv,
      active: "yes",
      inactive: "no",
    },
  ]);

  const completed = await completeOnboarding({
    openrouter: {
      saveApiKeyLocally: apiPrompt.saveApiKeyLocally,
      apiKey: apiPrompt.saveApiKeyLocally && apiKey ? apiKey : undefined,
      defaults: {
        textSmall: defaults.textSmall || undefined,
        textLarge: defaults.textLarge || undefined,
        imagePrimary: defaults.imagePrimary || undefined,
        videoPrimary: defaults.videoPrimary || undefined,
        embeddingPrimary: defaults.embeddingPrimary || undefined,
        voicePrimary: defaults.voicePrimary || undefined,
      },
      fallbacks: {
        textFallback: fallbacks.textFallback || undefined,
        imageFallback: fallbacks.imageFallback || undefined,
        videoFallback: fallbacks.videoFallback || undefined,
        embeddingFallback: fallbacks.embeddingFallback || undefined,
        voiceFallback: fallbacks.voiceFallback || undefined,
      },
    },
    x: {
      username: xAccount.username.trim() || undefined,
      email: xAccount.email.trim() || undefined,
      savePasswordLocally: xAccount.savePasswordLocally,
      password: xAccount.savePasswordLocally && xAccount.password.trim() ? xAccount.password : undefined,
    },
    persona: {
      stylePrompt: persona.stylePrompt.trim() || undefined,
      voiceStyle: persona.voiceStyle.trim() || undefined,
      deriveMode: persona.deriveMode,
      sourceValue: persona.sourceValue.trim() || undefined,
      autoDeriveFromProfile: persona.autoDeriveFromProfile,
      characterPrompt: current.persona.characterPrompt || undefined,
    },
    pordie: {
      scope: pordie.scope,
      enabled: pordie.enabled,
      autoExportOnComplete: pordie.autoExportOnComplete,
      syncProjectEnv: pordie.syncProjectEnv,
    },
  });

  if (completed.pordie.enabled && completed.pordie.autoExportOnComplete) {
    const exported = await exportPromptOrDieConfig(completed, {
      scope: completed.pordie.scope,
      syncProjectEnv: completed.pordie.syncProjectEnv,
    });
    // eslint-disable-next-line no-console
    console.log("Prompt or Die export completed.");
    // eslint-disable-next-line no-console
    console.log(pretty(exported));
  }

  // eslint-disable-next-line no-console
  console.log("Onboarding saved.");
  // eslint-disable-next-line no-console
  console.log(pretty(completed));
};

const maybeRunOnboarding = async () => {
  const state = await getOnboardingState();
  if (!state.completed) {
    // eslint-disable-next-line no-console
    console.log("Onboarding is required before using dashboard tools.");
    await runOnboardingWizard();
    return;
  }
  const answer = await promptOrThrow<{ rerun: boolean }>({
    type: "toggle",
    name: "rerun",
    message: "Rerun onboarding now?",
    initial: false,
    active: "yes",
    inactive: "no",
  });
  if (answer.rerun) {
    await runOnboardingWizard();
  }
};

const runSingleEndpointFlow = async () => {
  const endpoint = await pickEndpoint();
  const args = await collectEndpointArgs(endpoint);
  const globalArgs = await askGlobalOverrides();
  const result = await runX(endpoint.endpoint, args, globalArgs);
  // eslint-disable-next-line no-console
  console.log(pretty(result));
};

const composeTweetFlow = async () => {
  const mode = await promptOrThrow<{ mode: "manual" | "ai" }>({
    type: "select",
    name: "mode",
    message: "Compose mode",
    choices: [
      { title: "Manual", value: "manual" },
      { title: "AI-assisted", value: "ai" },
    ],
    initial: 1,
  });

  let draft = "";
  if (mode.mode === "ai") {
    const onboarding = await getOnboardingState();
    const aiInput = await promptOrThrow<{ topic: string; tone: string; includeHashtags: boolean }>([
      { type: "text", name: "topic", message: "Topic / intent", initial: "Operating from Prompt or Die." },
      {
        type: "text",
        name: "tone",
        message: "Tone",
        initial: onboarding.persona.voiceStyle || onboarding.persona.stylePrompt || "confident and concise",
      },
      {
        type: "toggle",
        name: "includeHashtags",
        message: "Include hashtags",
        initial: false,
        active: "yes",
        inactive: "no",
      },
    ]);
    const ai = await runAIText({
      system:
        "Write one single X post under 260 characters. Output only the tweet body, no quotes, no markdown, no explanation.",
      prompt: `Topic: ${aiInput.topic}\nTone: ${aiInput.tone}\nInclude hashtags: ${aiInput.includeHashtags ? "yes" : "no"}`,
      temperature: 0.7,
    });
    draft = ai.text.trim();
    // eslint-disable-next-line no-console
    console.log(`\nAI draft:\n${draft}\n`);
  }

  const editor = await promptOrThrow<{ text: string; postNow: boolean }>([
    {
      type: "text",
      name: "text",
      message: "Final tweet text",
      initial: draft,
      validate: (value: string) => (String(value).trim() ? true : "Tweet text is required"),
    },
    {
      type: "toggle",
      name: "postNow",
      message: "Post now",
      initial: true,
      active: "yes",
      inactive: "no",
    },
  ]);

  if (!editor.postNow) {
    // eslint-disable-next-line no-console
    console.log(editor.text.trim());
    return;
  }

  const globalArgs = await askGlobalOverrides();
  const result = await runX("send_tweet_v3", { text: editor.text.trim() }, globalArgs);
  // eslint-disable-next-line no-console
  console.log(pretty(result));
};

const aiWorkflowPlannerFlow = async () => {
  const input = await promptOrThrow<{ goal: string; context: string; model: string }>([
    { type: "text", name: "goal", message: "Workflow goal", validate: (value: string) => (String(value).trim() ? true : "Goal is required") },
    { type: "text", name: "context", message: "Context (optional)", initial: "" },
    { type: "text", name: "model", message: "Model override (optional)", initial: "" },
  ]);

  const planned = await runAutomationPlanner({
    goal: input.goal.trim(),
    context: input.context.trim() || undefined,
    model: input.model.trim() || undefined,
  });

  // eslint-disable-next-line no-console
  console.log(pretty(planned));

  const steps = (planned.plan.steps || []).map((step) => ({
    endpoint: step.endpoint,
    args: (step.args || {}) as XArgMap,
    waitMs: step.waitMs || 0,
  }));

  const runNow = await promptOrThrow<{ run: boolean }>({
    type: "toggle",
    name: "run",
    message: "Run this plan now",
    initial: true,
    active: "yes",
    inactive: "no",
  });

  if (runNow.run && steps.length) {
    const settings = await promptOrThrow<{ stopOnError: boolean }>({
      type: "toggle",
      name: "stopOnError",
      message: "Stop on first failure",
      initial: true,
      active: "yes",
      inactive: "no",
    });
    const globalArgs = await askGlobalOverrides();
    const results = await runWorkflowSteps(steps, settings.stopOnError, globalArgs);
    // eslint-disable-next-line no-console
    console.log(pretty(results));
  }

  const save = await promptOrThrow<{ save: boolean }>({
    type: "toggle",
    name: "save",
    message: "Save this workflow",
    initial: true,
    active: "yes",
    inactive: "no",
  });

  if (save.save && steps.length) {
    const name = await promptOrThrow<{ name: string }>({
      type: "text",
        name: "name",
        message: "Workflow name",
        initial: planned.plan.title,
        validate: (value: string) => (String(value).trim() ? true : "Name is required"),
    });
    const existing = await loadSavedWorkflows();
    existing.unshift({
      name: name.name.trim(),
      createdAt: new Date().toISOString(),
      steps,
    });
    await saveSavedWorkflows(existing.slice(0, 100));
    // eslint-disable-next-line no-console
    console.log("Workflow saved.");
  }
};

const workflowStudioFlow = async () => {
  const steps: WorkflowStep[] = [];
  while (true) {
    // eslint-disable-next-line no-console
    console.log("\nCurrent workflow:");
    // eslint-disable-next-line no-console
    console.log(steps.length ? pretty(steps) : "[]");

    const action = await promptOrThrow<{ action: string }>({
      type: "select",
      name: "action",
      message: "Workflow Studio",
      choices: [
        { title: "Add step", value: "add" },
        { title: "Remove last step", value: "remove" },
        { title: "Run workflow", value: "run" },
        { title: "Save workflow", value: "save" },
        { title: "Exit studio", value: "exit" },
      ],
      initial: 0,
    });

    if (action.action === "exit") {
      return;
    }
    if (action.action === "add") {
      const endpoint = await pickEndpoint();
      const args = await collectEndpointArgs(endpoint);
      const waitAnswer = await promptOrThrow<{ waitMs: number | string }>({
        type: "number",
        name: "waitMs",
        message: "Delay before this step (ms)",
        initial: 0,
      });
      const waitMs = Number(waitAnswer.waitMs);
      steps.push({
        endpoint: endpoint.endpoint,
        args,
        waitMs: Number.isFinite(waitMs) ? Math.max(0, Math.min(60_000, Math.trunc(waitMs))) : 0,
      });
      continue;
    }
    if (action.action === "remove") {
      steps.pop();
      continue;
    }
    if (action.action === "run") {
      if (!steps.length) {
        // eslint-disable-next-line no-console
        console.log("No steps.");
        continue;
      }
      const stop = await promptOrThrow<{ stopOnError: boolean }>({
        type: "toggle",
        name: "stopOnError",
        message: "Stop on first failure",
        initial: true,
        active: "yes",
        inactive: "no",
      });
      const globalArgs = await askGlobalOverrides();
      const results = await runWorkflowSteps(steps, stop.stopOnError, globalArgs);
      // eslint-disable-next-line no-console
      console.log(pretty(results));
      continue;
    }
    if (action.action === "save") {
      if (!steps.length) {
        // eslint-disable-next-line no-console
        console.log("No steps.");
        continue;
      }
      const name = await promptOrThrow<{ name: string }>({
        type: "text",
        name: "name",
        message: "Workflow name",
        validate: (value: string) => (String(value).trim() ? true : "Name required"),
      });
      const existing = await loadSavedWorkflows();
      existing.unshift({
        name: name.name.trim(),
        createdAt: new Date().toISOString(),
        steps: [...steps],
      });
      await saveSavedWorkflows(existing.slice(0, 100));
      // eslint-disable-next-line no-console
      console.log("Saved.");
    }
  }
};

const savedWorkflowFlow = async () => {
  const workflows = await loadSavedWorkflows();
  if (!workflows.length) {
    // eslint-disable-next-line no-console
    console.log("No saved workflows.");
    return;
  }
  const pick = await promptOrThrow<{ idx: number | string }>({
    type: "select",
    name: "idx",
    message: "Saved workflows",
    choices: workflows.map((workflow, index) => ({
      title: `${workflow.name} (${workflow.steps.length} steps)`,
      description: workflow.createdAt,
      value: index,
    })),
    initial: 0,
  });
  const idx = Number(pick.idx);
  const selected = workflows[idx];
  if (!selected) {
    throw new Error("Invalid selection.");
  }

  const action = await promptOrThrow<{ action: string }>({
    type: "select",
    name: "action",
    message: selected.name,
    choices: [
      { title: "Run", value: "run" },
      { title: "View JSON", value: "view" },
      { title: "Delete", value: "delete" },
      { title: "Back", value: "back" },
    ],
    initial: 0,
  });
  if (action.action === "back") {
    return;
  }
  if (action.action === "view") {
    // eslint-disable-next-line no-console
    console.log(pretty(selected));
    return;
  }
  if (action.action === "delete") {
    const next = workflows.filter((_item, index) => index !== idx);
    await saveSavedWorkflows(next);
    // eslint-disable-next-line no-console
    console.log("Deleted.");
    return;
  }
  if (action.action === "run") {
    const stop = await promptOrThrow<{ stopOnError: boolean }>({
      type: "toggle",
      name: "stopOnError",
      message: "Stop on first failure",
      initial: true,
      active: "yes",
      inactive: "no",
    });
    const globalArgs = await askGlobalOverrides();
    const results = await runWorkflowSteps(selected.steps, stop.stopOnError, globalArgs);
    // eslint-disable-next-line no-console
    console.log(pretty(results));
  }
};

const aiChatFlow = async () => {
  const input = await promptOrThrow<{ model: string; system: string; prompt: string }>([
    { type: "text", name: "model", message: "Model override (optional)", initial: "" },
    { type: "text", name: "system", message: "System prompt (optional)", initial: "" },
    { type: "text", name: "prompt", message: "Prompt", validate: (value: string) => (String(value).trim() ? true : "Prompt required") },
  ]);
  const result = await runAIText({
    model: input.model.trim() || undefined,
    system: input.system.trim() || undefined,
    prompt: input.prompt.trim(),
  });
  // eslint-disable-next-line no-console
  console.log(pretty(result));
};

const exportPordieNowFlow = async () => {
  const onboarding = await getOnboardingState();
  if (!onboarding.pordie.enabled) {
    // eslint-disable-next-line no-console
    console.log("Prompt or Die export is disabled in onboarding.");
    return;
  }
  const options = await promptOrThrow<{ syncProjectEnv: boolean }>({
    type: "toggle",
    name: "syncProjectEnv",
    message: "Sync exported values into project .env",
    initial: onboarding.pordie.syncProjectEnv,
    active: "yes",
    inactive: "no",
  });
  const exported = await exportPromptOrDieConfig(onboarding, {
    scope: onboarding.pordie.scope,
    syncProjectEnv: options.syncProjectEnv,
  });
  // eslint-disable-next-line no-console
  console.log(pretty(exported));
};

const menu = async () => {
  while (true) {
    const answer = await promptOrThrow<{ action: string }>({
      type: "select",
      name: "action",
      message: "Prompt or Die Social Suite TUI",
      choices: [
        { title: "Run Onboarding Wizard", value: "onboarding" },
        { title: "Export Prompt or Die Env Now", value: "export-pordie" },
        { title: "Command Palette (Run Endpoint)", value: "run-endpoint" },
        { title: "Compose and Post Tweet", value: "tweet" },
        { title: "AI Workflow Planner", value: "ai-planner" },
        { title: "Workflow Studio (Manual Builder)", value: "workflow-studio" },
        { title: "Saved Workflows", value: "saved-workflows" },
        { title: "AI Chat Sandbox", value: "ai-chat" },
        { title: "Exit", value: "exit" },
      ],
      initial: 1,
    });

    if (answer.action === "exit") {
      return;
    }
    try {
      if (answer.action === "onboarding") {
        await runOnboardingWizard();
      } else if (answer.action === "export-pordie") {
        await exportPordieNowFlow();
      } else if (answer.action === "run-endpoint") {
        await runSingleEndpointFlow();
      } else if (answer.action === "tweet") {
        await composeTweetFlow();
      } else if (answer.action === "ai-planner") {
        await aiWorkflowPlannerFlow();
      } else if (answer.action === "workflow-studio") {
        await workflowStudioFlow();
      } else if (answer.action === "saved-workflows") {
        await savedWorkflowFlow();
      } else if (answer.action === "ai-chat") {
        await aiChatFlow();
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
};

const main = async () => {
  // eslint-disable-next-line no-console
  console.log("Prompt or Die Social Suite TUI");
  // eslint-disable-next-line no-console
  console.log(`X runner: ${appConfig.xLocal.scriptPath}`);
  // eslint-disable-next-line no-console
  console.log(`OpenRouter env key loaded: ${Boolean(appConfig.openrouter.apiKey)}`);
  await maybeRunOnboarding();
  await menu();
};

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
