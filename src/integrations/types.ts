import type {
  IntegrationActionId,
  IntegrationActionMode,
  IntegrationActionTraceStep,
  IntegrationBridgeStatus,
  IntegrationStepId,
  IntegrationStepRequest,
  IntegrationSubscriber,
  MacAppId,
  ProviderMode,
  WatchSource,
} from "../types.js";

export type { IntegrationActionId, IntegrationActionMode, IntegrationActionTraceStep, IntegrationBridgeStatus, IntegrationStepId, IntegrationStepRequest, IntegrationSubscriber };

export interface IntegrationCatalogStep {
  id: IntegrationStepId;
  title: string;
  mutating: boolean;
  description: string;
}

export interface IntegrationRunbookDefinition {
  id: IntegrationActionId;
  title: string;
  description: string;
  steps: IntegrationStepRequest[];
}

export interface IntegrationActionPlan {
  actionId?: IntegrationActionId;
  steps: IntegrationStepRequest[];
  params: Record<string, unknown>;
}

export interface IntegrationActionExecutionResult {
  ok: boolean;
  code?: "approval_required" | "app_not_allowed" | "execution_failed";
  message?: string;
  data?: Record<string, unknown>;
  rollbackHint?: string;
  approvalIds?: string[];
}

export interface IntegrationActionContext {
  ensureMacAllowlist: (apps: MacAppId[]) => Promise<IntegrationActionExecutionResult>;
  openMacApp: (appId: MacAppId, url?: string) => Promise<IntegrationActionExecutionResult>;
  focusMacApp: (appId: MacAppId) => Promise<IntegrationActionExecutionResult>;
  setProviderMode: (mode: ProviderMode) => Promise<IntegrationActionExecutionResult>;
  checkClaudeSession: () => Promise<IntegrationActionExecutionResult>;
  setLivekitConfig: (patch: {
    enabled?: boolean;
    wsUrl?: string;
    apiKey?: string;
    roomPrefix?: string;
    streamMode?: "events_only" | "events_and_frames";
  }) => Promise<IntegrationActionExecutionResult>;
  startWatchSession: (args: {
    sourceId: WatchSource["id"];
    taskId?: string;
    fps?: number;
  }) => Promise<IntegrationActionExecutionResult>;
  stopWatchSession: (sessionId: string) => Promise<IntegrationActionExecutionResult>;
  mintLivekitViewerToken: (args: {
    sessionId?: string;
    sourceId?: WatchSource["id"];
    taskId?: string;
  }) => Promise<IntegrationActionExecutionResult>;
  refreshIntegrationsStatus: () => Promise<IntegrationActionExecutionResult>;
}

export interface IntegrationBridgeEvent {
  id: string;
  type: string;
  ts: string;
  payload: Record<string, unknown>;
}

export interface IntegrationBridgeStorageShape {
  subscribers: IntegrationSubscriber[];
  stats: Pick<
    IntegrationBridgeStatus,
    "delivered" | "failed" | "retriesScheduled" | "lastDeliveryAt" | "lastEventAt"
  >;
}
