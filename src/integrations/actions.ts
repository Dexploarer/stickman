import type { IntegrationActionId, IntegrationActionTraceStep, IntegrationStepRequest, MacAppId, ProviderMode, WatchSource } from "../types.js";
import type { IntegrationActionContext, IntegrationActionExecutionResult, IntegrationActionPlan } from "./types.js";
import { getIntegrationRunbook, integrationCatalogSteps, isIntegrationStepId } from "./catalog.js";

const mutatingStepSet = new Set(integrationCatalogSteps.filter((step) => step.mutating).map((step) => step.id));

export const isMutatingStep = (stepId: string): boolean => {
  return mutatingStepSet.has(stepId as never);
};

const asString = (value: unknown): string => String(value || "").trim();

const asMacAppId = (value: unknown): MacAppId | null => {
  const normalized = asString(value);
  if (normalized === "antigravity" || normalized === "terminal" || normalized === "chrome") {
    return normalized;
  }
  return null;
};

const asProviderMode = (value: unknown): ProviderMode | null => {
  const normalized = asString(value);
  if (normalized === "claude_subscription" || normalized === "openrouter" || normalized === "hybrid") {
    return normalized;
  }
  return null;
};

const asWatchSource = (value: unknown): WatchSource["id"] | null => {
  const normalized = asString(value);
  if (normalized === "embedded-browser" || normalized === "antigravity" || normalized === "chrome" || normalized === "terminal") {
    return normalized;
  }
  return null;
};

export const buildIntegrationActionPlan = (input: {
  actionId?: string;
  steps?: IntegrationStepRequest[];
  params?: Record<string, unknown>;
}): { ok: true; plan: IntegrationActionPlan } | { ok: false; code: "invalid_action"; error: string } => {
  const actionId = asString(input.actionId) as IntegrationActionId;
  const hasActionId = Boolean(actionId);
  const hasSteps = Array.isArray(input.steps) && input.steps.length > 0;
  if ((hasActionId && hasSteps) || (!hasActionId && !hasSteps)) {
    return {
      ok: false,
      code: "invalid_action",
      error: "Provide exactly one of actionId or steps.",
    };
  }
  const params = (input.params && typeof input.params === "object" ? input.params : {}) as Record<string, unknown>;
  if (hasActionId) {
    const runbook = getIntegrationRunbook(actionId);
    if (!runbook) {
      return {
        ok: false,
        code: "invalid_action",
        error: "Unknown integration actionId.",
      };
    }
    return {
      ok: true,
      plan: {
        actionId: runbook.id,
        steps: runbook.steps.map((step) => ({
          id: step.id,
          args: { ...(step.args || {}) },
        })),
        params,
      },
    };
  }
  const provided = (input.steps || []).map((step, index) => {
    const id = asString(step?.id);
    if (!isIntegrationStepId(id)) {
      return { index, id, valid: false as const };
    }
    return { index, id, valid: true as const };
  });
  const invalid = provided.find((item) => !item.valid);
  if (invalid) {
    return {
      ok: false,
      code: "invalid_action",
      error: `Invalid step id at index ${invalid.index}: ${invalid.id}`,
    };
  }
  return {
    ok: true,
    plan: {
      actionId: undefined,
      steps: (input.steps || []).map((step) => ({
        id: step.id,
        args: (step.args && typeof step.args === "object" ? step.args : {}) as Record<string, unknown>,
      })),
      params,
    },
  };
};

const executeStep = async (
  context: IntegrationActionContext,
  step: IntegrationStepRequest,
  params: Record<string, unknown>,
): Promise<IntegrationActionExecutionResult> => {
  const args = (step.args && typeof step.args === "object" ? step.args : {}) as Record<string, unknown>;
  switch (step.id) {
    case "ensure_mac_allowlist": {
      const appsRaw = Array.isArray(args.apps) ? args.apps : params.apps;
      const apps = Array.isArray(appsRaw)
        ? appsRaw
            .map((entry) => asMacAppId(entry))
            .filter((entry): entry is MacAppId => Boolean(entry))
        : (["antigravity", "terminal", "chrome"] as MacAppId[]);
      return context.ensureMacAllowlist(apps.length ? apps : ["antigravity", "terminal", "chrome"]);
    }
    case "open_mac_app": {
      const appId = asMacAppId(args.appId || params.appId);
      if (!appId) {
        return { ok: false, code: "execution_failed", message: "open_mac_app requires appId." };
      }
      const url = asString(args.url || params.url) || undefined;
      return context.openMacApp(appId, url);
    }
    case "focus_mac_app": {
      const appId = asMacAppId(args.appId || params.appId);
      if (!appId) {
        return { ok: false, code: "execution_failed", message: "focus_mac_app requires appId." };
      }
      return context.focusMacApp(appId);
    }
    case "set_provider_mode": {
      const mode = asProviderMode(args.mode || params.mode);
      if (!mode) {
        return { ok: false, code: "execution_failed", message: "set_provider_mode requires valid mode." };
      }
      return context.setProviderMode(mode);
    }
    case "check_claude_session":
      return context.checkClaudeSession();
    case "set_livekit_config": {
      const patch = {
        enabled: typeof (args.enabled ?? params.enabled) === "boolean" ? Boolean(args.enabled ?? params.enabled) : undefined,
        wsUrl: asString(args.wsUrl || params.wsUrl) || undefined,
        apiKey: asString(args.apiKey || params.apiKey) || undefined,
        roomPrefix: asString(args.roomPrefix || params.roomPrefix) || undefined,
        streamMode:
          asString(args.streamMode || params.streamMode) === "events_and_frames"
            ? ("events_and_frames" as const)
            : asString(args.streamMode || params.streamMode) === "events_only"
              ? ("events_only" as const)
              : undefined,
      };
      return context.setLivekitConfig(patch);
    }
    case "start_watch_session": {
      const sourceId = asWatchSource(args.sourceId || params.sourceId) || "embedded-browser";
      const taskId = asString(args.taskId || params.taskId) || undefined;
      const fpsRaw = Number(args.fps ?? params.fps);
      const fps = Number.isFinite(fpsRaw) ? Math.max(1, Math.min(6, Math.floor(fpsRaw))) : undefined;
      return context.startWatchSession({ sourceId, taskId, fps });
    }
    case "stop_watch_session": {
      const sessionId = asString(args.sessionId || params.sessionId);
      if (!sessionId) {
        return { ok: false, code: "execution_failed", message: "stop_watch_session requires sessionId." };
      }
      return context.stopWatchSession(sessionId);
    }
    case "mint_livekit_viewer_token": {
      const sessionId = asString(args.sessionId || params.sessionId) || undefined;
      const sourceId = asWatchSource(args.sourceId || params.sourceId) || undefined;
      const taskId = asString(args.taskId || params.taskId) || undefined;
      return context.mintLivekitViewerToken({ sessionId, sourceId, taskId });
    }
    case "refresh_integrations_status":
      return context.refreshIntegrationsStatus();
    default:
      return {
        ok: false,
        code: "execution_failed",
        message: `Unsupported step: ${step.id}`,
      };
  }
};

export const executeIntegrationActionPlan = async (input: {
  context: IntegrationActionContext;
  steps: IntegrationStepRequest[];
  params: Record<string, unknown>;
}): Promise<{
  ok: boolean;
  code?: "approval_required" | "app_not_allowed" | "execution_failed";
  error?: string;
  trace: IntegrationActionTraceStep[];
}> => {
  const trace: IntegrationActionTraceStep[] = [];
  for (let index = 0; index < input.steps.length; index += 1) {
    const step = input.steps[index];
    const args = (step.args && typeof step.args === "object" ? step.args : {}) as Record<string, unknown>;
    const row: IntegrationActionTraceStep = {
      index,
      stepId: step.id,
      status: "executed",
      args,
      startedAt: new Date().toISOString(),
    };
    try {
      const result = await executeStep(input.context, step, input.params);
      row.endedAt = new Date().toISOString();
      row.message = result.message;
      row.code = result.code;
      row.data = result.data;
      row.rollbackHint = result.rollbackHint;
      row.approvalIds = result.approvalIds;
      if (!result.ok) {
        row.status = result.code === "approval_required" ? "approval_required" : "failed";
        trace.push(row);
        return {
          ok: false,
          code: result.code === "approval_required" ? "approval_required" : result.code === "app_not_allowed" ? "app_not_allowed" : "execution_failed",
          error: result.message || "step_failed",
          trace,
        };
      }
      row.status = "executed";
      trace.push(row);
    } catch (error) {
      row.endedAt = new Date().toISOString();
      row.status = "failed";
      row.code = "execution_failed";
      row.message = error instanceof Error ? error.message : String(error);
      trace.push(row);
      return {
        ok: false,
        code: "execution_failed",
        error: row.message,
        trace,
      };
    }
  }
  return {
    ok: true,
    trace,
  };
};

export const buildPlannedTrace = (steps: IntegrationStepRequest[]): IntegrationActionTraceStep[] => {
  return steps.map((step, index) => ({
    index,
    stepId: step.id,
    status: "planned",
    args: (step.args && typeof step.args === "object" ? step.args : {}) as Record<string, unknown>,
    rollbackHint: isMutatingStep(step.id)
      ? "Mutating step. Execute only with confirm token."
      : "Read-only step.",
  }));
};
