import { defaultOnboardingState } from "../../config.js";
import type { OnboardingState } from "../../types.js";
import { getDatabasePath, getDatabase } from "../client.js";
import { ensureDatabaseReady } from "../migrate.js";

const normalizeStorage = (state: OnboardingState, fallbackIso: string): OnboardingState => ({
  ...state,
  storage: {
    engine: "sqlite",
    path: getDatabasePath(),
    migratedAt: state.storage?.migratedAt || fallbackIso,
  },
});

export const readOnboardingStateRecord = (): OnboardingState => {
  ensureDatabaseReady();
  const db = getDatabase();
  const row = db.prepare("SELECT payload_json FROM onboarding_state WHERE id = 1 LIMIT 1").get() as
    | { payload_json?: string }
    | undefined;

  const now = new Date().toISOString();
  if (!row?.payload_json) {
    return normalizeStorage(
      {
        ...defaultOnboardingState(),
        updatedAt: now,
      },
      now,
    );
  }

  try {
    const parsed = JSON.parse(row.payload_json) as OnboardingState;
    if (parsed && typeof parsed === "object") {
      return normalizeStorage(parsed, parsed.updatedAt || now);
    }
  } catch {
    // fallback below
  }

  return normalizeStorage(
    {
      ...defaultOnboardingState(),
      updatedAt: now,
    },
    now,
  );
};

export const saveOnboardingStateRecord = (state: OnboardingState): OnboardingState => {
  ensureDatabaseReady();
  const db = getDatabase();
  const now = state.updatedAt || new Date().toISOString();
  const normalized = normalizeStorage(
    {
      ...state,
      updatedAt: now,
    },
    now,
  );

  db.prepare(
    `INSERT INTO onboarding_state(id, payload_json, updated_at)
     VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
  ).run(JSON.stringify(normalized), normalized.updatedAt || now);

  return normalized;
};
