import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output } from "ai";
import { z } from "zod";

import { appConfig, modelCachePath } from "../config.js";
import { getOnboardingState } from "../onboarding.js";
import { readJsonFile, writeJsonFile } from "../state/store.js";
import type { AITextInput, AutomationPlan, OpenRouterModelCache, OpenRouterModelRecord } from "../types.js";
import { xEndpointCatalog } from "../x/catalog.js";

interface OpenRouterRuntime {
  apiKey?: string;
  baseUrl: string;
  referer: string;
  appTitle: string;
}

interface RawOpenRouterModel {
  id?: string;
  name?: string;
  description?: string;
  context_length?: number;
  input_modalities?: string[] | string;
  output_modalities?: string[] | string;
  modalities?: string[] | string;
  architecture?: {
    input_modalities?: string[] | string;
    output_modalities?: string[] | string;
    modality?: string;
  };
  supported_parameters?: string[];
  pricing?: {
    prompt?: string;
    completion?: string;
  };
}

const automationPlanSchema = z.object({
  title: z.string().min(1),
  objective: z.string().min(1),
  safetyChecks: z.array(z.string()).default([]),
  steps: z
    .array(
      z.object({
        endpoint: z.string().min(1),
        description: z.string().min(1),
        waitMs: z.number().int().min(0).max(60_000).default(0),
        args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))])).default({}),
      }),
    )
    .min(1)
    .max(20),
});

const resolveRuntime = async (overrideApiKey?: string): Promise<OpenRouterRuntime> => {
  const onboarding = await getOnboardingState();
  const apiKey = overrideApiKey?.trim() || onboarding.openrouter.apiKey?.trim() || appConfig.openrouter.apiKey;
  return {
    apiKey: apiKey || undefined,
    baseUrl: appConfig.openrouter.baseUrl,
    referer: appConfig.openrouter.referer,
    appTitle: appConfig.openrouter.appTitle,
  };
};

const ensureRuntimeKey = (runtime: OpenRouterRuntime) => {
  if (!runtime.apiKey) {
    throw new Error("OpenRouter API key is missing.");
  }
};

const headersFor = (runtime: OpenRouterRuntime): Record<string, string> => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "HTTP-Referer": runtime.referer,
    "X-Title": runtime.appTitle,
  };
  if (runtime.apiKey) {
    headers.Authorization = `Bearer ${runtime.apiKey}`;
  }
  return headers;
};

const parsePrice = (value: unknown): number | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const normalizeLabel = (value: unknown): string => {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
};

const uniqueStrings = (values: string[]): string[] => Array.from(new Set(values.filter(Boolean)));

const normalizeListLike = (values: unknown): string[] => {
  if (Array.isArray(values)) {
    return uniqueStrings(values.map((entry) => normalizeLabel(String(entry || ""))));
  }
  const single = normalizeLabel(values);
  return single ? [single] : [];
};

const parseDirectionalModality = (value: unknown): { input: string[]; output: string[] } => {
  if (typeof value !== "string") {
    return { input: [], output: [] };
  }
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return { input: [], output: [] };
  }

  const parts = trimmed.split("->").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 2) {
    return {
      input: normalizeListLike(parts[0]),
      output: normalizeListLike(parts[1]),
    };
  }
  const shared = normalizeListLike(trimmed);
  return { input: shared, output: shared };
};

const toTokenSet = (values: string[]): Set<string> => {
  const tokens = new Set<string>();
  for (const value of values) {
    const normalized = normalizeLabel(value);
    if (!normalized) {
      continue;
    }
    tokens.add(normalized);
    const parts = normalized.split(/[^a-z0-9]+/g).filter(Boolean);
    for (const part of parts) {
      tokens.add(part);
      if (part.endsWith("s") && part.length > 3) {
        tokens.add(part.slice(0, -1));
      }
    }
  }
  return tokens;
};

const hasAnyToken = (tokens: Set<string>, needles: string[]): boolean => {
  return needles.some((needle) => tokens.has(needle));
};

const modelSignals = (model: OpenRouterModelRecord) => {
  const input = toTokenSet(model.inputModalities);
  const output = toTokenSet(model.outputModalities);
  const supported = toTokenSet(model.supportedParameters);
  const id = toTokenSet([model.id]);
  const description = toTokenSet([model.description || ""]);
  return { input, output, supported, id, description };
};

const normalizeModel = (raw: RawOpenRouterModel): OpenRouterModelRecord | null => {
  const id = String(raw.id || "").trim();
  if (!id) {
    return null;
  }
  const directional = parseDirectionalModality(raw.architecture?.modality);
  const inputModalities = uniqueStrings([
    ...normalizeListLike(raw.architecture?.input_modalities),
    ...normalizeListLike(raw.input_modalities),
    ...normalizeListLike(raw.modalities),
    ...directional.input,
  ]);
  const outputModalities = uniqueStrings([
    ...normalizeListLike(raw.architecture?.output_modalities),
    ...normalizeListLike(raw.output_modalities),
    ...directional.output,
  ]);
  return {
    id,
    name: raw.name,
    description: raw.description,
    inputModalities,
    outputModalities,
    supportedParameters: normalizeListLike(raw.supported_parameters),
    contextLength: typeof raw.context_length === "number" ? raw.context_length : undefined,
    promptPrice: parsePrice(raw.pricing?.prompt),
    completionPrice: parsePrice(raw.pricing?.completion),
  };
};

const isTextModel = (model: OpenRouterModelRecord): boolean => {
  const signals = modelSignals(model);
  if (hasAnyToken(signals.output, ["embedding"])) {
    return false;
  }
  const hasTextInput = hasAnyToken(signals.input, ["text"]);
  const hasTextOutput = hasAnyToken(signals.output, ["text"]);
  if (hasTextInput || hasTextOutput) {
    return true;
  }
  if (hasAnyToken(signals.output, ["image", "audio", "voice", "speech"])) {
    return false;
  }
  if (hasAnyToken(signals.supported, ["response_format", "tools", "temperature", "max_tokens", "top_p", "top_k"])) {
    return true;
  }
  return model.inputModalities.length === 0 && model.outputModalities.length === 0;
};

const isImageModel = (model: OpenRouterModelRecord): boolean => {
  const signals = modelSignals(model);
  if (hasAnyToken(signals.output, ["image"])) {
    return true;
  }
  const hasImageIdHint = hasAnyToken(signals.id, [
    "image",
    "images",
    "flux",
    "seedream",
    "dalle",
    "sdxl",
    "stable",
    "diffusion",
    "imagen",
    "ideogram",
    "recraft",
    "playground",
    "midjourney",
    "photon",
  ]);
  if (!hasImageIdHint) {
    return false;
  }
  if (hasAnyToken(signals.output, ["embedding", "audio", "voice", "speech"])) {
    return false;
  }
  return true;
};

const isVideoModel = (model: OpenRouterModelRecord): boolean => {
  const signals = modelSignals(model);
  if (hasAnyToken(signals.input, ["video"]) || hasAnyToken(signals.output, ["video"])) {
    return true;
  }
  if (hasAnyToken(signals.supported, ["input_video", "video", "video_url", "video_frame", "frame_rate"])) {
    return true;
  }
  if (hasAnyToken(signals.id, ["video", "veo", "wan", "kling", "seedance", "sora", "lipsync"])) {
    return true;
  }
  return hasAnyToken(signals.description, ["video", "videos", "multiframe", "frame"]);
};

const isVoiceModel = (model: OpenRouterModelRecord): boolean => {
  const signals = modelSignals(model);
  if (hasAnyToken(signals.input, ["audio", "voice", "speech"])) {
    return true;
  }
  if (hasAnyToken(signals.output, ["audio", "voice", "speech"])) {
    return true;
  }
  return (
    hasAnyToken(signals.id, ["audio", "voice", "speech", "whisper", "tts", "stt", "transcribe", "transcription"]) ||
    hasAnyToken(signals.supported, ["input_audio", "audio", "voice", "speech", "transcript", "transcription"])
  );
};

const isEmbeddingModel = (model: OpenRouterModelRecord): boolean => {
  const signals = modelSignals(model);
  return (
    hasAnyToken(signals.id, ["embedding", "embed"]) ||
    hasAnyToken(signals.supported, ["embedding"]) ||
    hasAnyToken(signals.output, ["embedding"])
  );
};

const stableSort = (ids: OpenRouterModelRecord[]): OpenRouterModelRecord[] => {
  return ids.sort((a, b) => {
    const pa = a.promptPrice ?? Number.POSITIVE_INFINITY;
    const pb = b.promptPrice ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) {
      return pa - pb;
    }
    const ca = a.contextLength ?? 0;
    const cb = b.contextLength ?? 0;
    if (ca !== cb) {
      return cb - ca;
    }
    return a.id.localeCompare(b.id);
  });
};

const buildModelCache = (models: OpenRouterModelRecord[]): OpenRouterModelCache => {
  const normalized = stableSort([...models]);
  const text = uniqueStrings(normalized.filter(isTextModel).map((model) => model.id));
  const image = uniqueStrings(normalized.filter(isImageModel).map((model) => model.id));
  const video = uniqueStrings(normalized.filter(isVideoModel).map((model) => model.id));
  const embedding = uniqueStrings(normalized.filter(isEmbeddingModel).map((model) => model.id));
  const voice = uniqueStrings(normalized.filter(isVoiceModel).map((model) => model.id));

  const textLargeCandidate =
    normalized.find((model) => isTextModel(model) && (model.contextLength ?? 0) >= 100_000)?.id || text[0];

  return {
    fetchedAt: new Date().toISOString(),
    totalCount: normalized.length,
    models: normalized,
    groups: {
      text,
      image,
      video,
      embedding,
      voice,
    },
    recommendations: {
      textSmall: text[0],
      textLarge: textLargeCandidate,
      imagePrimary: image[0],
      videoPrimary: video[0],
      embeddingPrimary: embedding[0],
      voicePrimary: voice[0],
    },
  };
};

const fetchOpenRouterJson = async (runtime: OpenRouterRuntime, path: string, body?: Record<string, unknown>) => {
  const response = await fetch(`${runtime.baseUrl}${path}`, {
    method: body ? "POST" : "GET",
    headers: headersFor(runtime),
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`OpenRouter ${path} failed (${response.status}): ${JSON.stringify(parsed)}`);
  }
  return parsed;
};

export const testOpenRouterKey = async (apiKey?: string) => {
  const runtime = await resolveRuntime(apiKey);
  ensureRuntimeKey(runtime);
  const data = await fetchOpenRouterJson(runtime, "/models/user");
  const rows = Array.isArray((data as { data?: unknown }).data) ? ((data as { data: unknown[] }).data || []) : [];
  return {
    ok: true,
    count: rows.length,
    hasModels: rows.length > 0,
  };
};

export const refreshModelCache = async (apiKey?: string): Promise<OpenRouterModelCache> => {
  const runtime = await resolveRuntime(apiKey);
  ensureRuntimeKey(runtime);

  const embeddingCatalogPromise = fetchOpenRouterJson(runtime, "/models/embeddings")
    .catch(() => fetchOpenRouterJson(runtime, "/embeddings/models"))
    .catch(() => ({ data: [] }));

  const [generalRaw, embeddingRaw] = await Promise.all([
    fetchOpenRouterJson(runtime, "/models"),
    embeddingCatalogPromise,
  ]);

  const generalRows = Array.isArray((generalRaw as { data?: unknown }).data) ? ((generalRaw as { data: unknown[] }).data || []) : [];
  const embeddingRows = Array.isArray((embeddingRaw as { data?: unknown }).data)
    ? ((embeddingRaw as { data: unknown[] }).data || [])
    : [];

  const normalizedMap = new Map<string, OpenRouterModelRecord>();
  for (const row of [...generalRows, ...embeddingRows]) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const normalized = normalizeModel(row as RawOpenRouterModel);
    if (!normalized) {
      continue;
    }
    normalizedMap.set(normalized.id, normalized);
  }

  const cache = buildModelCache(Array.from(normalizedMap.values()));
  await writeJsonFile(modelCachePath, cache);
  return cache;
};

export const getModelCache = async (): Promise<OpenRouterModelCache | null> => {
  const loaded = await readJsonFile<OpenRouterModelCache | null>(modelCachePath, null);
  if (!loaded) {
    return null;
  }
  if (!Array.isArray(loaded.models)) {
    return null;
  }
  return loaded;
};

const resolveTextModelCandidates = async (explicitModel?: string): Promise<string[]> => {
  if (explicitModel?.trim()) {
    return [explicitModel.trim()];
  }
  const onboarding = await getOnboardingState();
  const cache = await getModelCache();
  const candidates = [
    onboarding.openrouter.defaults.textLarge,
    onboarding.openrouter.defaults.textSmall,
    onboarding.openrouter.fallbacks.textFallback,
    cache?.recommendations.textLarge,
    cache?.recommendations.textSmall,
    appConfig.openrouter.model,
  ].filter((value): value is string => Boolean(value && value.trim()));
  return Array.from(new Set(candidates));
};

const runWithFallback = async <T>(models: string[], runner: (model: string) => Promise<T>): Promise<{ model: string; data: T }> => {
  let lastError: unknown;
  for (const model of models) {
    try {
      const data = await runner(model);
      return { model, data };
    } catch (error) {
      lastError = error;
    }
  }
  throw (lastError instanceof Error ? lastError : new Error(String(lastError || "Unknown model fallback error")));
};

export const runAIText = async (input: AITextInput) => {
  const runtime = await resolveRuntime();
  ensureRuntimeKey(runtime);

  const modelCandidates = await resolveTextModelCandidates(input.model);
  if (modelCandidates.length === 0) {
    throw new Error("No text model configured.");
  }

  const { model, data } = await runWithFallback(modelCandidates, async (candidate) => {
    const client = createOpenAI({
      baseURL: runtime.baseUrl,
      apiKey: runtime.apiKey,
      headers: {
        "HTTP-Referer": runtime.referer,
        "X-Title": runtime.appTitle,
      },
    });
    return generateText({
      model: client(candidate),
      system:
        input.system?.trim() ||
        "You are Prompt or Die Social Suite AI. Keep outputs practical, concise, and automation-oriented.",
      prompt: input.prompt.trim(),
      temperature: input.temperature ?? 0.5,
    });
  });

  return {
    model,
    text: data.text,
    finishReason: data.finishReason ?? null,
    usage: data.usage ?? null,
    warnings: data.warnings ?? [],
  };
};

interface AutomationPlanInput {
  goal: string;
  context?: string;
  model?: string;
}

export const runAutomationPlanner = async (input: AutomationPlanInput): Promise<{ model: string; plan: AutomationPlan }> => {
  const runtime = await resolveRuntime();
  ensureRuntimeKey(runtime);

  const modelCandidates = await resolveTextModelCandidates(input.model);
  if (modelCandidates.length === 0) {
    throw new Error("No text model configured for planner.");
  }

  const endpointGuide = xEndpointCatalog
    .map((item) => {
      const args = item.args.map((arg) => `${arg.key}${arg.required ? "*" : ""}`).join(", ");
      return `- ${item.endpoint} (${item.category}): ${item.summary}. Args: ${args || "none"}`;
    })
    .join("\n");

  const planningPrompt = [
    `Goal: ${input.goal.trim()}`,
    `Context: ${input.context?.trim() || "None provided."}`,
    "Use read-only endpoints unless the goal explicitly requires write actions.",
    "Use small delays only when sequencing needs it.",
    "Allowed endpoints:",
    endpointGuide,
  ].join("\n\n");

  const { model, data } = await runWithFallback(modelCandidates, async (candidate) => {
    const client = createOpenAI({
      baseURL: runtime.baseUrl,
      apiKey: runtime.apiKey,
      headers: {
        "HTTP-Referer": runtime.referer,
        "X-Title": runtime.appTitle,
      },
    });
    return generateText({
      model: client(candidate),
      system:
        "You design local social automations. Return clear, executable plans with endpoint names and endpoint args only.",
      prompt: planningPrompt,
      temperature: 0.2,
      output: Output.object({
        schema: automationPlanSchema,
      }),
    });
  });
  const plan = (data as unknown as { output?: AutomationPlan; object?: AutomationPlan }).output
    ?? (data as unknown as { output?: AutomationPlan; object?: AutomationPlan }).object;
  if (!plan) {
    throw new Error("Planner did not return structured output.");
  }

  return {
    model,
    plan,
  };
};

const resolveConfiguredModel = async (
  explicit: string | undefined,
  primary: string | undefined,
  fallback: string | undefined,
  recommended: string | undefined,
): Promise<string[]> => {
  const models = [explicit, primary, fallback, recommended].filter((value): value is string => Boolean(value && value.trim()));
  return Array.from(new Set(models));
};

export const createImageFromPrompt = async (prompt: string, model?: string) => {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) {
    throw new Error("Prompt is required.");
  }

  const runtime = await resolveRuntime();
  ensureRuntimeKey(runtime);
  const onboarding = await getOnboardingState();
  const cache = await getModelCache();

  const candidates = await resolveConfiguredModel(
    model,
    onboarding.openrouter.defaults.imagePrimary,
    onboarding.openrouter.fallbacks.imageFallback,
    cache?.recommendations.imagePrimary,
  );
  if (candidates.length === 0) {
    throw new Error("No image model configured.");
  }

  const { model: usedModel, data } = await runWithFallback(candidates, async (candidate) => {
    return fetchOpenRouterJson(runtime, "/chat/completions", {
      model: candidate,
      messages: [{ role: "user", content: trimmedPrompt }],
      modalities: ["image", "text"],
    });
  });

  return {
    model: usedModel,
    response: data,
  };
};

export const createEmbedding = async (input: string | string[], model?: string) => {
  const runtime = await resolveRuntime();
  ensureRuntimeKey(runtime);
  const onboarding = await getOnboardingState();
  const cache = await getModelCache();

  const candidates = await resolveConfiguredModel(
    model,
    onboarding.openrouter.defaults.embeddingPrimary,
    onboarding.openrouter.fallbacks.embeddingFallback,
    cache?.recommendations.embeddingPrimary,
  );
  if (candidates.length === 0) {
    throw new Error("No embedding model configured.");
  }

  const { model: usedModel, data } = await runWithFallback(candidates, async (candidate) => {
    return fetchOpenRouterJson(runtime, "/embeddings", {
      model: candidate,
      input,
    });
  });

  return {
    model: usedModel,
    response: data,
  };
};

const normalizeVideoInput = (params: { videoUrl?: string; videoBase64?: string; format?: string }): string => {
  const direct = params.videoUrl?.trim();
  if (direct) {
    return direct;
  }
  const base64Raw = params.videoBase64?.trim();
  if (!base64Raw) {
    return "";
  }
  const cleaned = base64Raw.replace(/\s+/g, "");
  const format = (params.format?.trim() || "mp4").toLowerCase().replace(/[^a-z0-9]/g, "") || "mp4";
  if (cleaned.startsWith("data:video/")) {
    return cleaned;
  }
  return `data:video/${format};base64,${cleaned}`;
};

export const runVideoAnalysis = async (params: {
  videoUrl?: string;
  videoBase64?: string;
  format?: string;
  prompt?: string;
  model?: string;
}) => {
  const runtime = await resolveRuntime();
  ensureRuntimeKey(runtime);
  const onboarding = await getOnboardingState();
  const cache = await getModelCache();

  const videoInput = normalizeVideoInput(params);
  if (!videoInput) {
    throw new Error("videoUrl or videoBase64 is required.");
  }

  const candidates = await resolveConfiguredModel(
    params.model,
    onboarding.openrouter.defaults.videoPrimary,
    onboarding.openrouter.fallbacks.videoFallback,
    cache?.recommendations.videoPrimary,
  );
  if (candidates.length === 0) {
    throw new Error("No video-capable model configured.");
  }

  const prompt = params.prompt?.trim() || "Analyze this video and return concise, actionable findings.";

  const { model: usedModel, data } = await runWithFallback(candidates, async (candidate) => {
    return fetchOpenRouterJson(runtime, "/chat/completions", {
      model: candidate,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "video_url", video_url: { url: videoInput } },
          ],
        },
      ],
    });
  });

  return {
    model: usedModel,
    response: data,
  };
};

export const runVoiceAnalysis = async (params: {
  audioBase64: string;
  format?: string;
  prompt?: string;
  model?: string;
}) => {
  const runtime = await resolveRuntime();
  ensureRuntimeKey(runtime);
  const onboarding = await getOnboardingState();
  const cache = await getModelCache();

  const audioBase64 = params.audioBase64.trim();
  if (!audioBase64) {
    throw new Error("audioBase64 is required.");
  }

  const candidates = await resolveConfiguredModel(
    params.model,
    onboarding.openrouter.defaults.voicePrimary,
    onboarding.openrouter.fallbacks.voiceFallback,
    cache?.recommendations.voicePrimary,
  );
  if (candidates.length === 0) {
    throw new Error("No voice-capable model configured.");
  }

  const prompt = params.prompt?.trim() || "Transcribe and summarize this audio.";
  const format = params.format?.trim() || "wav";

  const { model: usedModel, data } = await runWithFallback(candidates, async (candidate) => {
    return fetchOpenRouterJson(runtime, "/chat/completions", {
      model: candidate,
      messages: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            {
              type: "input_audio",
              input_audio: {
                data: audioBase64,
                format,
              },
            },
          ],
        },
      ],
    });
  });

  return {
    model: usedModel,
    response: data,
  };
};
