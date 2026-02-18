import { defaultOnboardingState, onboardingStatePath } from "./config.js";
import { readJsonFile, writeJsonFile } from "./state/store.js";
import type { OnboardingState } from "./types.js";

const mergeOnboarding = (base: OnboardingState, patch: Partial<OnboardingState>): OnboardingState => {
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
    pordie: {
      ...base.pordie,
      ...(patch.pordie || {}),
    },
  };
};

export const getOnboardingState = async (): Promise<OnboardingState> => {
  const defaults = defaultOnboardingState();
  const loaded = await readJsonFile<OnboardingState>(onboardingStatePath, defaults);
  return mergeOnboarding(defaults, loaded);
};

export const saveOnboardingState = async (next: Partial<OnboardingState>): Promise<OnboardingState> => {
  const current = await getOnboardingState();
  const merged = mergeOnboarding(current, next);
  merged.updatedAt = new Date().toISOString();
  await writeJsonFile(onboardingStatePath, merged);
  return merged;
};

export const completeOnboarding = async (next: Partial<OnboardingState>): Promise<OnboardingState> => {
  return saveOnboardingState({
    ...next,
    completed: true,
  });
};
