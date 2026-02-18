import { defaultOnboardingState } from "./config.js";
import { readOnboardingStateRecord, saveOnboardingStateRecord } from "./db/repositories/onboarding-repo.js";
import type { OnboardingState } from "./types.js";

const mergeOnboarding = (base: OnboardingState, patch: Partial<OnboardingState>): OnboardingState => {
  const mergedStorage = patch.storage || base.storage
    ? {
        engine: "sqlite" as const,
        ...(base.storage || {}),
        ...(patch.storage || {}),
      }
    : undefined;
  return {
    ...base,
    ...patch,
    providers: {
      ...base.providers,
      ...(patch.providers || {}),
      claude: {
        ...base.providers.claude,
        ...(patch.providers?.claude || {}),
      },
    },
    openrouter: {
      ...base.openrouter,
      ...(patch.openrouter || {}),
      defaults: {
        ...base.openrouter.defaults,
        ...(patch.openrouter?.defaults || {}),
      },
      fallbacks: {
        ...base.openrouter.fallbacks,
        ...(patch.openrouter?.fallbacks || {}),
      },
    },
    extensions: {
      ...base.extensions,
      ...(patch.extensions || {}),
      x: {
        ...base.extensions.x,
        ...(patch.extensions?.x || {}),
      },
      code: {
        ...base.extensions.code,
        ...(patch.extensions?.code || {}),
      },
    },
    x: {
      ...base.x,
      ...(patch.x || {}),
    },
    persona: {
      ...base.persona,
      ...(patch.persona || {}),
    },
    autonomy: {
      ...base.autonomy,
      ...(patch.autonomy || {}),
    },
    skills: {
      ...base.skills,
      ...(patch.skills || {}),
      enabled: {
        ...base.skills.enabled,
        ...(patch.skills?.enabled || {}),
      },
    },
    macControl: {
      ...base.macControl,
      ...(patch.macControl || {}),
      appAllowlist: patch.macControl?.appAllowlist || base.macControl.appAllowlist,
      requireApprovalFor: patch.macControl?.requireApprovalFor || base.macControl.requireApprovalFor,
    },
    watch: {
      ...base.watch,
      ...(patch.watch || {}),
    },
    livekit: {
      ...base.livekit,
      ...(patch.livekit || {}),
    },
    pordie: {
      ...base.pordie,
      ...(patch.pordie || {}),
    },
    ...(mergedStorage ? { storage: mergedStorage } : {}),
  };
};

export const getOnboardingState = async (): Promise<OnboardingState> => {
  const defaults = defaultOnboardingState();
  const loaded = readOnboardingStateRecord();
  return mergeOnboarding(defaults, loaded);
};

export const saveOnboardingState = async (next: Partial<OnboardingState>): Promise<OnboardingState> => {
  const current = await getOnboardingState();
  const merged = mergeOnboarding(current, next);
  merged.updatedAt = new Date().toISOString();
  saveOnboardingStateRecord(merged);
  return merged;
};

export const completeOnboarding = async (next: Partial<OnboardingState>): Promise<OnboardingState> => {
  return saveOnboardingState({
    ...next,
    completed: true,
  });
};
