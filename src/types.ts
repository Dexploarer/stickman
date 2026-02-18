export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ProviderMode = "claude_subscription" | "openrouter" | "hybrid";
export type ExtensionId = "x-social" | "code-workspace";
export type ExtensionExecutionMode = "manual" | "scheduled";
export type AutonomyPolicy = "mixed_auto";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type ApprovalCategory = "app_launch" | "terminal_exec" | "codex_exec" | "browser_external" | "write_command";
export type MacAppId = "antigravity" | "terminal" | "chrome";
export type SkillId =
  | "antigravity.open"
  | "antigravity.open_mission_url"
  | "terminal.open"
  | "terminal.run_command"
  | "codex.run_task"
  | "claude.run_task"
  | "browser.embedded.open_tab"
  | "browser.external.chrome.open"
  | "x-social.run_endpoint"
  | "code-workspace.exec";
export type TaskStatus = "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";

export type XArgValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Array<string | number | boolean>;

export type XArgMap = Record<string, XArgValue>;

export interface XRunRequest {
  endpoint: string;
  args?: XArgMap;
  globalArgs?: XArgMap;
}

export interface XRunResult {
  ok: boolean;
  endpoint: string;
  payload: JsonValue | string;
  stdout: string;
  stderr: string;
  error?: string;
  code?: "extension_disabled" | "approval_required";
  approvalId?: string;
}

export interface AITextInput {
  prompt: string;
  system?: string;
  model?: string;
  temperature?: number;
}

export type PersonaSourceType = "manual" | "active_profile" | "x_username" | "x_url";

export interface ModelPreferences {
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
}

export interface OnboardingOpenRouter {
  apiKey?: string;
  saveApiKeyLocally: boolean;
  defaults: ModelPreferences;
  fallbacks: ModelPreferences;
}

export interface OnboardingClaudeProvider {
  enabled: boolean;
  sessionPath?: string;
  requireCliLogin: boolean;
}

export interface OnboardingProviders {
  mode: ProviderMode;
  claude: OnboardingClaudeProvider;
}

export interface OnboardingXExtension {
  enabled: boolean;
  mode: ExtensionExecutionMode;
  approvalRequiredForWrite: boolean;
}

export interface OnboardingCodeExtension {
  enabled: boolean;
  mode: ExtensionExecutionMode;
  approvalRequiredForWrite: boolean;
  allowReadOnlyAutonomy: boolean;
  workingDirectory?: string;
}

export interface OnboardingExtensions {
  x: OnboardingXExtension;
  code: OnboardingCodeExtension;
}

export interface OnboardingXAccount {
  username?: string;
  email?: string;
  password?: string;
  savePasswordLocally: boolean;
}

export interface OnboardingPersona {
  stylePrompt?: string;
  voiceStyle?: string;
  deriveMode: PersonaSourceType;
  sourceValue?: string;
  autoDeriveFromProfile: boolean;
  characterPrompt?: string;
  postExamples?: string[];
}

export interface OnboardingPordie {
  enabled: boolean;
  scope: "global" | "project";
  autoExportOnComplete: boolean;
  syncProjectEnv: boolean;
}

export interface OnboardingAutonomy {
  enabled: boolean;
  policy: AutonomyPolicy;
  maxActionsPerCycle: number;
  approvalTTLMinutes: number;
}

export interface OnboardingSkills {
  enabled: Partial<Record<SkillId, boolean>>;
}

export interface OnboardingMacControl {
  appAllowlist: MacAppId[];
  requireApprovalFor: ApprovalCategory[];
}

export interface OnboardingWatch {
  enabled: boolean;
  mode: "screenshare";
  fps: number;
  captureScope: "agent_surfaces_only";
}

export interface OnboardingLivekit {
  enabled: boolean;
  wsUrl?: string;
  apiKey?: string;
  roomPrefix: string;
  streamMode: "events_only" | "events_and_frames";
}

export interface OnboardingState {
  completed: boolean;
  updatedAt: string | null;
  providers: OnboardingProviders;
  openrouter: OnboardingOpenRouter;
  extensions: OnboardingExtensions;
  x: OnboardingXAccount;
  persona: OnboardingPersona;
  autonomy: OnboardingAutonomy;
  skills: OnboardingSkills;
  macControl: OnboardingMacControl;
  watch: OnboardingWatch;
  livekit: OnboardingLivekit;
  pordie: OnboardingPordie;
}

export interface ProviderStatus {
  mode: ProviderMode;
  claudeSessionDetected: boolean;
  openrouterConfigured: boolean;
  activeRoute: "claude_subscription" | "openrouter" | "hybrid";
  capabilities: {
    text: "claude_subscription" | "openrouter" | "hybrid";
    image: "openrouter";
    video: "openrouter";
    embedding: "openrouter";
    voice: "openrouter";
  };
}

export interface ApprovalItem {
  id: string;
  extensionId: ExtensionId;
  endpoint: string;
  args: XArgMap;
  globalArgs: XArgMap;
  createdAt: string;
  expiresAt: string;
  status: ApprovalStatus;
  reason: string;
}

export interface SkillDefinition {
  id: SkillId;
  title: string;
  description: string;
  enabledByDefault: boolean;
  requiresApproval: boolean;
  approvalCategory: ApprovalCategory;
  allowedModes: Array<"manual" | "scheduled" | "autonomy">;
  executorType: "mac_action" | "codex_cli" | "claude_cli" | "browser" | "x_social" | "code_workspace";
}

export interface TaskLogEntry {
  at: string;
  type: "task_state" | "skill_action" | "stdout_chunk" | "frame" | "error";
  message: string;
  payload?: Record<string, unknown>;
}

export interface TaskRun {
  id: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  cancelledAt?: string;
  prompt: string;
  skillId?: SkillId;
  args?: Record<string, unknown>;
  dependsOnTaskId?: string;
  chainId?: string;
  chainIndex?: number;
  chainLength?: number;
  approvalId?: string;
  error?: string;
  logs: TaskLogEntry[];
}

export interface WatchSource {
  id: "embedded-browser" | "antigravity" | "chrome" | "terminal";
  title: string;
  available: boolean;
}

export interface WatchSession {
  id: string;
  sourceId: WatchSource["id"];
  taskId?: string;
  active: boolean;
  startedAt: string;
  endedAt?: string;
  fps: number;
}

export interface OpenRouterModelRecord {
  id: string;
  name?: string;
  description?: string;
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  contextLength?: number;
  promptPrice?: number;
  completionPrice?: number;
}

export interface OpenRouterModelCache {
  fetchedAt: string;
  totalCount: number;
  models: OpenRouterModelRecord[];
  groups: {
    text: string[];
    image: string[];
    video: string[];
    embedding: string[];
    voice: string[];
  };
  recommendations: {
    textSmall?: string;
    textLarge?: string;
    imagePrimary?: string;
    videoPrimary?: string;
    embeddingPrimary?: string;
    voicePrimary?: string;
  };
}

export interface WorkflowStep {
  endpoint: string;
  description?: string;
  waitMs?: number;
  args?: XArgMap;
}

export interface AutomationPlan {
  title: string;
  objective: string;
  safetyChecks: string[];
  steps: Array<{
    endpoint: string;
    description: string;
    waitMs: number;
    args: Record<string, string | number | boolean | null | Array<string | number | boolean | null>>;
  }>;
}
