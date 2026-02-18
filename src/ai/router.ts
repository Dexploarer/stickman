import { appConfig } from "../config.js";
import { getOnboardingState } from "../onboarding.js";
import type { AITextInput, AutomationPlan, ProviderMode, ProviderStatus } from "../types.js";
import { runAIText, runAutomationPlanner } from "./openrouter.js";
import { detectClaudeSession, runClaudeText } from "./claude-bridge.js";

const hasOpenRouterConfig = async (): Promise<boolean> => {
  const onboarding = await getOnboardingState();
  return Boolean(onboarding.openrouter.apiKey || appConfig.openrouter.apiKey);
};

const parseAutomationPlan = (raw: string): AutomationPlan => {
  const trimmed = raw.trim();
  const candidates = [
    trimmed,
    trimmed.replace(/^```json\s*/i, "").replace(/```$/i, "").trim(),
  ];
  let parsed: AutomationPlan | null = null;
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate) as AutomationPlan;
      break;
    } catch {
      parsed = null;
    }
  }
  if (!parsed) {
    throw new Error("Failed to parse automation plan JSON from Claude output.");
  }
  if (typeof parsed !== "object") {
    throw new Error("Invalid automation plan payload");
  }
  if (!parsed.title || !parsed.objective || !Array.isArray(parsed.steps)) {
    throw new Error("Automation plan is missing required fields");
  }
  return parsed;
};

const resolveTextRoute = (
  mode: ProviderMode,
  claudeSessionDetected: boolean,
  openrouterConfigured: boolean,
): "claude_subscription" | "openrouter" | "hybrid" => {
  if (mode === "claude_subscription") {
    if (!claudeSessionDetected) {
      throw new Error("Provider mode is claude_subscription, but no Claude session is detected.");
    }
    return "claude_subscription";
  }
  if (mode === "openrouter") {
    if (!openrouterConfigured) {
      throw new Error("Provider mode is openrouter, but no OpenRouter API key is configured.");
    }
    return "openrouter";
  }
  if (claudeSessionDetected && openrouterConfigured) {
    return "hybrid";
  }
  if (claudeSessionDetected) {
    return "claude_subscription";
  }
  if (openrouterConfigured) {
    return "openrouter";
  }
  throw new Error("Hybrid mode requires either a Claude session or an OpenRouter API key.");
};

export const getProviderStatus = async (): Promise<ProviderStatus> => {
  const onboarding = await getOnboardingState();
  const session = await detectClaudeSession();
  const openrouterConfigured = await hasOpenRouterConfig();
  let activeRoute: "claude_subscription" | "openrouter" | "hybrid";
  try {
    activeRoute = resolveTextRoute(
      onboarding.providers.mode,
      session.detected,
      openrouterConfigured,
    );
  } catch {
    if (onboarding.providers.mode === "hybrid") {
      activeRoute = session.detected
        ? "claude_subscription"
        : openrouterConfigured
          ? "openrouter"
          : "hybrid";
    } else {
      activeRoute = onboarding.providers.mode;
    }
  }

  return {
    mode: onboarding.providers.mode,
    claudeSessionDetected: session.detected,
    openrouterConfigured,
    activeRoute,
    capabilities: {
      text: activeRoute,
      image: "openrouter",
      video: "openrouter",
      embedding: "openrouter",
      voice: "openrouter",
    },
  };
};

export const ensureOpenRouterForModality = async (
  modality: "image" | "video" | "embedding" | "voice",
) => {
  const openrouterConfigured = await hasOpenRouterConfig();
  if (!openrouterConfigured) {
    throw new Error(
      `OpenRouter API key is required for ${modality} operations in the current provider configuration.`,
    );
  }
};

export const runTextWithProviderRouting = async (
  input: AITextInput,
): Promise<{ text: string; model?: string; provider: "claude_subscription" | "openrouter" | "hybrid" }> => {
  const status = await getProviderStatus();
  if (status.activeRoute === "claude_subscription") {
    const result = await runClaudeText({
      prompt: input.prompt,
      system: input.system,
    });
    return {
      text: result.text,
      provider: "claude_subscription",
    };
  }

  if (status.activeRoute === "hybrid") {
    try {
      const result = await runClaudeText({
        prompt: input.prompt,
        system: input.system,
      });
      return {
        text: result.text,
        provider: "hybrid",
      };
    } catch {
      const fallback = await runAIText(input);
      return {
        text: fallback.text,
        model: fallback.model,
        provider: "hybrid",
      };
    }
  }

  const result = await runAIText(input);
  return {
    text: result.text,
    model: result.model,
    provider: "openrouter",
  };
};

export const runAutomationPlannerWithRouting = async (input: {
  goal: string;
  context?: string;
  model?: string;
}): Promise<{ plan: AutomationPlan; model: string; provider: "claude_subscription" | "openrouter" | "hybrid" }> => {
  const status = await getProviderStatus();
  if (status.activeRoute === "claude_subscription") {
    const prompt = [
      "Return only strict JSON with no markdown.",
      "Schema: {\"title\":\"string\",\"objective\":\"string\",\"safetyChecks\":[\"string\"],\"steps\":[{\"endpoint\":\"string\",\"description\":\"string\",\"waitMs\":number,\"args\":{}}]}",
      `Goal: ${input.goal}`,
      input.context ? `Context: ${input.context}` : "",
      "Steps must use available X endpoint names and keep waitMs between 0 and 60000.",
    ]
      .filter(Boolean)
      .join("\n\n");
    const result = await runClaudeText({ prompt });
    const plan = parseAutomationPlan(result.text);
    return {
      plan,
      model: "claude_subscription",
      provider: "claude_subscription",
    };
  }

  if (status.activeRoute === "hybrid") {
    try {
      const prompt = [
        "Return only strict JSON with no markdown.",
        "Schema: {\"title\":\"string\",\"objective\":\"string\",\"safetyChecks\":[\"string\"],\"steps\":[{\"endpoint\":\"string\",\"description\":\"string\",\"waitMs\":number,\"args\":{}}]}",
        `Goal: ${input.goal}`,
        input.context ? `Context: ${input.context}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const result = await runClaudeText({ prompt });
      return {
        plan: parseAutomationPlan(result.text),
        model: "claude_subscription",
        provider: "hybrid",
      };
    } catch {
      const fallback = await runAutomationPlanner(input);
      return {
        plan: fallback.plan,
        model: fallback.model,
        provider: "hybrid",
      };
    }
  }

  const result = await runAutomationPlanner(input);
  return {
    plan: result.plan,
    model: result.model,
    provider: "openrouter",
  };
};
