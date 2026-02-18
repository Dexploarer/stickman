import "dotenv/config";

import cors from "cors";
import express from "express";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import type { Response } from "express";

import {
  createEmbedding,
  createImageFromPrompt,
  getModelCache,
  refreshModelCache,
  runAIText,
  runVideoAnalysis,
  runVoiceAnalysis,
  testOpenRouterKey,
} from "./ai/openrouter.js";
import {
  ensureOpenRouterForModality,
  getProviderStatus,
  runAutomationPlannerWithRouting,
  runTextWithProviderRouting,
} from "./ai/router.js";
import { detectClaudeSession, startClaudeCliLogin } from "./ai/claude-bridge.js";
import { appConfig, buildDefaultXGlobalArgs, modelCachePath, projectRoot, resolvePordiePaths, resolvePordieScope } from "./config.js";
import { assessWorkspaceCommand, getWorkspaceSession, listWorkspaceSessions, runWorkspaceCommand } from "./code/workspace.js";
import { completeOnboarding, getOnboardingState, saveOnboardingState } from "./onboarding.js";
import { exportPromptOrDieConfig } from "./pordie.js";
import { importLocalSecrets } from "./secrets/local-import.js";
import { getSkillDefinition, skillCatalog } from "./skills/catalog.js";
import { executeSkill } from "./skills/executor.js";
import { focusMacApp, listKnownMacApps, openMacApp } from "./skills/mac-actions.js";
import type { SkillExecutionInput } from "./skills/types.js";
import type {
  ApprovalItem,
  MacAppId,
  OnboardingState,
  SkillId,
  TaskRun,
  TaskStatus,
  WatchSession,
  WatchSource,
  XArgMap,
  XRunRequest,
  XRunResult,
} from "./types.js";
import { xEndpointCatalog } from "./x/catalog.js";
import { runXEndpoint } from "./x/runner.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const resolveObject = (value: unknown): XArgMap => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as XArgMap;
};

const resolveStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
};

const xEndpointCategory = new Map(xEndpointCatalog.map((entry) => [entry.endpoint, entry.category]));
const xApprovalCategories = new Set(["auth", "write"]);
const approvalQueue: ApprovalItem[] = [];
type CodeApprovalStatus = "pending" | "approved" | "rejected" | "expired";
interface CodeApprovalItem {
  id: string;
  extensionId: "code-workspace";
  command: string;
  cwd?: string;
  createdAt: string;
  expiresAt: string;
  status: CodeApprovalStatus;
  reason: string;
  readOnly: boolean;
}
const codeApprovalQueue: CodeApprovalItem[] = [];
type SkillApprovalStatus = "pending" | "approved" | "rejected" | "expired";
interface SkillApprovalItem {
  id: string;
  skillId: SkillId;
  approvalCategory: "app_launch" | "terminal_exec" | "codex_exec" | "browser_external" | "write_command";
  args: Record<string, unknown>;
  reason: string;
  status: SkillApprovalStatus;
  createdAt: string;
  expiresAt: string;
  taskId?: string;
}
const skillApprovalQueue: SkillApprovalItem[] = [];
const taskRuns = new Map<string, TaskRun>();
const taskRunOrder: string[] = [];
const taskCancellation = new Set<string>();
const taskDependsOn = new Map<string, string>();
const taskDependencyIndex = new Map<string, string[]>();
const watchSessions = new Map<string, WatchSession>();
const watchTimers = new Map<string, NodeJS.Timeout>();
const liveSseClients = new Set<Response>();
const liveWsClients = new Set<Socket>();
const liveEventHistory: Array<{
  id: string;
  type: string;
  ts: string;
  payload: Record<string, unknown>;
}> = [];

const emitLiveEvent = (type: string, payload: Record<string, unknown>) => {
  const event = {
    id: randomUUID(),
    type,
    ts: new Date().toISOString(),
    payload,
  };
  liveEventHistory.push(event);
  if (liveEventHistory.length > 400) {
    liveEventHistory.splice(0, liveEventHistory.length - 400);
  }
  const encoded = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of liveSseClients) {
    try {
      client.write(encoded);
    } catch {
      liveSseClients.delete(client);
    }
  }
  const wsPayload = JSON.stringify(event);
  const wsFrame = encodeWebSocketFrame(wsPayload);
  for (const client of liveWsClients) {
    try {
      client.write(wsFrame);
    } catch {
      try {
        client.destroy();
      } catch {
        // ignore
      }
      liveWsClients.delete(client);
    }
  }
};

const encodeWebSocketFrame = (payload: string): Buffer => {
  const body = Buffer.from(payload);
  const length = body.length;
  if (length < 126) {
    return Buffer.concat([Buffer.from([0x81, length]), body]);
  }
  if (length < 65_536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, body]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, body]);
};

const pruneApprovalQueue = () => {
  const now = Date.now();
  for (const item of approvalQueue) {
    if (item.status !== "pending") {
      continue;
    }
    if (new Date(item.expiresAt).getTime() <= now) {
      item.status = "expired";
    }
  }
  if (approvalQueue.length > 500) {
    const retained = approvalQueue
      .filter((item) => item.status === "pending")
      .slice(-250);
    approvalQueue.length = 0;
    approvalQueue.push(...retained);
  }
};

const pruneCodeApprovalQueue = () => {
  const now = Date.now();
  for (const item of codeApprovalQueue) {
    if (item.status !== "pending") {
      continue;
    }
    if (new Date(item.expiresAt).getTime() <= now) {
      item.status = "expired";
    }
  }
  if (codeApprovalQueue.length > 500) {
    const retained = codeApprovalQueue
      .filter((item) => item.status === "pending")
      .slice(-250);
    codeApprovalQueue.length = 0;
    codeApprovalQueue.push(...retained);
  }
};

const pruneSkillApprovalQueue = () => {
  const now = Date.now();
  for (const item of skillApprovalQueue) {
    if (item.status !== "pending") {
      continue;
    }
    if (new Date(item.expiresAt).getTime() <= now) {
      item.status = "expired";
    }
  }
  if (skillApprovalQueue.length > 500) {
    const retained = skillApprovalQueue
      .filter((item) => item.status === "pending")
      .slice(-250);
    skillApprovalQueue.length = 0;
    skillApprovalQueue.push(...retained);
  }
};

const pendingApprovalCount = () => {
  const xPending = approvalQueue.filter((item) => item.status === "pending").length;
  const codePending = codeApprovalQueue.filter((item) => item.status === "pending").length;
  const skillPending = skillApprovalQueue.filter((item) => item.status === "pending").length;
  return xPending + codePending + skillPending;
};

const queueApproval = (
  endpoint: string,
  args: XArgMap,
  globalArgs: XArgMap,
  approvalTTLMinutes: number,
  reason: string,
): ApprovalItem => {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + Math.max(1, approvalTTLMinutes) * 60_000);
  const item: ApprovalItem = {
    id: randomUUID(),
    extensionId: "x-social",
    endpoint,
    args,
    globalArgs,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    status: "pending",
    reason,
  };
  approvalQueue.push(item);
  emitLiveEvent("approval_queued", {
    approvalId: item.id,
    endpoint: item.endpoint,
    reason: item.reason,
    expiresAt: item.expiresAt,
    extensionId: item.extensionId,
  });
  return item;
};

const queueCodeApproval = (
  command: string,
  cwd: string | undefined,
  readOnly: boolean,
  approvalTTLMinutes: number,
  reason: string,
): CodeApprovalItem => {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + Math.max(1, approvalTTLMinutes) * 60_000);
  const item: CodeApprovalItem = {
    id: randomUUID(),
    extensionId: "code-workspace",
    command,
    cwd,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    status: "pending",
    reason,
    readOnly,
  };
  codeApprovalQueue.push(item);
  emitLiveEvent("code_approval_queued", {
    approvalId: item.id,
    command: item.command,
    cwd: item.cwd || projectRoot,
    reason: item.reason,
    expiresAt: item.expiresAt,
  });
  return item;
};

const queueSkillApproval = (input: {
  skillId: SkillId;
  approvalCategory: "app_launch" | "terminal_exec" | "codex_exec" | "browser_external" | "write_command";
  args: Record<string, unknown>;
  reason: string;
  taskId?: string;
  approvalTTLMinutes: number;
}): SkillApprovalItem => {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + Math.max(1, input.approvalTTLMinutes) * 60_000);
  const item: SkillApprovalItem = {
    id: randomUUID(),
    skillId: input.skillId,
    approvalCategory: input.approvalCategory,
    args: input.args,
    reason: input.reason,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    status: "pending",
    taskId: input.taskId,
  };
  skillApprovalQueue.push(item);
  emitLiveEvent("skill_approval_queued", {
    approvalId: item.id,
    skillId: item.skillId,
    approvalCategory: item.approvalCategory,
    reason: item.reason,
    taskId: item.taskId || null,
    expiresAt: item.expiresAt,
  });
  return item;
};

const getTaskRun = (taskId: string): TaskRun | undefined => taskRuns.get(taskId);

const taskLog = (
  taskId: string,
  type: "task_state" | "skill_action" | "stdout_chunk" | "frame" | "error",
  message: string,
  payload?: Record<string, unknown>,
) => {
  const task = taskRuns.get(taskId);
  if (!task) {
    return;
  }
  task.logs.push({
    at: new Date().toISOString(),
    type,
    message,
    payload,
  });
  task.logs = task.logs.slice(-300);
  task.updatedAt = new Date().toISOString();
  emitLiveEvent(type, {
    taskId,
    message,
    ...(payload || {}),
  });
};

const queueTaskExecution = (taskId: string, delayMs = 1) => {
  setTimeout(() => {
    void executeTask(taskId);
  }, delayMs);
};

const releaseDependentTasks = (dependencyTaskId: string, dependencyStatus: TaskStatus) => {
  const dependents = taskDependencyIndex.get(dependencyTaskId);
  if (!dependents || !dependents.length) {
    return;
  }
  taskDependencyIndex.delete(dependencyTaskId);
  for (const dependentTaskId of dependents) {
    taskDependsOn.delete(dependentTaskId);
    const dependent = taskRuns.get(dependentTaskId);
    if (!dependent) {
      continue;
    }
    if (dependencyStatus !== "completed") {
      setTaskStatus(dependentTaskId, "cancelled", {
        cancelledAt: new Date().toISOString(),
        error: `Dependency task ${dependencyTaskId} ended with status ${dependencyStatus}.`,
      });
      continue;
    }
    taskLog(dependentTaskId, "task_state", "dependency_satisfied", {
      dependsOnTaskId: dependencyTaskId,
    });
    if (dependent.status === "queued") {
      queueTaskExecution(dependentTaskId);
    }
  }
};

const setTaskStatus = (taskId: string, status: TaskStatus, patch?: Partial<TaskRun>) => {
  const task = taskRuns.get(taskId);
  if (!task) {
    return;
  }
  task.status = status;
  task.updatedAt = new Date().toISOString();
  if (patch) {
    Object.assign(task, patch);
  }
  taskLog(taskId, "task_state", `task_${status}`, {
    status,
  });
  if (status === "completed" || status === "failed" || status === "cancelled") {
    for (const watch of watchSessions.values()) {
      if (watch.active && watch.taskId === taskId) {
        stopWatchSession(watch.id, `task_${status}`);
      }
    }
    releaseDependentTasks(taskId, status);
  }
};

const registerTask = (task: TaskRun) => {
  taskRuns.set(task.id, task);
  taskRunOrder.push(task.id);
  if (taskRunOrder.length > 300) {
    const stale = taskRunOrder.splice(0, taskRunOrder.length - 300);
    for (const id of stale) {
      taskRuns.delete(id);
      taskCancellation.delete(id);
      taskDependsOn.delete(id);
      taskDependencyIndex.delete(id);
      for (const [dependencyId, dependents] of taskDependencyIndex.entries()) {
        const filtered = dependents.filter((item) => item !== id);
        if (filtered.length) {
          taskDependencyIndex.set(dependencyId, filtered);
        } else {
          taskDependencyIndex.delete(dependencyId);
        }
      }
    }
  }
};

const xResultStatus = (result: XRunResult): number => {
  if (result.ok) {
    return 200;
  }
  if (result.code === "extension_disabled") {
    return 423;
  }
  if (result.code === "approval_required") {
    return 409;
  }
  return 400;
};

const codeResultStatus = (result: { ok: boolean; code?: string }): number => {
  if (result.ok) {
    return 200;
  }
  if (result.code === "extension_disabled") {
    return 423;
  }
  if (result.code === "approval_required") {
    return 409;
  }
  return 400;
};

const runX = async (
  endpoint: string,
  endpointArgs: XArgMap = {},
  requestGlobalArgs: XArgMap = {},
  options?: { allowApprovalBypass?: boolean; reason?: string },
): Promise<XRunResult> => {
  pruneApprovalQueue();
  emitLiveEvent("x_request", {
    endpoint,
    reason: options?.reason || "unspecified",
  });
  const onboarding = await getOnboardingState();
  if (!onboarding.extensions.x.enabled) {
    emitLiveEvent("x_blocked_extension_disabled", {
      endpoint,
    });
    return {
      ok: false,
      endpoint,
      payload: "x-social extension is disabled",
      stdout: "",
      stderr: "",
      error: "x-social extension is disabled",
      code: "extension_disabled",
    };
  }

  const category = xEndpointCategory.get(endpoint);
  const requiresApproval =
    onboarding.autonomy.policy === "mixed_auto" &&
    onboarding.extensions.x.approvalRequiredForWrite &&
    Boolean(category && xApprovalCategories.has(category));

  if (requiresApproval && !options?.allowApprovalBypass) {
    const approval = queueApproval(
      endpoint,
      endpointArgs,
      requestGlobalArgs,
      onboarding.autonomy.approvalTTLMinutes,
      options?.reason || "write_action_requires_manual_approval",
    );
    return {
      ok: false,
      endpoint,
      payload: "Manual approval required before executing this X action.",
      stdout: "",
      stderr: "",
      error: "Manual approval required before executing this X action.",
      code: "approval_required",
      approvalId: approval.id,
    };
  }

  const result = await runXEndpoint({
    scriptPath: appConfig.xLocal.scriptPath,
    endpoint,
    globalArgs: requestGlobalArgs,
    endpointArgs,
  });
  emitLiveEvent("x_result", {
    endpoint,
    ok: result.ok,
    error: result.error || result.code || null,
  });
  return result;
};

interface CodeRunResponse {
  ok: boolean;
  code?: "extension_disabled" | "approval_required" | "invalid_command" | "execution_error";
  error?: string;
  approvalId?: string;
  readOnly?: boolean;
  session?: ReturnType<typeof getWorkspaceSession>;
}

const runCodeCommand = async (
  command: string,
  requestedCwd: string | undefined,
  options?: { allowApprovalBypass?: boolean; reason?: string },
): Promise<CodeRunResponse> => {
  pruneCodeApprovalQueue();
  const onboarding = await getOnboardingState();
  const defaultWorkspaceCwd = onboarding.extensions.code.workingDirectory?.trim() || projectRoot;
  const resolvedCwd = requestedCwd?.trim() ? requestedCwd.trim() : defaultWorkspaceCwd;
  emitLiveEvent("code_command_request", {
    command,
    cwd: resolvedCwd,
    reason: options?.reason || "unspecified",
  });
  if (!onboarding.extensions.code.enabled) {
    emitLiveEvent("code_command_blocked_extension_disabled", {
      command,
    });
    return {
      ok: false,
      code: "extension_disabled",
      error: "code-workspace extension is disabled",
    };
  }

  const safety = assessWorkspaceCommand(command);
  if (!safety.ok) {
    emitLiveEvent("code_command_blocked_invalid", {
      command,
      error: safety.reason || "invalid_command",
    });
    return {
      ok: false,
      code: "invalid_command",
      error: safety.reason || "invalid command",
    };
  }

  const requiresApproval =
    onboarding.autonomy.policy === "mixed_auto" &&
    onboarding.extensions.code.approvalRequiredForWrite &&
    !safety.readOnly;

  if (requiresApproval && !options?.allowApprovalBypass) {
    const approval = queueCodeApproval(
      command,
      resolvedCwd,
      safety.readOnly,
      onboarding.autonomy.approvalTTLMinutes,
      options?.reason || "write_command_requires_manual_approval",
    );
    return {
      ok: false,
      code: "approval_required",
      error: "Manual approval required before executing this workspace command.",
      approvalId: approval.id,
      readOnly: safety.readOnly,
    };
  }

  try {
    const result = await runWorkspaceCommand({
      projectRoot,
      command,
      cwd: resolvedCwd,
      readOnly: safety.readOnly,
      onEvent: (event) => {
        if (event.type === "stdout" || event.type === "stderr") {
          emitLiveEvent(`code_command_${event.type}`, {
            sessionId: event.sessionId,
            ...(event.payload || {}),
          });
          return;
        }
        emitLiveEvent(`code_command_${event.type}`, {
          sessionId: event.sessionId,
          ...(event.payload || {}),
        });
      },
    });
    return {
      ok: result.ok,
      readOnly: safety.readOnly,
      session: result.session,
      ...(result.ok ? {} : { code: "execution_error", error: "workspace command failed" }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitLiveEvent("code_command_error", {
      command,
      cwd: resolvedCwd,
      error: message,
    });
    return {
      ok: false,
      code: "execution_error",
      error: message,
      readOnly: safety.readOnly,
    };
  }
};

const listWatchSources = (): WatchSource[] => {
  const apps = listKnownMacApps();
  const availability = new Map(apps.map((app) => [app.id, app.available]));
  return [
    {
      id: "embedded-browser",
      title: "Embedded Browser",
      available: true,
    },
    {
      id: "antigravity",
      title: "Antigravity",
      available: Boolean(availability.get("antigravity")),
    },
    {
      id: "chrome",
      title: "Google Chrome",
      available: Boolean(availability.get("chrome")),
    },
    {
      id: "terminal",
      title: "Terminal",
      available: Boolean(availability.get("terminal")),
    },
  ];
};

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const frameSvgDataUri = (input: { title: string; subtitle: string; sourceId: string; taskId?: string }): string => {
  const now = new Date().toLocaleTimeString();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0f1720"/><stop offset="100%" stop-color="#1d2d3a"/></linearGradient></defs>
<rect x="0" y="0" width="800" height="450" fill="url(#g)" />
<rect x="20" y="20" width="760" height="410" rx="14" fill="#111923" stroke="#2f4554" stroke-width="2"/>
<text x="44" y="74" font-family="IBM Plex Mono, Menlo, monospace" font-size="30" fill="#d5e7ef">${escapeXml(input.title)}</text>
<text x="44" y="120" font-family="IBM Plex Mono, Menlo, monospace" font-size="18" fill="#89a6b5">${escapeXml(input.subtitle)}</text>
<text x="44" y="160" font-family="IBM Plex Mono, Menlo, monospace" font-size="16" fill="#5e7a89">Source: ${escapeXml(
    input.sourceId,
  )}</text>
<text x="44" y="190" font-family="IBM Plex Mono, Menlo, monospace" font-size="16" fill="#5e7a89">Task: ${escapeXml(
    input.taskId || "none",
  )}</text>
<text x="44" y="220" font-family="IBM Plex Mono, Menlo, monospace" font-size="16" fill="#5e7a89">Updated: ${escapeXml(
    now,
  )}</text>
<text x="44" y="280" font-family="IBM Plex Mono, Menlo, monospace" font-size="15" fill="#c4d7e0">Live screenshare stream is active (ephemeral, no recording persisted).</text>
<text x="44" y="306" font-family="IBM Plex Mono, Menlo, monospace" font-size="15" fill="#c4d7e0">This frame is generated from agent task telemetry for watch-along continuity.</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
};

const emitWatchFrame = (session: WatchSession) => {
  const task = session.taskId ? getTaskRun(session.taskId) : undefined;
  const source = listWatchSources().find((item) => item.id === session.sourceId);
  const frame = frameSvgDataUri({
    title: source?.title || "Agent Watch Source",
    subtitle: task ? `Task ${task.id} is ${task.status}` : "Watching source activity",
    sourceId: session.sourceId,
    taskId: session.taskId,
  });
  const payload = {
    watchSessionId: session.id,
    sourceId: session.sourceId,
    taskId: session.taskId || null,
    frame,
    mime: "image/svg+xml",
  };
  emitLiveEvent("frame", payload);
  if (session.taskId) {
    taskLog(session.taskId, "frame", "watch_frame_tick", payload);
  }
};

const stopWatchSession = (watchSessionId: string, reason: string) => {
  const session = watchSessions.get(watchSessionId);
  if (!session) {
    return;
  }
  const timer = watchTimers.get(watchSessionId);
  if (timer) {
    clearInterval(timer);
    watchTimers.delete(watchSessionId);
  }
  session.active = false;
  session.endedAt = new Date().toISOString();
  emitLiveEvent("watch_session_stopped", {
    watchSessionId: session.id,
    sourceId: session.sourceId,
    taskId: session.taskId || null,
    reason,
  });
};

const startWatchSession = (input: { sourceId: WatchSource["id"]; taskId?: string; fps: number }) => {
  for (const session of watchSessions.values()) {
    if (session.active && session.sourceId === input.sourceId && session.taskId === input.taskId) {
      stopWatchSession(session.id, "replaced");
    }
  }
  const now = new Date().toISOString();
  const session: WatchSession = {
    id: randomUUID(),
    sourceId: input.sourceId,
    taskId: input.taskId,
    active: true,
    startedAt: now,
    fps: Math.max(1, Math.min(input.fps, 6)),
  };
  watchSessions.set(session.id, session);
  emitLiveEvent("watch_session_started", {
    watchSessionId: session.id,
    sourceId: session.sourceId,
    taskId: session.taskId || null,
    fps: session.fps,
  });
  emitWatchFrame(session);
  const intervalMs = Math.max(333, Math.floor(1000 / session.fps));
  const timer = setInterval(() => {
    const current = watchSessions.get(session.id);
    if (!current || !current.active) {
      return;
    }
    emitWatchFrame(current);
  }, intervalMs);
  watchTimers.set(session.id, timer);
  return session;
};

const normalizeLivekitWsUrl = (value: string | undefined): string | undefined => {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("wss://") || trimmed.startsWith("ws://")) {
    return trimmed;
  }
  if (trimmed.startsWith("https://")) {
    return `wss://${trimmed.slice("https://".length)}`;
  }
  if (trimmed.startsWith("http://")) {
    return `ws://${trimmed.slice("http://".length)}`;
  }
  return undefined;
};

const resolveLivekitStatus = (onboarding: OnboardingState) => {
  const wsUrl = normalizeLivekitWsUrl(onboarding.livekit.wsUrl || appConfig.livekit.wsUrl);
  const apiKey = String(onboarding.livekit.apiKey || appConfig.livekit.apiKey || "").trim();
  const roomPrefix = String(onboarding.livekit.roomPrefix || appConfig.livekit.roomPrefix || "milady-cowork").trim();
  const streamMode = onboarding.livekit.streamMode === "events_and_frames" ? "events_and_frames" : "events_only";
  const apiSecretSet = Boolean(appConfig.livekit.apiSecret);
  const enabled = Boolean(onboarding.livekit.enabled);
  const missing: Array<"ws_url" | "api_key" | "api_secret"> = [];
  if (!wsUrl) {
    missing.push("ws_url");
  }
  if (!apiKey) {
    missing.push("api_key");
  }
  if (!apiSecretSet) {
    missing.push("api_secret");
  }
  const configured = missing.length === 0;
  const mode = enabled ? (configured ? "ready" : "needs_config") : "disabled";
  return {
    enabled,
    mode,
    configured,
    missing,
    wsUrl: wsUrl || null,
    apiKeySet: Boolean(apiKey),
    apiSecretSet,
    roomPrefix,
    streamMode,
    guidance:
      configured && enabled
        ? "LiveKit is ready for optional remote cowork transport."
        : "Set wsUrl, apiKey, and LIVEKIT_API_SECRET to enable remote LiveKit streaming.",
  };
};

const isSkillEnabled = (skillId: SkillId, enabledMap: Partial<Record<SkillId, boolean>>): boolean => {
  const defined = getSkillDefinition(skillId);
  const fallback = defined?.enabledByDefault ?? false;
  const value = enabledMap[skillId];
  return typeof value === "boolean" ? value : fallback;
};

const runSkillRequest = async (
  input: SkillExecutionInput,
  options?: {
    taskId?: string;
    approvalBypass?: boolean;
  },
) => {
  pruneSkillApprovalQueue();
  const onboarding = await getOnboardingState();
  const enabledMap = onboarding.skills.enabled || {};
  const allowlist = new Set(onboarding.macControl.appAllowlist || []);
  const requiresApprovalFor = new Set(onboarding.macControl.requireApprovalFor || []);

  const result = await executeSkill(
    {
      ...input,
      approvalBypass: options?.approvalBypass || input.approvalBypass,
    },
    {
      workspaceRoot: onboarding.extensions.code.workingDirectory || projectRoot,
      getSkillDefinition,
      isSkillEnabled: (id) => isSkillEnabled(id, enabledMap),
      requiresApproval: (category) => requiresApprovalFor.has(category),
      queueSkillApproval: ({ skillId, approvalCategory, args, reason }) =>
        queueSkillApproval({
          skillId,
          approvalCategory,
          args,
          reason,
          taskId: options?.taskId,
          approvalTTLMinutes: onboarding.autonomy.approvalTTLMinutes,
        }),
      openMacApp: async (appId, appOptions) => {
        if (!allowlist.has(appId)) {
          return { ok: false, message: "app_not_allowed" };
        }
        return openMacApp(appId, appOptions);
      },
      runTerminalCommand: async (command, cwd, execOptions) => {
        const codeResult = await runCodeCommand(command, cwd, {
          allowApprovalBypass: execOptions?.allowApprovalBypass,
          reason: "skill_terminal_command",
        });
        if (!codeResult.ok) {
          return {
            ok: false,
            message: codeResult.error || codeResult.code || "command_failed",
            payload: codeResult.session ? { session: codeResult.session } : undefined,
            code: codeResult.code,
            approvalId: codeResult.approvalId,
          };
        }
        return {
          ok: true,
          message: "Command completed.",
          payload: codeResult.session ? { session: codeResult.session } : {},
        };
      },
      runCodexTask: async (prompt, codexOptions) => {
        const command = codexOptions?.tool === "claude" ? `${appConfig.claude.cliCommand} '${prompt.replace(/'/g, "'\"'\"'")}'` : `codex '${prompt.replace(/'/g, "'\"'\"'")}'`;
        const codeResult = await runCodeCommand(command, onboarding.extensions.code.workingDirectory || projectRoot, {
          allowApprovalBypass: true,
          reason: "skill_codex_cli",
        });
        if (!codeResult.ok) {
          return {
            ok: false,
            message: codeResult.error || codeResult.code || "cli_failed",
            payload: codeResult.session ? { session: codeResult.session } : undefined,
            code: codeResult.code,
            approvalId: codeResult.approvalId,
          };
        }
        return {
          ok: true,
          message: "CLI task completed.",
          payload: codeResult.session ? { session: codeResult.session } : {},
        };
      },
      runXEndpoint: async (endpoint, args) => {
        const result = await runX(endpoint, (args as XArgMap) || {}, {}, {
          allowApprovalBypass: options?.approvalBypass,
          reason: "skill_x_endpoint",
        });
        return {
          ok: result.ok,
          message: result.ok ? "X endpoint executed." : result.error || result.code || "x_failed",
          payload: {
            endpoint: result.endpoint,
            payload: result.payload,
            stdout: result.stdout,
            stderr: result.stderr,
          },
          code: result.code === "approval_required" ? "approval_required" : result.code === "extension_disabled" ? "extension_disabled" : "execution_error",
          approvalId: result.approvalId,
        };
      },
    },
  );

  if (!result.ok && result.message === "app_not_allowed") {
    return {
      ...result,
      code: "app_not_allowed" as const,
      message: "Requested app is not allowed by current mac control policy.",
    };
  }
  return result;
};

const executeTask = async (taskId: string) => {
  const task = getTaskRun(taskId);
  if (!task) {
    return;
  }
  if (taskDependsOn.has(taskId)) {
    taskLog(taskId, "task_state", "task_waiting_dependency", {
      dependsOnTaskId: taskDependsOn.get(taskId),
    });
    return;
  }
  if (taskCancellation.has(taskId)) {
    setTaskStatus(taskId, "cancelled", {
      cancelledAt: new Date().toISOString(),
    });
    return;
  }
  setTaskStatus(taskId, "running");

  try {
    let skillInput: SkillExecutionInput;
    if (task.skillId) {
      skillInput = {
        skillId: task.skillId,
        args: task.args || {},
        mode: "manual",
      };
    } else {
      const prompt = task.prompt.toLowerCase();
      const selectedSkill: SkillId = prompt.includes("antigravity")
        ? "antigravity.open"
        : prompt.includes("chrome")
          ? "browser.external.chrome.open"
          : prompt.includes("claude")
            ? "claude.run_task"
          : prompt.includes("terminal")
            ? "terminal.run_command"
            : prompt.includes("tweet") || prompt.includes("x ")
              ? "x-social.run_endpoint"
              : "codex.run_task";
      const args =
        selectedSkill === "terminal.run_command"
          ? { command: task.prompt }
          : selectedSkill === "x-social.run_endpoint"
            ? { endpoint: "search_x_v3", endpointArgs: { query: task.prompt, limit: 10 } }
            : selectedSkill === "browser.external.chrome.open"
              ? { url: task.prompt }
              : { prompt: task.prompt };
      skillInput = {
        skillId: selectedSkill,
        args,
        mode: "manual",
      };
      task.skillId = selectedSkill;
      task.args = args;
    }

    taskLog(taskId, "skill_action", `running_skill:${skillInput.skillId}`, {
      skillId: skillInput.skillId,
      args: skillInput.args || {},
    });
    const result = await runSkillRequest(skillInput, { taskId });
    if (!result.ok) {
      if (result.code === "approval_required") {
        setTaskStatus(taskId, "waiting_approval", {
          approvalId: result.approvalId,
        });
      } else if (result.code === "app_not_allowed") {
        setTaskStatus(taskId, "failed", {
          error: result.message,
        });
      } else {
        setTaskStatus(taskId, "failed", {
          error: result.message,
        });
      }
      taskLog(taskId, "error", result.message, {
        code: result.code || "execution_error",
      });
      return;
    }

    taskLog(taskId, "skill_action", "skill_completed", {
      skillId: result.skillId,
      payload: result.payload || {},
    });
    if (result.payload?.session && typeof result.payload.session === "object") {
      const sessionObj = result.payload.session as { stdout?: string; stderr?: string };
      if (sessionObj.stdout) {
        taskLog(taskId, "stdout_chunk", "stdout", { chunk: String(sessionObj.stdout).slice(-2000) });
      }
      if (sessionObj.stderr) {
        taskLog(taskId, "stdout_chunk", "stderr", { chunk: String(sessionObj.stderr).slice(-2000) });
      }
    }
    setTaskStatus(taskId, "completed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setTaskStatus(taskId, "failed", {
      error: message,
    });
    taskLog(taskId, "error", message);
  }
};

const createTaskRun = (input: {
  prompt: string;
  skillId?: SkillId;
  args?: Record<string, unknown>;
  dependsOnTaskId?: string;
  chainId?: string;
  chainIndex?: number;
  chainLength?: number;
}): TaskRun => {
  const now = new Date().toISOString();
  const task: TaskRun = {
    id: randomUUID(),
    status: "queued",
    createdAt: now,
    updatedAt: now,
    prompt: input.prompt,
    skillId: input.skillId,
    args: input.args || {},
    dependsOnTaskId: input.dependsOnTaskId,
    chainId: input.chainId,
    chainIndex: input.chainIndex,
    chainLength: input.chainLength,
    logs: [],
  };
  registerTask(task);
  taskLog(task.id, "task_state", "task_queued", {
    status: task.status,
  });
  if (input.dependsOnTaskId) {
    const dependencyTask = taskRuns.get(input.dependsOnTaskId);
    if (!dependencyTask) {
      setTaskStatus(task.id, "failed", {
        error: `Dependency task ${input.dependsOnTaskId} not found.`,
      });
      return task;
    }
    if (dependencyTask.status === "failed" || dependencyTask.status === "cancelled") {
      setTaskStatus(task.id, "cancelled", {
        cancelledAt: new Date().toISOString(),
        error: `Dependency task ${input.dependsOnTaskId} ended as ${dependencyTask.status}.`,
      });
      return task;
    }
    if (dependencyTask.status !== "completed") {
      taskDependsOn.set(task.id, input.dependsOnTaskId);
      const dependents = taskDependencyIndex.get(input.dependsOnTaskId) || [];
      dependents.push(task.id);
      taskDependencyIndex.set(input.dependsOnTaskId, dependents);
      taskLog(task.id, "task_state", "task_waiting_dependency", {
        dependsOnTaskId: input.dependsOnTaskId,
      });
      return task;
    }
    taskLog(task.id, "task_state", "dependency_satisfied", {
      dependsOnTaskId: input.dependsOnTaskId,
    });
  }
  return task;
};

const parseXHandleFromInput = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.includes("x.com/") || trimmed.includes("twitter.com/")) {
    try {
      const url = new URL(trimmed);
      const first = url.pathname.split("/").filter(Boolean)[0] || "";
      return first.replace(/^@/, "");
    } catch {
      return "";
    }
  }
  return trimmed.replace(/^@/, "");
};

const toRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
};

const toRecordArray = (value: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => item as Record<string, unknown>);
};

const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean);
};

const compactText = (value: unknown, maxLen = 400): string => {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
};

const extractXPayloadData = (payload: unknown): Record<string, unknown> => {
  const root = toRecord(payload);
  const directData = root.data;
  if (directData && typeof directData === "object" && !Array.isArray(directData)) {
    return directData as Record<string, unknown>;
  }
  if (root.success === true && root.data && typeof root.data === "object" && !Array.isArray(root.data)) {
    return root.data as Record<string, unknown>;
  }
  return root;
};

const extractHandleFromProfile = (profile: Record<string, unknown>): string => {
  const direct = String(
    profile.handle ||
      profile.username ||
      profile.user_name ||
      profile.screen_name ||
      "",
  ).trim();
  if (direct) {
    return direct.replace(/^@/, "");
  }
  const profileUrl = String(profile.profile_url || profile.url || "").trim();
  return parseXHandleFromInput(profileUrl);
};

interface PersonaPost {
  tweetId?: string;
  url?: string;
  text: string;
  author: string;
  timestamp?: string;
  isRepost: boolean;
  hasMedia: boolean;
  hasVideo: boolean;
  mediaCount: number;
  mediaUrls: string[];
}

interface PersonaArtifacts {
  sourceType: string;
  sourceValue: string;
  handle: string;
  profile: Record<string, unknown>;
  timelinePosts: PersonaPost[];
  authoredPosts: PersonaPost[];
  reposts: PersonaPost[];
  mediaPosts: PersonaPost[];
  followers: Array<{ handle: string; displayName: string; bio: string }>;
  followings: Array<{ handle: string; displayName: string; bio: string }>;
}

const X_HEAVY_RANKER_WEIGHTS = {
  favorite: 0.5,
  retweet: 1.0,
  reply: 13.5,
  good_profile_click: 12.0,
  video_playback50: 0.005,
  reply_engaged_by_author: 75.0,
  good_click: 11.0,
  good_click_v2: 10.0,
  negative_feedback_v2: -74.0,
  report: -369.0,
} as const;

type XHeavyAction = keyof typeof X_HEAVY_RANKER_WEIGHTS;

const X_HEAVY_ACTIONS: XHeavyAction[] = [
  "favorite",
  "retweet",
  "reply",
  "good_profile_click",
  "video_playback50",
  "reply_engaged_by_author",
  "good_click",
  "good_click_v2",
  "negative_feedback_v2",
  "report",
];

const normalizePostRow = (row: Record<string, unknown>, targetHandle: string): PersonaPost | null => {
  const text = compactText(row.text, 500);
  const url = compactText(row.url, 400);
  const tweetId = compactText(row.tweet_id || row.tweetId, 80);
  const author = compactText(row.author, 120).replace(/^@/, "");
  const timestamp = compactText(row.timestamp, 80);
  const socialContext = compactText(row.social_context || row.socialContext, 160).toLowerCase();
  const mediaUrls = Array.from(
    new Set([...toStringArray(row.media_urls), ...toStringArray(row.image_urls)].map((item) => item.trim()).filter(Boolean)),
  );
  const mediaCountRaw = Number(row.media_count || row.mediaCount || 0);
  const hasVideo = row.has_video === true || mediaUrls.some((item) => /video|ext_tw_video|amplify_video/i.test(item));
  const hasMedia = row.has_media === true || mediaUrls.length > 0 || hasVideo || (Number.isFinite(mediaCountRaw) && mediaCountRaw > 0);
  const mediaCount = Number.isFinite(mediaCountRaw) && mediaCountRaw > 0 ? Math.trunc(mediaCountRaw) : mediaUrls.length + (hasVideo ? 1 : 0);
  const target = targetHandle.trim().toLowerCase();
  const normalizedAuthor = author.toLowerCase();
  const isRepostByAuthor = Boolean(target && normalizedAuthor && normalizedAuthor !== target);
  const isRepostHint = row.is_repost_hint === true || /repost|retweet/.test(socialContext);
  const isRepost = isRepostByAuthor || isRepostHint;

  if (!text && !url && !tweetId) {
    return null;
  }

  return {
    tweetId: tweetId || undefined,
    url: url || undefined,
    text,
    author: author || "",
    timestamp: timestamp || undefined,
    isRepost,
    hasMedia,
    hasVideo,
    mediaCount,
    mediaUrls,
  };
};

const dedupePosts = (rows: PersonaPost[]): PersonaPost[] => {
  const seen = new Map<string, PersonaPost>();
  for (const row of rows) {
    const key = row.tweetId || row.url || `${row.author}|${row.timestamp || ""}|${row.text}`;
    if (!key) {
      continue;
    }
    if (!seen.has(key)) {
      seen.set(key, row);
    }
  }
  return Array.from(seen.values());
};

const normalizeConnections = (rows: Record<string, unknown>[]): Array<{ handle: string; displayName: string; bio: string }> => {
  return rows
    .map((row) => {
      const handle = compactText(row.handle, 120).replace(/^@/, "");
      const displayName = compactText(row.display_name || row.displayName, 140);
      const bio = compactText(row.bio, 280);
      return {
        handle,
        displayName,
        bio,
      };
    })
    .filter((row) => Boolean(row.handle || row.displayName || row.bio));
};

const runXDataBestEffort = async (
  endpoint: string,
  endpointArgs: XArgMap,
  requestGlobalArgs: XArgMap,
): Promise<Record<string, unknown>> => {
  const result = await runX(endpoint, endpointArgs, requestGlobalArgs);
  if (!result.ok) {
    return {};
  }
  return extractXPayloadData(result.payload);
};

const collectPersonaArtifacts = async (
  sourceType: string,
  sourceValue: string,
  globalArgs: XArgMap,
): Promise<PersonaArtifacts> => {
  let profile: Record<string, unknown> = {};
  let handle = parseXHandleFromInput(sourceValue);

  if (sourceType === "active_profile") {
    const result = await runX("get_my_x_account_detail_v3", {}, globalArgs);
    if (!result.ok) {
      throw new Error("Could not read active profile.");
    }
    profile = extractXPayloadData(result.payload);
    handle = handle || extractHandleFromProfile(profile);
  } else if (sourceType === "x_username" || sourceType === "x_url") {
    handle = parseXHandleFromInput(sourceValue);
    if (!handle) {
      throw new Error("Valid X username or URL is required.");
    }
    const result = await runX("user_info", { username: handle }, globalArgs);
    if (!result.ok) {
      throw new Error("Could not fetch target profile.");
    }
    profile = extractXPayloadData(result.payload);
    handle = handle || extractHandleFromProfile(profile);
  } else if (handle) {
    profile = await runXDataBestEffort("user_info", { username: handle }, globalArgs);
  }

  handle = handle || extractHandleFromProfile(profile);

  if ((sourceType === "active_profile" || sourceType === "x_username" || sourceType === "x_url") && !handle) {
    throw new Error("Could not resolve account handle for persona derivation.");
  }

  if (!handle) {
    return {
      sourceType,
      sourceValue,
      handle: "",
      profile,
      timelinePosts: [],
      authoredPosts: [],
      reposts: [],
      mediaPosts: [],
      followers: [],
      followings: [],
    };
  }

  if (Object.keys(profile).length === 0) {
    profile = await runXDataBestEffort("user_info", { username: handle }, globalArgs);
  }

  const [timelineData, authoredData, repostData, mediaData, followersData, followingsData] = await Promise.all([
    runXDataBestEffort("user_last_tweets", { username: handle, limit: 120 }, globalArgs),
    runXDataBestEffort("tweet_advanced_search", { query: `from:${handle}`, tab: "latest", limit: 90 }, globalArgs),
    runXDataBestEffort("tweet_advanced_search", { query: `from:${handle} filter:nativeretweets`, tab: "latest", limit: 80 }, globalArgs),
    runXDataBestEffort("tweet_advanced_search", { query: `from:${handle} filter:images`, tab: "latest", limit: 80 }, globalArgs),
    runXDataBestEffort("user_followers", { username: handle, limit: 40 }, globalArgs),
    runXDataBestEffort("user_followings", { username: handle, limit: 40 }, globalArgs),
  ]);

  const timelinePosts = dedupePosts(toRecordArray(timelineData.tweets).map((row) => normalizePostRow(row, handle)).filter((row): row is PersonaPost => Boolean(row)));
  const authoredSearchPosts = dedupePosts(toRecordArray(authoredData.tweets).map((row) => normalizePostRow(row, handle)).filter((row): row is PersonaPost => Boolean(row)));
  const repostSearchPosts = dedupePosts(toRecordArray(repostData.tweets).map((row) => normalizePostRow(row, handle)).filter((row): row is PersonaPost => Boolean(row)));
  const mediaSearchPosts = dedupePosts(toRecordArray(mediaData.tweets).map((row) => normalizePostRow(row, handle)).filter((row): row is PersonaPost => Boolean(row)));

  const authoredPosts = dedupePosts(
    [...authoredSearchPosts, ...timelinePosts]
      .filter((row) => !row.isRepost)
      .filter((row) => Boolean(row.text)),
  );
  const reposts = dedupePosts([...repostSearchPosts, ...timelinePosts.filter((row) => row.isRepost)]);
  const mediaPosts = dedupePosts([...mediaSearchPosts, ...timelinePosts.filter((row) => row.hasMedia)]);

  return {
    sourceType,
    sourceValue,
    handle,
    profile,
    timelinePosts,
    authoredPosts,
    reposts,
    mediaPosts,
    followers: normalizeConnections(toRecordArray(followersData.users)),
    followings: normalizeConnections(toRecordArray(followingsData.users)),
  };
};

const clamp01 = (value: unknown): number => {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  if (num <= 0) {
    return 0;
  }
  if (num >= 1) {
    return 1;
  }
  return num;
};

const countRegex = (text: string, pattern: RegExp): number => {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
};

const computeAuthorMetrics = (artifacts: PersonaArtifacts) => {
  const posts = artifacts.authoredPosts.slice(0, 80);
  const total = posts.length || 1;
  const avgChars =
    posts.reduce((sum, post) => sum + (post.text ? post.text.length : 0), 0) / total;
  const questionRate = posts.filter((post) => post.text.includes("?")).length / total;
  const linkRate = posts.filter((post) => /https?:\/\//i.test(post.text)).length / total;
  const hashtagRate =
    posts.reduce((sum, post) => sum + countRegex(post.text, /(^|\s)#[\w_]+/g), 0) / total;
  const mentionRate =
    posts.reduce((sum, post) => sum + countRegex(post.text, /(^|\s)@[\w_]+/g), 0) / total;
  const mediaRate = posts.filter((post) => post.hasMedia).length / total;
  const repostRate = artifacts.reposts.length / Math.max(1, artifacts.timelinePosts.length);

  const timestamps = posts
    .map((post) => Date.parse(post.timestamp || ""))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a);

  let cadenceHours = 0;
  if (timestamps.length >= 2) {
    const deltas: number[] = [];
    for (let i = 1; i < timestamps.length; i += 1) {
      const delta = Math.abs(timestamps[i - 1] - timestamps[i]) / 36e5;
      if (delta > 0) {
        deltas.push(delta);
      }
      if (deltas.length >= 20) {
        break;
      }
    }
    cadenceHours = deltas.length ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : 0;
  }

  return {
    postCount: posts.length,
    avgChars,
    questionRate,
    linkRate,
    hashtagRate,
    mentionRate,
    mediaRate,
    repostRate,
    cadenceHours,
  };
};

const extractTrendTopics = (raw: Record<string, unknown>): string[] => {
  const trends = toRecordArray(raw.trends || raw.items || raw.topics || raw.data || []);
  const out = trends
    .map((row) =>
      compactText(row.topic || row.name || row.title || row.keyword, 120),
    )
    .filter(Boolean);
  return Array.from(new Set(out)).slice(0, 20);
};

const scoreByWeights = (probabilities: Record<XHeavyAction, number>) => {
  const breakdown = X_HEAVY_ACTIONS.map((action) => {
    const probability = clamp01(probabilities[action]);
    const weight = X_HEAVY_RANKER_WEIGHTS[action];
    const weighted = probability * weight;
    return {
      action,
      probability,
      weight,
      weighted,
    };
  });
  const totalScore = breakdown.reduce((sum, row) => sum + row.weighted, 0);
  return {
    totalScore,
    breakdown,
  };
};

const fallbackProbabilityModel = (
  draft: string,
  metrics: ReturnType<typeof computeAuthorMetrics>,
): Record<XHeavyAction, number> => {
  const text = draft.trim();
  const len = text.length;
  const hasQuestion = text.includes("?");
  const hasLink = /https?:\/\//i.test(text);
  const hasHashtag = /(^|\s)#[\w_]+/.test(text);
  const hasMediaHint = /(image|video|clip|photo|thread|chart|visual)/i.test(text);
  const hasCTA = /(what do you think|reply|thoughts|drop|vote|poll|rt|repost|share)/i.test(text);

  const lengthQuality =
    len === 0
      ? 0
      : len < 40
        ? 0.35
        : len < 140
          ? 0.75
          : len < 230
            ? 0.68
            : 0.45;

  const conversationalLift = (hasQuestion ? 0.12 : 0) + (hasCTA ? 0.1 : 0);
  const mediaLift = hasMediaHint ? 0.08 : 0;
  const linkPenalty = hasLink ? 0.06 : 0;
  const hashtagPenalty = hasHashtag ? 0.02 : 0;
  const baseline = Math.max(0.02, Math.min(0.95, lengthQuality + conversationalLift + mediaLift - linkPenalty - hashtagPenalty));

  const favorite = Math.max(0.03, Math.min(0.9, baseline * (0.85 + metrics.mediaRate * 0.1)));
  const retweet = Math.max(0.02, Math.min(0.8, baseline * (0.72 + (hasCTA ? 0.1 : 0))));
  const reply = Math.max(0.03, Math.min(0.9, baseline * (0.95 + (hasQuestion ? 0.2 : 0))));
  const goodProfile = Math.max(0.02, Math.min(0.75, baseline * (0.62 + metrics.mentionRate * 0.2)));
  const playback50 = Math.max(0, Math.min(0.5, hasMediaHint ? 0.18 : 0.03));
  const replyAuthorEngaged = Math.max(0.01, Math.min(0.4, reply * (0.15 + Math.max(0, 0.2 - metrics.repostRate * 0.1))));
  const goodClick = Math.max(0.02, Math.min(0.85, baseline * (0.88 + (hasCTA ? 0.12 : 0))));
  const goodClickV2 = Math.max(0.02, Math.min(0.85, baseline * (0.8 + (hasQuestion ? 0.1 : 0))));
  const negative = Math.max(0.005, Math.min(0.35, 0.02 + (hasCTA ? 0.02 : 0) + (hasHashtag ? 0.01 : 0)));
  const report = Math.max(0.0002, Math.min(0.06, negative * 0.08));

  return {
    favorite,
    retweet,
    reply,
    good_profile_click: goodProfile,
    video_playback50: playback50,
    reply_engaged_by_author: replyAuthorEngaged,
    good_click: goodClick,
    good_click_v2: goodClickV2,
    negative_feedback_v2: negative,
    report,
  };
};

const buildAlgorithmHeuristics = (
  draft: string,
  artifacts: PersonaArtifacts,
  trends: string[],
  metrics: ReturnType<typeof computeAuthorMetrics>,
) => {
  const text = draft.trim().toLowerCase();
  const trendMatches = trends.filter((topic) => {
    const token = topic.toLowerCase().replace(/^#/, "");
    if (!token || token.length < 3) {
      return false;
    }
    return text.includes(token);
  });

  const sourceMix = {
    inNetworkSignals: {
      followersSample: artifacts.followers.length,
      followingsSample: artifacts.followings.length,
    },
    outOfNetworkSignals: {
      trendTopicCount: trends.length,
      trendTopicMatches: trendMatches.length,
    },
    authoredVsRepostRatio:
      artifacts.authoredPosts.length /
      Math.max(1, artifacts.reposts.length),
  };

  return {
    sourceMix,
    checks: {
      hasQuestion: draft.includes("?"),
      hasLink: /https?:\/\//i.test(draft),
      hasHashtag: /(^|\s)#[\w_]+/.test(draft),
      hasLikelyMediaHook: /(image|video|clip|photo|chart|visual)/i.test(draft),
      trendAligned: trendMatches.length > 0,
      trendMatches,
      likelyConversational: /(reply|thoughts|what do you think|\?)/i.test(draft),
      cadenceHours: metrics.cadenceHours,
      avgCharsBaseline: metrics.avgChars,
    },
  };
};

const runAlgorithmLLM = async (params: {
  draft: string;
  styleHint?: string;
  trends: string[];
  artifacts: PersonaArtifacts;
  metrics: ReturnType<typeof computeAuthorMetrics>;
}) => {
  const { draft, styleHint, trends, artifacts, metrics } = params;
  const examplePosts = artifacts.authoredPosts
    .slice(0, 20)
    .map((post) => compactText(post.text, 240))
    .filter(Boolean);

  const contextPayload = {
    handle: artifacts.handle,
    profile: {
      display_name: compactText(artifacts.profile.display_name, 120) || null,
      bio: compactText(artifacts.profile.bio, 260) || null,
    },
    metrics,
    trends: trends.slice(0, 15),
    examples: examplePosts,
    weights: X_HEAVY_RANKER_WEIGHTS,
  };

  const ai = await runAIText({
    system:
      "You are an X recommendation analyst. Return strict JSON only; no markdown.",
    prompt: [
      "Given the draft and context, estimate engagement probabilities used by X heavy-ranker style scoring.",
      "Return JSON with keys:",
      '{ "probabilities": { "favorite": number, "retweet": number, "reply": number, "good_profile_click": number, "video_playback50": number, "reply_engaged_by_author": number, "good_click": number, "good_click_v2": number, "negative_feedback_v2": number, "report": number }, "notes": string[], "optimizedDrafts": string[], "querySuggestions": string[] }',
      "All probabilities must be between 0 and 1.",
      "optimizedDrafts should be 2-4 short post drafts under 260 chars each.",
      `Style hint: ${compactText(styleHint, 140) || "concise, high-signal, conversational"}`,
      `Draft:\n${draft}`,
      `Context:\n${JSON.stringify(contextPayload)}`,
    ].join("\n\n"),
    temperature: 0.2,
  });

  const parsed = parseJSONObjectFromText(ai.text) || {};
  const probsRaw = toRecord(parsed.probabilities);
  const probabilities: Record<XHeavyAction, number> = {
    favorite: clamp01(probsRaw.favorite),
    retweet: clamp01(probsRaw.retweet),
    reply: clamp01(probsRaw.reply),
    good_profile_click: clamp01(probsRaw.good_profile_click),
    video_playback50: clamp01(probsRaw.video_playback50),
    reply_engaged_by_author: clamp01(probsRaw.reply_engaged_by_author),
    good_click: clamp01(probsRaw.good_click),
    good_click_v2: clamp01(probsRaw.good_click_v2),
    negative_feedback_v2: clamp01(probsRaw.negative_feedback_v2),
    report: clamp01(probsRaw.report),
  };

  return {
    probabilities,
    notes: toStringArray(parsed.notes).map((item) => compactText(item, 240)).filter(Boolean).slice(0, 10),
    optimizedDrafts: toStringArray(parsed.optimizedDrafts).map((item) => compactText(item, 280)).filter(Boolean).slice(0, 4),
    querySuggestions: toStringArray(parsed.querySuggestions).map((item) => compactText(item, 120)).filter(Boolean).slice(0, 8),
  };
};

const buildXAlgorithmIntel = async (params: {
  handle?: string;
  draft?: string;
  styleHint?: string;
  globalArgs: XArgMap;
}) => {
  const requestedHandle = parseXHandleFromInput(params.handle || "");
  const sourceType = requestedHandle ? "x_username" : "active_profile";
  const artifacts = await collectPersonaArtifacts(sourceType, requestedHandle, params.globalArgs);
  if (!artifacts.handle) {
    throw new Error("Could not resolve a handle for X algorithm analysis.");
  }

  const trendsData = await runXDataBestEffort("trends", { limit: 20 }, params.globalArgs);
  const trends = extractTrendTopics(trendsData);
  const draft = (params.draft || "").trim();
  const metrics = computeAuthorMetrics(artifacts);

  const fallbackProbabilities = fallbackProbabilityModel(draft || artifacts.authoredPosts[0]?.text || "", metrics);
  let llmOutcome:
    | {
        probabilities: Record<XHeavyAction, number>;
        notes: string[];
        optimizedDrafts: string[];
        querySuggestions: string[];
      }
    | undefined;

  if (draft) {
    try {
      llmOutcome = await runAlgorithmLLM({
        draft,
        styleHint: params.styleHint,
        trends,
        artifacts,
        metrics,
      });
    } catch {
      llmOutcome = undefined;
    }
  }

  const probabilities = llmOutcome?.probabilities || fallbackProbabilities;
  const scoring = scoreByWeights(probabilities);
  const heuristics = buildAlgorithmHeuristics(draft, artifacts, trends, metrics);

  const recommendedQueries = Array.from(
    new Set([
      `from:${artifacts.handle}`,
      `from:${artifacts.handle} filter:images`,
      `from:${artifacts.handle} filter:nativeretweets`,
      ...trends.slice(0, 5).map((trend) => trend.startsWith("#") ? trend : `#${trend.replace(/\s+/g, "")}`),
      ...(llmOutcome?.querySuggestions || []),
    ]),
  ).slice(0, 12);

  return {
    source: {
      handle: artifacts.handle,
      sourceType: artifacts.sourceType,
      sourceValue: artifacts.sourceValue,
      profile: artifacts.profile,
    },
    model: {
      weights: X_HEAVY_RANKER_WEIGHTS,
      score: scoring.totalScore,
      breakdown: scoring.breakdown,
      probabilities,
    },
    heuristics,
    draftIntel: {
      inputDraft: draft || null,
      optimizedDrafts: llmOutcome?.optimizedDrafts || [],
      notes: llmOutcome?.notes || [],
      bestDraft: llmOutcome?.optimizedDrafts?.[0] || draft || null,
    },
    retrieval: {
      trends,
      recommendedQueries,
      postExamples: artifacts.authoredPosts
        .slice(0, 10)
        .map((post) => ({
          text: compactText(post.text, 240),
          url: post.url || null,
          timestamp: post.timestamp || null,
          hasMedia: post.hasMedia,
        })),
    },
    artifactCounts: {
      authoredPosts: artifacts.authoredPosts.length,
      reposts: artifacts.reposts.length,
      mediaPosts: artifacts.mediaPosts.length,
      followersSample: artifacts.followers.length,
      followingsSample: artifacts.followings.length,
    },
    openSourceBasis: {
      components: [
        "Candidate sourcing (search-index / UTEG / FRS / Graph features)",
        "Heavy ranker weighted engagement scoring",
        "Home mixer heuristics (diversity, balance, filtering)",
        "Visibility and safety filters",
      ],
      references: [
        "twitter/the-algorithm README architecture and For You pipeline",
        "twitter/the-algorithm-ml heavy-ranker engagement outputs and weighted sum",
        "X engineering + Help Center recommendation system docs",
      ],
    },
  };
};

const parseJSONObjectFromText = (raw: string): Record<string, unknown> | null => {
  const text = raw.trim();
  if (!text) {
    return null;
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  const payload = start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;
  try {
    const parsed = JSON.parse(payload);
    return toRecord(parsed);
  } catch {
    return null;
  }
};

const normalizeMatchText = (value: string): string => {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
};

const pickRealPostExamples = (
  requested: string[],
  realPool: string[],
  maxExamples = 8,
): string[] => {
  const byNorm = new Map(realPool.map((item) => [normalizeMatchText(item), item]));
  const selected: string[] = [];
  const seen = new Set<string>();

  for (const candidate of requested) {
    const normalized = normalizeMatchText(candidate);
    if (!normalized) {
      continue;
    }
    let match = byNorm.get(normalized);
    if (!match) {
      match = realPool.find((item) => {
        const itemNorm = normalizeMatchText(item);
        return itemNorm.includes(normalized) || normalized.includes(itemNorm);
      });
    }
    if (!match || seen.has(match)) {
      continue;
    }
    seen.add(match);
    selected.push(match);
    if (selected.length >= maxExamples) {
      break;
    }
  }

  if (selected.length === 0) {
    for (const sample of realPool) {
      if (seen.has(sample)) {
        continue;
      }
      seen.add(sample);
      selected.push(sample);
      if (selected.length >= maxExamples) {
        break;
      }
    }
  }

  return selected;
};

const derivePersonaFromArtifacts = async (artifacts: PersonaArtifacts, styleHint?: string) => {
  const profile = artifacts.profile;
  const handle = artifacts.handle;
  const name = compactText(profile.display_name || profile.name, 120);
  const bio = compactText(profile.bio, 320);
  const fallbackVoice = compactText(styleHint, 120) || "concise, confident, tactical";
  const realPostPool = artifacts.authoredPosts
    .map((post) => compactText(post.text, 280))
    .filter(Boolean);
  const indexedPostPool = realPostPool.slice(0, 40).map((text, index) => ({ index, text }));

  const evidence = {
    profile: {
      handle,
      displayName: name || null,
      bio: bio || null,
      followers: compactText(profile.followers, 80) || null,
      following: compactText(profile.following, 80) || null,
    },
    counts: {
      timelinePosts: artifacts.timelinePosts.length,
      authoredPosts: artifacts.authoredPosts.length,
      reposts: artifacts.reposts.length,
      mediaPosts: artifacts.mediaPosts.length,
      followersSample: artifacts.followers.length,
      followingsSample: artifacts.followings.length,
    },
    authoredSamples: artifacts.authoredPosts.slice(0, 45).map((post) => ({
      text: compactText(post.text, 280),
      url: post.url || null,
      timestamp: post.timestamp || null,
      hasMedia: post.hasMedia,
      hasVideo: post.hasVideo,
      mediaCount: post.mediaCount,
    })),
    repostSamples: artifacts.reposts.slice(0, 25).map((post) => ({
      text: compactText(post.text, 220),
      author: post.author || null,
      url: post.url || null,
      timestamp: post.timestamp || null,
    })),
    mediaSamples: artifacts.mediaPosts.slice(0, 25).map((post) => ({
      text: compactText(post.text, 220),
      url: post.url || null,
      mediaUrls: post.mediaUrls.slice(0, 4),
      hasVideo: post.hasVideo,
    })),
    followerSamples: artifacts.followers.slice(0, 15),
    followingSamples: artifacts.followings.slice(0, 15),
    indexedPostPool,
  };

  const fallbackCharacter = [
    `You are ${name || handle || "an operator"} on X.`,
    bio ? `Persona context: ${bio}.` : "Persona context: no bio available.",
    `Voice style: ${fallbackVoice}.`,
    "Write high-signal posts with crisp structure, concrete observations, and minimal filler.",
    realPostPool.length ? `Mirror cadence from these real posts:\n- ${realPostPool.slice(0, 4).join("\n- ")}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  try {
    const ai = await runAIText({
      system:
        "You are a persona extraction engine for social-agent onboarding. Return strict JSON only. No markdown.",
      prompt: [
        "Derive an X persona from artifacts. Use only evidence supplied.",
        "Return JSON with keys:",
        '{ "stylePrompt": string, "voiceStyle": string, "characterPrompt": string, "exampleIndices": number[], "postExamples": string[] }',
        "Rules:",
        "- stylePrompt: practical posting instructions grounded in observed behavior (120-220 words).",
        "- voiceStyle: concise style tag line (max 14 words).",
        "- characterPrompt: operator character prompt for agent runtime (120-220 words).",
        "- exampleIndices: indices from indexedPostPool for strongest examples (5-10 items).",
        "- postExamples: optional, but if present they must be verbatim from authored posts.",
        `Style hint: ${compactText(styleHint, 160) || "confident, concise, high-signal"}`,
        `Artifacts JSON:\n${JSON.stringify(evidence)}`,
      ].join("\n\n"),
      temperature: 0.25,
    });

    const parsed = parseJSONObjectFromText(ai.text) || {};
    const rawStylePrompt = compactText(parsed.stylePrompt, 2500);
    const rawVoiceStyle = compactText(parsed.voiceStyle, 240);
    const rawCharacterPrompt = compactText(parsed.characterPrompt, 2800);
    const rawIndices = Array.isArray(parsed.exampleIndices)
      ? parsed.exampleIndices
          .map((item) => Number(item))
          .filter((item) => Number.isInteger(item) && item >= 0 && item < indexedPostPool.length)
          .map((item) => Math.trunc(item))
      : [];
    const indexedExamples = rawIndices.map((idx) => indexedPostPool[idx]?.text || "").filter(Boolean);
    const rawExamples = toStringArray(parsed.postExamples).map((item) => compactText(item, 280));
    const postExamples = pickRealPostExamples([...indexedExamples, ...rawExamples], realPostPool, 10);

    return {
      sourceHandle: handle,
      sourceProfile: profile,
      stylePrompt: rawStylePrompt || fallbackCharacter,
      voiceStyle: rawVoiceStyle || fallbackVoice,
      characterPrompt: rawCharacterPrompt || fallbackCharacter,
      postExamples,
      artifactStats: {
        timelinePosts: artifacts.timelinePosts.length,
        authoredPosts: artifacts.authoredPosts.length,
        reposts: artifacts.reposts.length,
        mediaPosts: artifacts.mediaPosts.length,
      },
    };
  } catch {
    return {
      sourceHandle: handle,
      sourceProfile: profile,
      stylePrompt: fallbackCharacter,
      voiceStyle: fallbackVoice,
      characterPrompt: fallbackCharacter,
      postExamples: pickRealPostExamples([], realPostPool, 10),
      artifactStats: {
        timelinePosts: artifacts.timelinePosts.length,
        authoredPosts: artifacts.authoredPosts.length,
        reposts: artifacts.reposts.length,
        mediaPosts: artifacts.mediaPosts.length,
      },
    };
  }
};

interface HeartbeatState {
  enabled: boolean;
  intervalMinutes: number;
  autoAct: boolean;
  fetchLimit: number;
  inProgress: boolean;
  lastTrigger: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  lastContext: {
    handle: string;
    timelineCount: number;
    notificationCount: number;
    timelineSamples: string[];
    notificationSamples: string[];
    summary: string | null;
  } | null;
  lastPlan: {
    model?: string;
    title?: string;
    objective?: string;
    steps: Array<{ endpoint: string; waitMs: number; args: Record<string, unknown> }>;
  } | null;
  lastActions: Array<{ endpoint: string; ok: boolean; error?: string }>;
}

const heartbeatState: HeartbeatState = {
  enabled: appConfig.heartbeat.enabled,
  intervalMinutes: appConfig.heartbeat.intervalMinutes,
  autoAct: appConfig.heartbeat.autoAct,
  fetchLimit: appConfig.heartbeat.fetchLimit,
  inProgress: false,
  lastTrigger: null,
  lastRunAt: null,
  lastSuccessAt: null,
  nextRunAt: null,
  lastError: null,
  lastContext: null,
  lastPlan: null,
  lastActions: [],
};

const autonomyState = {
  enabled: false,
};

let heartbeatTimer: NodeJS.Timeout | null = null;

const toCompactSamples = (rows: Record<string, unknown>[], limit = 12): string[] => {
  return rows
    .slice(0, limit)
    .map((row) => compactText(row.text || row.social_context || row.title || row.body || "", 220))
    .filter(Boolean);
};

const heartbeatGlobalArgs = (): XArgMap => {
  return {
    ...buildDefaultXGlobalArgs(),
    notify: false,
  };
};

const runHeartbeatCycle = async (
  trigger: string,
): Promise<{ ok: boolean; skipped?: boolean; reason?: string; state: HeartbeatState }> => {
  if (!heartbeatState.enabled) {
    return {
      ok: false,
      skipped: true,
      reason: "heartbeat_disabled",
      state: heartbeatState,
    };
  }
  if (heartbeatState.inProgress) {
    return {
      ok: false,
      skipped: true,
      reason: "heartbeat_in_progress",
      state: heartbeatState,
    };
  }

  heartbeatState.inProgress = true;
  heartbeatState.lastTrigger = trigger;
  heartbeatState.lastRunAt = new Date().toISOString();
  heartbeatState.lastError = null;
  emitLiveEvent("heartbeat_start", {
    trigger,
  });

  try {
    const globalArgs = heartbeatGlobalArgs();
    const onboarding = await getOnboardingState();
    autonomyState.enabled = onboarding.autonomy.enabled;
    if (!onboarding.extensions.x.enabled) {
      heartbeatState.lastActions = [
        {
          endpoint: "x-social",
          ok: false,
          error: "extension_disabled",
        },
      ];
      return {
        ok: false,
        skipped: true,
        reason: "x_extension_disabled",
        state: heartbeatState,
      };
    }

    const [profileRes, timelineRes, notificationsRes] = await Promise.all([
      runX("get_my_x_account_detail_v3", {}, globalArgs),
      runX("home_timeline", { limit: heartbeatState.fetchLimit }, globalArgs),
      runX("notifications_list", { limit: heartbeatState.fetchLimit }, globalArgs),
    ]);

    const profile = extractXPayloadData(profileRes.payload);
    const handle = extractHandleFromProfile(profile);
    const timelineData = extractXPayloadData(timelineRes.payload);
    const notificationsData = extractXPayloadData(notificationsRes.payload);

    const timelineRows = toRecordArray(timelineData.tweets);
    const notificationRows = toRecordArray(notificationsData.notifications);
    const timelineSamples = toCompactSamples(timelineRows);
    const notificationSamples = toCompactSamples(notificationRows);

    let summary: string | null = null;
    try {
      const ai = await runTextWithProviderRouting({
        system:
          "You are a realtime social ops analyst. Summarize priority signals from timeline and notifications in 8 bullets max.",
        prompt: [
          `Handle: ${handle || "unknown"}`,
          `Timeline count: ${timelineRows.length}`,
          `Notification count: ${notificationRows.length}`,
          `Timeline samples:\n- ${timelineSamples.slice(0, 12).join("\n- ") || "(none)"}`,
          `Notification samples:\n- ${notificationSamples.slice(0, 12).join("\n- ") || "(none)"}`,
        ].join("\n\n"),
        temperature: 0.2,
      });
      summary = ai.text.trim() || null;
    } catch {
      summary = null;
    }

    heartbeatState.lastContext = {
      handle,
      timelineCount: timelineRows.length,
      notificationCount: notificationRows.length,
      timelineSamples,
      notificationSamples,
      summary,
    };

    heartbeatState.lastPlan = null;
    heartbeatState.lastActions = [];

    if (heartbeatState.autoAct && autonomyState.enabled) {
      let planner:
        | {
            model: string;
            plan: {
              title: string;
              objective: string;
              steps: Array<{
                endpoint: string;
                description: string;
                waitMs: number;
                args: Record<string, string | number | boolean | null | Array<string | number | boolean | null>>;
              }>;
            };
          }
        | null = null;

      try {
        planner = await runAutomationPlannerWithRouting({
          goal:
            "Monitor timeline and notifications, then proceed to act with useful engagement steps. Prefer safe write actions (like, retweet, concise replies, or draft tweet) only when confidence is high.",
          context: [
            `Handle: ${handle || "unknown"}`,
            summary ? `Signal summary:\n${summary}` : "",
            `Timeline samples:\n- ${timelineSamples.slice(0, 10).join("\n- ") || "(none)"}`,
            `Notification samples:\n- ${notificationSamples.slice(0, 10).join("\n- ") || "(none)"}`,
          ]
            .filter(Boolean)
            .join("\n\n"),
        });
      } catch {
        planner = null;
      }

      if (planner?.plan) {
        const limitedSteps = planner.plan.steps.slice(0, 8);
        heartbeatState.lastPlan = {
          model: planner.model,
          title: planner.plan.title,
          objective: planner.plan.objective,
          steps: limitedSteps.map((step) => ({
            endpoint: step.endpoint,
            waitMs: step.waitMs,
            args: step.args,
          })),
        };

        for (const step of limitedSteps) {
          if (step.waitMs > 0) {
            await sleep(Math.min(step.waitMs, 7_000));
          }
          const result = await runX(
            step.endpoint,
            step.args as XArgMap,
            globalArgs,
            { reason: "autonomy_step" },
          );
          heartbeatState.lastActions.push({
            endpoint: step.endpoint,
            ok: result.ok,
            error: result.ok ? undefined : result.error || result.code || "step_failed",
          });
          if (!result.ok) {
            if (result.code === "extension_disabled" || result.code === "approval_required") {
              continue;
            }
            break;
          }
        }
      }
    }

    heartbeatState.lastSuccessAt = new Date().toISOString();
    emitLiveEvent("heartbeat_result", {
      ok: true,
      trigger,
      actionCount: heartbeatState.lastActions.length,
    });
    return { ok: true, state: heartbeatState };
  } catch (error) {
    heartbeatState.lastError = error instanceof Error ? error.message : String(error);
    emitLiveEvent("heartbeat_result", {
      ok: false,
      trigger,
      error: heartbeatState.lastError,
    });
    return { ok: false, state: heartbeatState };
  } finally {
    heartbeatState.inProgress = false;
  }
};

const sleep = async (ms: number) => {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
};

app.get("/api/health", async (_req, res) => {
  const onboarding = await getOnboardingState();
  const cache = await getModelCache();
  const providerStatus = await getProviderStatus().catch(() => null);
  const pordieScope = resolvePordieScope(onboarding.pordie.scope);
  const pordiePaths = resolvePordiePaths(pordieScope);
  pruneApprovalQueue();
  pruneCodeApprovalQueue();
  pruneSkillApprovalQueue();
  res.json({
    ok: true,
    service: "prompt-or-die-social-suite",
    xScriptPath: appConfig.xLocal.scriptPath,
    onboardingCompleted: onboarding.completed,
    hasOpenRouterKey: Boolean(onboarding.openrouter.apiKey || appConfig.openrouter.apiKey),
    modelCachePath,
    modelCacheUpdatedAt: cache?.fetchedAt || null,
    modelCount: cache?.totalCount || 0,
    providers: providerStatus,
    extensions: onboarding.extensions,
    skills: {
      enabledCount: skillCatalog.filter((skill) => isSkillEnabled(skill.id, onboarding.skills.enabled || {})).length,
      totalCount: skillCatalog.length,
    },
    macControl: onboarding.macControl,
    watch: onboarding.watch,
    autonomy: {
      enabled: onboarding.autonomy.enabled,
      policy: onboarding.autonomy.policy,
      queueSize: pendingApprovalCount(),
    },
    coding: {
      enabled: onboarding.extensions.code.enabled,
      approvalQueueSize: codeApprovalQueue.filter((item) => item.status === "pending").length,
      taskQueueSize: Array.from(taskRuns.values()).filter((task) => task.status === "running" || task.status === "queued").length,
      sessions: listWorkspaceSessions(10).map((session) => ({
        id: session.id,
        command: session.command,
        status: session.status,
        startedAt: session.startedAt,
        finishedAt: session.finishedAt,
        exitCode: session.exitCode,
      })),
    },
    watchSessions: Array.from(watchSessions.values()).filter((session) => session.active).length,
    pordie: {
      scope: pordieScope,
      scopeOverride: appConfig.pordie.scopeOverride || null,
      dir: pordiePaths.dir,
      configPath: pordiePaths.configPath,
      envPath: pordiePaths.envPath,
      envScriptPath: pordiePaths.envScriptPath,
      enabled: onboarding.pordie.enabled,
    },
    heartbeat: {
      enabled: heartbeatState.enabled,
      intervalMinutes: heartbeatState.intervalMinutes,
      autoAct: heartbeatState.autoAct,
      fetchLimit: heartbeatState.fetchLimit,
      inProgress: heartbeatState.inProgress,
      lastRunAt: heartbeatState.lastRunAt,
      lastSuccessAt: heartbeatState.lastSuccessAt,
      nextRunAt: heartbeatState.nextRunAt,
      lastError: heartbeatState.lastError,
    },
  });
});

app.get("/api/live/snapshot", (_req, res) => {
  res.json({
    ok: true,
    events: liveEventHistory.slice(-120),
  });
});

app.get("/api/live/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  liveSseClients.add(res);
  const bootstrap = liveEventHistory.slice(-40);
  for (const event of bootstrap) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, ts: new Date().toISOString() })}\n\n`);

  const heartbeat = setInterval(() => {
    try {
      res.write(`event: ping\ndata: ${Date.now()}\n\n`);
    } catch {
      clearInterval(heartbeat);
      liveSseClients.delete(res);
    }
  }, 20_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    liveSseClients.delete(res);
  });
});

const coworkMissionTemplates: Array<{
  id: string;
  title: string;
  lane: "social" | "coding" | "hybrid";
  description: string;
  defaultPrompt: string;
  skillId: SkillId;
  args: Record<string, unknown>;
}> = [
  {
    id: "social_signal_sweep",
    title: "Social Signal Sweep",
    lane: "social",
    description: "Scan X for relevant trend shifts and collect high-signal opportunities.",
    defaultPrompt: "Scan X for high-signal AI agent trend shifts and summarize actionable opportunities.",
    skillId: "x-social.run_endpoint",
    args: {
      endpoint: "search_x_v3",
      endpointArgs: {
        query: "AI agents trend",
        limit: 20,
      },
    },
  },
  {
    id: "coding_repo_sprint",
    title: "Coding Repo Sprint",
    lane: "coding",
    description: "Run a coding analysis pass and propose next safe changes.",
    defaultPrompt: "Review the current repository and propose the top 3 safe, high-impact coding actions.",
    skillId: "codex.run_task",
    args: {
      prompt: "Review the current repository and propose the top 3 safe, high-impact coding actions.",
    },
  },
  {
    id: "hybrid_growth_loop",
    title: "Hybrid Growth Loop",
    lane: "hybrid",
    description: "Coordinate coding and social actions into a single execution loop.",
    defaultPrompt:
      "Coordinate a hybrid growth loop: identify social opportunities and map them to concrete code improvements.",
    skillId: "claude.run_task",
    args: {
      prompt:
        "Coordinate a hybrid growth loop: identify social opportunities and map them to concrete code improvements.",
    },
  },
];

app.get("/api/cowork/missions", (_req, res) => {
  res.json({
    ok: true,
    missions: coworkMissionTemplates,
  });
});

app.post("/api/cowork/missions/:id/run", (req, res) => {
  const missionId = String(req.params.id || "").trim();
  const mission = coworkMissionTemplates.find((item) => item.id === missionId);
  if (!mission) {
    res.status(404).json({ ok: false, error: "Mission template not found." });
    return;
  }
  const promptOverride = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  const queryOverride = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  const startTask = req.body?.startTask !== false;

  const prompt = promptOverride || mission.defaultPrompt;
  const args: Record<string, unknown> = {
    ...mission.args,
  };
  if (mission.id === "social_signal_sweep" && queryOverride) {
    args.endpointArgs = {
      ...(typeof args.endpointArgs === "object" && args.endpointArgs ? (args.endpointArgs as Record<string, unknown>) : {}),
      query: queryOverride,
    };
  }
  if (mission.skillId === "codex.run_task" || mission.skillId === "claude.run_task") {
    args.prompt = prompt;
  }

  const task = createTaskRun({
    prompt,
    skillId: mission.skillId,
    args,
  });
  if (startTask && !taskDependsOn.has(task.id) && task.status === "queued") {
    queueTaskExecution(task.id);
  }

  emitLiveEvent("cowork_mission_queued", {
    missionId: mission.id,
    taskId: task.id,
    startTask,
  });

  res.json({
    ok: true,
    mission,
    task,
  });
});

app.post("/api/cowork/dispatch", async (req, res) => {
  const task = typeof req.body?.task === "string" ? req.body.task.trim() : "";
  const autoPlan = req.body?.autoPlan === true;
  const startTask = req.body?.startTask === true;
  const requestedSkillId = typeof req.body?.skillId === "string" ? (req.body.skillId.trim() as SkillId) : undefined;
  const requestedArgs =
    typeof req.body?.args === "object" && req.body?.args ? (req.body.args as Record<string, unknown>) : undefined;
  if (!task) {
    res.status(400).json({ ok: false, error: "task is required" });
    return;
  }

  emitLiveEvent("cowork_task_received", {
    task,
    autoPlan,
  });

  try {
    const text = await runTextWithProviderRouting({
      system:
        "You are an autonomous coworking agent for social operations and coding workflows. Return concise, actionable guidance and next actions.",
      prompt: task,
      temperature: 0.25,
    });

    let plan:
      | {
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
      | null = null;

    if (autoPlan) {
      try {
        const planned = await runAutomationPlannerWithRouting({
          goal: task,
          context: text.text,
        });
        plan = planned.plan;
      } catch {
        plan = null;
      }
    }

    emitLiveEvent("cowork_task_result", {
      task,
      provider: text.provider,
      hasPlan: Boolean(plan),
    });

    let queuedTask: TaskRun | null = null;
    if (startTask) {
      queuedTask = createTaskRun({
        prompt: task,
        skillId: requestedSkillId && getSkillDefinition(requestedSkillId) ? requestedSkillId : undefined,
        args: requestedArgs || {},
      });
      if (!taskDependsOn.has(queuedTask.id) && queuedTask.status === "queued") {
        queueTaskExecution(queuedTask.id);
      }
    }

    res.json({
      ok: true,
      result: {
        text: text.text,
        provider: text.provider,
        model: text.model || null,
        plan,
      },
      task: queuedTask,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitLiveEvent("cowork_task_error", {
      task,
      error: message,
    });
    res.status(400).json({ ok: false, error: message });
  }
});

app.get("/api/cowork/state", async (_req, res) => {
  pruneApprovalQueue();
  pruneCodeApprovalQueue();
  pruneSkillApprovalQueue();
  const onboarding = await getOnboardingState();
  const tasks = taskRunOrder
    .slice()
    .reverse()
    .map((id) => taskRuns.get(id))
    .filter((item): item is TaskRun => Boolean(item));
  const activeWatchSessions = Array.from(watchSessions.values()).filter((session) => session.active);
  const approvalCounts = {
    x: approvalQueue.filter((item) => item.status === "pending").length,
    code: codeApprovalQueue.filter((item) => item.status === "pending").length,
    skills: skillApprovalQueue.filter((item) => item.status === "pending").length,
  };
  const taskSummary = {
    total: tasks.length,
    queued: tasks.filter((item) => item.status === "queued").length,
    running: tasks.filter((item) => item.status === "running").length,
    waitingApproval: tasks.filter((item) => item.status === "waiting_approval").length,
    completed: tasks.filter((item) => item.status === "completed").length,
    failed: tasks.filter((item) => item.status === "failed").length,
    cancelled: tasks.filter((item) => item.status === "cancelled").length,
  };
  const enabledSkillCount = skillCatalog.filter((skill) => isSkillEnabled(skill.id, onboarding.skills.enabled || {})).length;
  const livekit = resolveLivekitStatus(onboarding);
  res.json({
    ok: true,
    summary: {
      tasks: taskSummary,
      approvals: {
        ...approvalCounts,
        total: approvalCounts.x + approvalCounts.code + approvalCounts.skills,
      },
      watch: {
        active: activeWatchSessions.length,
        total: watchSessions.size,
      },
      livekit: {
        enabled: livekit.enabled,
        configured: livekit.configured,
        mode: livekit.mode,
        streamMode: livekit.streamMode,
      },
      autonomy: {
        enabled: autonomyState.enabled,
        thinking: heartbeatState.inProgress,
        queueSize: pendingApprovalCount(),
      },
      skills: {
        enabled: enabledSkillCount,
        total: skillCatalog.length,
      },
    },
    active: {
      tasks: tasks
        .filter((item) => item.status === "queued" || item.status === "running" || item.status === "waiting_approval")
        .slice(0, 12)
        .map((item) => ({
          id: item.id,
          status: item.status,
          prompt: item.prompt,
          skillId: item.skillId || null,
          updatedAt: item.updatedAt,
        })),
      watchSessions: activeWatchSessions,
    },
  });
});

app.get("/api/livekit/status", async (_req, res) => {
  const onboarding = await getOnboardingState();
  const status = resolveLivekitStatus(onboarding);
  res.json({
    ok: true,
    livekit: status,
  });
});

app.post("/api/livekit/config", async (req, res) => {
  const patch: Partial<OnboardingState["livekit"]> = {};
  if (typeof req.body?.enabled === "boolean") {
    patch.enabled = req.body.enabled;
  }
  if (typeof req.body?.wsUrl === "string") {
    const wsUrl = normalizeLivekitWsUrl(req.body.wsUrl);
    if (!wsUrl && req.body.wsUrl.trim() !== "") {
      res.status(400).json({ ok: false, error: "wsUrl must be ws://, wss://, http://, or https:// format." });
      return;
    }
    patch.wsUrl = wsUrl;
  }
  if (typeof req.body?.apiKey === "string") {
    const apiKey = req.body.apiKey.trim();
    patch.apiKey = apiKey || undefined;
  }
  if (typeof req.body?.roomPrefix === "string") {
    const roomPrefix = req.body.roomPrefix.trim();
    if (roomPrefix && !/^[a-zA-Z0-9._-]{2,64}$/.test(roomPrefix)) {
      res
        .status(400)
        .json({ ok: false, error: "roomPrefix must be 2-64 chars using letters, numbers, dot, dash, or underscore." });
      return;
    }
    patch.roomPrefix = roomPrefix || "milady-cowork";
  }
  if (typeof req.body?.streamMode === "string") {
    const streamMode = req.body.streamMode.trim();
    if (!["events_only", "events_and_frames"].includes(streamMode)) {
      res.status(400).json({ ok: false, error: "streamMode must be events_only or events_and_frames." });
      return;
    }
    patch.streamMode = streamMode as "events_only" | "events_and_frames";
  }

  const currentOnboarding = await getOnboardingState();
  const previewOnboarding: OnboardingState = {
    ...currentOnboarding,
    livekit: {
      ...currentOnboarding.livekit,
      ...patch,
    },
  };
  const previewStatus = resolveLivekitStatus(previewOnboarding);
  if (patch.enabled === true && !previewStatus.configured) {
    res.status(400).json({
      ok: false,
      error: `Cannot enable LiveKit until configured: missing ${previewStatus.missing.join(", ")}.`,
      livekit: previewStatus,
    });
    return;
  }

  const onboarding = await saveOnboardingState({
    livekit: patch,
  } as Parameters<typeof saveOnboardingState>[0]);
  const status = resolveLivekitStatus(onboarding);
  emitLiveEvent("livekit_config_updated", {
    enabled: status.enabled,
    configured: status.configured,
    mode: status.mode,
    streamMode: status.streamMode,
    roomPrefix: status.roomPrefix,
  });
  res.json({
    ok: true,
    livekit: status,
  });
});

app.post("/api/cowork/quick-action", (req, res) => {
  const action = typeof req.body?.action === "string" ? req.body.action.trim() : "";
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";

  const quickActionMap: Record<
    string,
    {
      prompt: string;
      skillId: SkillId;
      args: Record<string, unknown>;
    }
  > = {
    open_antigravity: {
      prompt: "Open Antigravity workspace",
      skillId: "antigravity.open",
      args: {},
    },
    open_terminal: {
      prompt: "Open Terminal app",
      skillId: "terminal.open",
      args: {},
    },
    open_chrome: {
      prompt: "Open Chrome browser",
      skillId: "browser.external.chrome.open",
      args: {
        url: url || "https://x.com/home",
      },
    },
    run_codex: {
      prompt: prompt || "Review the current workspace and suggest the next coding step.",
      skillId: "codex.run_task",
      args: {
        prompt: prompt || "Review the current workspace and suggest the next coding step.",
      },
    },
    run_claude: {
      prompt: prompt || "Plan a safe coding sequence for the active repository.",
      skillId: "claude.run_task",
      args: {
        prompt: prompt || "Plan a safe coding sequence for the active repository.",
      },
    },
  };

  const mapped = quickActionMap[action];
  if (!mapped) {
    res.status(400).json({
      ok: false,
      error: "Unsupported quick action. Use open_antigravity, open_terminal, open_chrome, run_codex, or run_claude.",
    });
    return;
  }

  const task = createTaskRun({
    prompt: mapped.prompt,
    skillId: mapped.skillId,
    args: mapped.args,
  });
  if (!taskDependsOn.has(task.id) && task.status === "queued") {
    queueTaskExecution(task.id);
  }

  emitLiveEvent("cowork_quick_action_enqueued", {
    action,
    taskId: task.id,
    skillId: mapped.skillId,
  });

  res.json({
    ok: true,
    action,
    task,
  });
});

app.get("/api/providers/status", async (_req, res) => {
  const onboarding = await getOnboardingState();
  try {
    const status = await getProviderStatus();
    res.json({ ok: true, status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.json({
      ok: false,
      status: {
        mode: onboarding.providers.mode,
        claudeSessionDetected: false,
        openrouterConfigured: Boolean(onboarding.openrouter.apiKey || appConfig.openrouter.apiKey),
        activeRoute: onboarding.providers.mode,
        capabilities: {
          text: onboarding.providers.mode,
          image: "openrouter",
          video: "openrouter",
          embedding: "openrouter",
          voice: "openrouter",
        },
      },
      error: message,
    });
  }
});

app.post("/api/providers/mode", async (req, res) => {
  const mode = typeof req.body?.mode === "string" ? req.body.mode.trim() : "";
  if (!["claude_subscription", "openrouter", "hybrid"].includes(mode)) {
    res.status(400).json({ ok: false, error: "mode must be one of claude_subscription | openrouter | hybrid" });
    return;
  }
  try {
    const onboarding = await saveOnboardingState({
      providers: {
        mode: mode as "claude_subscription" | "openrouter" | "hybrid",
      },
    } as Parameters<typeof saveOnboardingState>[0]);
    const status = await getProviderStatus();
    res.json({
      ok: true,
      onboarding,
      status,
    });
    emitLiveEvent("provider_mode_changed", {
      mode,
      activeRoute: status.activeRoute,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ ok: false, error: message });
  }
});

app.post("/api/claude/login/start", async (_req, res) => {
  try {
    const result = await startClaudeCliLogin();
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ ok: false, error: message });
  }
});

app.get("/api/claude/login/status", async (_req, res) => {
  const session = await detectClaudeSession();
  res.json({
    ok: true,
    detected: session.detected,
    sessionPath: session.path,
  });
});

app.get("/api/extensions", async (_req, res) => {
  const onboarding = await getOnboardingState();
  res.json({
    ok: true,
    extensions: {
      "x-social": onboarding.extensions.x,
      "code-workspace": onboarding.extensions.code,
    },
  });
});

app.post("/api/extensions/:id/enable", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!["x-social", "code-workspace"].includes(id)) {
    res.status(404).json({ ok: false, error: "Unsupported extension id." });
    return;
  }
  const extensionPatch =
    id === "x-social"
      ? {
          x: {
            enabled: true,
          },
        }
      : {
          code: {
            enabled: true,
          },
        };
  const onboarding = await saveOnboardingState({
    extensions: extensionPatch,
  } as unknown as Parameters<typeof saveOnboardingState>[0]);
  res.json({
    ok: true,
    extensions: {
      "x-social": onboarding.extensions.x,
      "code-workspace": onboarding.extensions.code,
    },
  });
  emitLiveEvent("extension_enabled", { extensionId: id });
});

app.post("/api/extensions/:id/disable", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!["x-social", "code-workspace"].includes(id)) {
    res.status(404).json({ ok: false, error: "Unsupported extension id." });
    return;
  }
  const extensionPatch =
    id === "x-social"
      ? {
          x: {
            enabled: false,
          },
        }
      : {
          code: {
            enabled: false,
          },
        };
  const onboarding = await saveOnboardingState({
    extensions: extensionPatch,
  } as unknown as Parameters<typeof saveOnboardingState>[0]);
  res.json({
    ok: true,
    extensions: {
      "x-social": onboarding.extensions.x,
      "code-workspace": onboarding.extensions.code,
    },
  });
  emitLiveEvent("extension_disabled", { extensionId: id });
});

app.get("/api/skills", async (_req, res) => {
  const onboarding = await getOnboardingState();
  const enabledMap = onboarding.skills.enabled || {};
  res.json({
    ok: true,
    policy: onboarding.macControl,
    skills: skillCatalog.map((skill) => ({
      ...skill,
      enabled: isSkillEnabled(skill.id, enabledMap),
    })),
  });
});

app.post("/api/skills/:id/enable", async (req, res) => {
  const id = String(req.params.id || "").trim() as SkillId;
  if (!getSkillDefinition(id)) {
    res.status(404).json({ ok: false, error: "Unsupported skill id." });
    return;
  }
  const onboarding = await saveOnboardingState({
    skills: {
      enabled: {
        [id]: true,
      },
    },
  } as Parameters<typeof saveOnboardingState>[0]);
  emitLiveEvent("skill_enabled", { skillId: id });
  res.json({
    ok: true,
    skillId: id,
    enabled: isSkillEnabled(id, onboarding.skills.enabled),
  });
});

app.post("/api/skills/:id/disable", async (req, res) => {
  const id = String(req.params.id || "").trim() as SkillId;
  if (!getSkillDefinition(id)) {
    res.status(404).json({ ok: false, error: "Unsupported skill id." });
    return;
  }
  const onboarding = await saveOnboardingState({
    skills: {
      enabled: {
        [id]: false,
      },
    },
  } as Parameters<typeof saveOnboardingState>[0]);
  emitLiveEvent("skill_disabled", { skillId: id });
  res.json({
    ok: true,
    skillId: id,
    enabled: isSkillEnabled(id, onboarding.skills.enabled),
  });
});

app.post("/api/skills/run", async (req, res) => {
  const skillId = String(req.body?.skillId || "").trim() as SkillId;
  if (!getSkillDefinition(skillId)) {
    res.status(400).json({ ok: false, error: "Valid skillId is required." });
    return;
  }
  const args = typeof req.body?.args === "object" && req.body?.args ? (req.body.args as Record<string, unknown>) : {};
  const result = await runSkillRequest({
    skillId,
    args,
    mode: "manual",
  });
  const status =
    result.ok ? 200 : result.code === "skill_disabled" ? 423 : result.code === "approval_required" ? 409 : result.code === "app_not_allowed" ? 403 : 400;
  res.status(status).json({
    ok: result.ok,
    result,
  });
});

app.get("/api/skills/approvals", (_req, res) => {
  pruneSkillApprovalQueue();
  res.json({
    ok: true,
    approvals: skillApprovalQueue.filter((item) => item.status === "pending"),
  });
});

app.post("/api/skills/approvals/:id/approve", async (req, res) => {
  pruneSkillApprovalQueue();
  const id = String(req.params.id || "").trim();
  const item = skillApprovalQueue.find((approval) => approval.id === id);
  if (!item) {
    res.status(404).json({ ok: false, error: "Skill approval not found." });
    return;
  }
  if (item.status !== "pending") {
    res.status(400).json({ ok: false, error: `Skill approval is already ${item.status}.` });
    return;
  }
  item.status = "approved";
  const result = await runSkillRequest(
    {
      skillId: item.skillId,
      args: item.args,
      mode: "manual",
      approvalBypass: true,
    },
    {
      taskId: item.taskId,
      approvalBypass: true,
    },
  );
  if (item.taskId && result.ok) {
    setTaskStatus(item.taskId, "completed", { approvalId: item.id });
  } else if (item.taskId && !result.ok) {
    setTaskStatus(item.taskId, "failed", { approvalId: item.id, error: result.message });
  }
  res.status(result.ok ? 200 : result.code === "app_not_allowed" ? 403 : 400).json({
    ok: result.ok,
    approval: item,
    result,
  });
});

app.post("/api/skills/approvals/:id/reject", (req, res) => {
  pruneSkillApprovalQueue();
  const id = String(req.params.id || "").trim();
  const item = skillApprovalQueue.find((approval) => approval.id === id);
  if (!item) {
    res.status(404).json({ ok: false, error: "Skill approval not found." });
    return;
  }
  if (item.status !== "pending") {
    res.status(400).json({ ok: false, error: `Skill approval is already ${item.status}.` });
    return;
  }
  item.status = "rejected";
  if (item.taskId) {
    setTaskStatus(item.taskId, "cancelled", {
      cancelledAt: new Date().toISOString(),
      approvalId: item.id,
    });
  }
  res.json({
    ok: true,
    approval: item,
  });
});

app.post("/api/agent/tasks", async (req, res) => {
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  const skillIdRaw = typeof req.body?.skillId === "string" ? req.body.skillId.trim() : "";
  const skillId = skillIdRaw ? (skillIdRaw as SkillId) : undefined;
  const args = typeof req.body?.args === "object" && req.body?.args ? (req.body.args as Record<string, unknown>) : {};
  const dependsOnTaskId = typeof req.body?.dependsOnTaskId === "string" ? req.body.dependsOnTaskId.trim() : "";
  if (!prompt && !skillId) {
    res.status(400).json({ ok: false, error: "prompt or skillId is required." });
    return;
  }
  if (skillId && !getSkillDefinition(skillId)) {
    res.status(400).json({ ok: false, error: "Invalid skillId." });
    return;
  }
  if (dependsOnTaskId && !taskRuns.has(dependsOnTaskId)) {
    res.status(400).json({ ok: false, error: "dependsOnTaskId does not exist." });
    return;
  }
  const task = createTaskRun({
    prompt: prompt || `Run skill ${skillId}`,
    skillId,
    args,
    dependsOnTaskId: dependsOnTaskId || undefined,
  });
  if (!taskDependsOn.has(task.id) && task.status === "queued") {
    queueTaskExecution(task.id);
  }
  res.json({
    ok: true,
    task,
  });
});

app.post("/api/agent/tasks/chain", (req, res) => {
  const stepsRaw = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
  if (!stepsRaw.length) {
    res.status(400).json({ ok: false, error: "tasks[] is required." });
    return;
  }

  const chainId = randomUUID();
  const tasks: TaskRun[] = [];
  let previousTaskId: string | undefined;

  for (let index = 0; index < stepsRaw.length; index += 1) {
    const row = stepsRaw[index];
    if (!row || typeof row !== "object") {
      res.status(400).json({ ok: false, error: `tasks[${index}] must be an object.` });
      return;
    }
    const prompt = typeof (row as Record<string, unknown>).prompt === "string" ? String((row as Record<string, unknown>).prompt).trim() : "";
    const skillIdRaw =
      typeof (row as Record<string, unknown>).skillId === "string"
        ? String((row as Record<string, unknown>).skillId).trim()
        : "";
    const skillId = skillIdRaw ? (skillIdRaw as SkillId) : undefined;
    const args =
      typeof (row as Record<string, unknown>).args === "object" && (row as Record<string, unknown>).args
        ? ((row as Record<string, unknown>).args as Record<string, unknown>)
        : {};

    if (!prompt && !skillId) {
      res.status(400).json({ ok: false, error: `tasks[${index}] must include prompt or skillId.` });
      return;
    }
    if (skillId && !getSkillDefinition(skillId)) {
      res.status(400).json({ ok: false, error: `tasks[${index}] has invalid skillId.` });
      return;
    }

    const task = createTaskRun({
      prompt: prompt || `Run skill ${skillId}`,
      skillId,
      args,
      dependsOnTaskId: previousTaskId,
      chainId,
      chainIndex: index,
      chainLength: stepsRaw.length,
    });
    tasks.push(task);
    previousTaskId = task.id;
  }

  const startTask = req.body?.startTask !== false;
  if (startTask && tasks.length) {
    const head = tasks[0];
    if (head.status === "queued") {
      queueTaskExecution(head.id);
    }
  }

  emitLiveEvent("task_chain_created", {
    chainId,
    taskIds: tasks.map((task) => task.id),
    startTask,
  });

  res.json({
    ok: true,
    chain: {
      id: chainId,
      length: tasks.length,
      taskIds: tasks.map((task) => task.id),
    },
    tasks,
  });
});

app.get("/api/agent/tasks", (_req, res) => {
  const tasks = taskRunOrder
    .slice()
    .reverse()
    .map((id) => taskRuns.get(id))
    .filter((item): item is TaskRun => Boolean(item));
  res.json({
    ok: true,
    tasks,
  });
});

app.get("/api/agent/tasks/:id", (req, res) => {
  const id = String(req.params.id || "").trim();
  const task = taskRuns.get(id);
  if (!task) {
    res.status(404).json({ ok: false, error: "Task not found." });
    return;
  }
  res.json({
    ok: true,
    task,
  });
});

app.get("/api/agent/tasks/:id/logs", (req, res) => {
  const id = String(req.params.id || "").trim();
  const task = taskRuns.get(id);
  if (!task) {
    res.status(404).json({ ok: false, error: "Task not found." });
    return;
  }
  const limitRaw = Number(req.query?.limit || 120);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 120;
  const typeFilter = typeof req.query?.type === "string" ? req.query.type.trim() : "";
  const logs = task.logs
    .filter((entry) => (typeFilter ? entry.type === typeFilter : true))
    .slice(-limit);
  res.json({
    ok: true,
    taskId: id,
    logs,
  });
});

app.post("/api/agent/tasks/:id/cancel", (req, res) => {
  const id = String(req.params.id || "").trim();
  const task = taskRuns.get(id);
  if (!task) {
    res.status(404).json({ ok: false, error: "Task not found." });
    return;
  }
  taskCancellation.add(id);
  setTaskStatus(id, "cancelled", {
    cancelledAt: new Date().toISOString(),
  });
  for (const watch of watchSessions.values()) {
    if (watch.active && watch.taskId === id) {
      stopWatchSession(watch.id, "task_cancelled");
    }
  }
  res.json({
    ok: true,
    task,
  });
});

app.post("/api/agent/tasks/:id/retry", (req, res) => {
  const id = String(req.params.id || "").trim();
  const task = taskRuns.get(id);
  if (!task) {
    res.status(404).json({ ok: false, error: "Task not found." });
    return;
  }
  const retriedTask = createTaskRun({
    prompt: task.prompt,
    skillId: task.skillId,
    args: task.args || {},
  });
  if (!taskDependsOn.has(retriedTask.id) && retriedTask.status === "queued") {
    queueTaskExecution(retriedTask.id);
  }
  emitLiveEvent("task_retried", {
    fromTaskId: id,
    toTaskId: retriedTask.id,
    skillId: retriedTask.skillId || null,
  });
  res.json({
    ok: true,
    retriedFrom: id,
    task: retriedTask,
  });
});

app.get("/api/mac/apps", async (_req, res) => {
  const apps = listKnownMacApps();
  const onboarding = await getOnboardingState();
  const allowlist = new Set(onboarding.macControl.appAllowlist || []);
  res.json({
    ok: true,
    apps: apps.map((app) => ({
      ...app,
      allowed: allowlist.has(app.id),
    })),
    macControl: onboarding.macControl,
  });
});

app.post("/api/mac/apps/open", async (req, res) => {
  const appId = String(req.body?.appId || "").trim() as MacAppId;
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : undefined;
  const onboarding = await getOnboardingState();
  if (!onboarding.macControl.appAllowlist.includes(appId)) {
    res.status(403).json({ ok: false, code: "app_not_allowed", error: "App is not allowed by current policy." });
    return;
  }
  const result = await openMacApp(appId, { url });
  res.status(result.ok ? 200 : 400).json(result);
});

app.post("/api/mac/apps/focus", async (req, res) => {
  const appId = String(req.body?.appId || "").trim() as MacAppId;
  const onboarding = await getOnboardingState();
  if (!onboarding.macControl.appAllowlist.includes(appId)) {
    res.status(403).json({ ok: false, code: "app_not_allowed", error: "App is not allowed by current policy." });
    return;
  }
  const result = await focusMacApp(appId);
  res.status(result.ok ? 200 : 400).json(result);
});

app.get("/api/mac/policy", async (_req, res) => {
  const onboarding = await getOnboardingState();
  res.json({
    ok: true,
    macControl: onboarding.macControl,
  });
});

app.post("/api/mac/policy", async (req, res) => {
  const appAllowlist = Array.isArray(req.body?.appAllowlist)
    ? req.body.appAllowlist
        .filter((item: unknown): item is MacAppId => typeof item === "string")
        .map((item: MacAppId) => item.trim() as MacAppId)
        .filter((item: MacAppId) => item === "antigravity" || item === "terminal" || item === "chrome")
    : null;
  const requireApprovalFor = Array.isArray(req.body?.requireApprovalFor)
    ? req.body.requireApprovalFor
        .filter((item: unknown): item is string => typeof item === "string")
        .map((item: string) => item.trim())
        .filter(
          (item: string) =>
            ["app_launch", "terminal_exec", "codex_exec", "browser_external", "write_command"].includes(item),
        )
    : null;

  const patch: Record<string, unknown> = {
    macControl: {},
  };
  if (appAllowlist) {
    (patch.macControl as Record<string, unknown>).appAllowlist = appAllowlist;
  }
  if (requireApprovalFor) {
    (patch.macControl as Record<string, unknown>).requireApprovalFor = requireApprovalFor;
  }

  const onboarding = await saveOnboardingState(patch as Parameters<typeof saveOnboardingState>[0]);
  emitLiveEvent("mac_policy_updated", {
    appAllowlist: onboarding.macControl.appAllowlist,
    requireApprovalFor: onboarding.macControl.requireApprovalFor,
  });
  res.json({
    ok: true,
    macControl: onboarding.macControl,
  });
});

app.get("/api/watch/sources", (_req, res) => {
  res.json({
    ok: true,
    sources: listWatchSources(),
    sessions: Array.from(watchSessions.values()),
  });
});

app.post("/api/watch/start", async (req, res) => {
  const sourceId = String(req.body?.sourceId || "").trim() as WatchSource["id"];
  const taskId = typeof req.body?.taskId === "string" ? req.body.taskId.trim() : undefined;
  const onboarding = await getOnboardingState();
  if (!onboarding.watch.enabled) {
    res.status(400).json({ ok: false, error: "Watch mode is disabled." });
    return;
  }
  const source = listWatchSources().find((item) => item.id === sourceId);
  if (!source) {
    res.status(400).json({ ok: false, error: "Invalid sourceId." });
    return;
  }
  if (!source.available) {
    res.status(400).json({ ok: false, error: "Requested source is not available on this machine." });
    return;
  }
  if (taskId && !taskRuns.has(taskId)) {
    res.status(404).json({ ok: false, error: "Task not found for watch session." });
    return;
  }
  const session = startWatchSession({
    sourceId,
    taskId: taskId || undefined,
    fps: onboarding.watch.fps,
  });
  res.json({
    ok: true,
    session,
  });
});

app.post("/api/watch/stop", (req, res) => {
  const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";
  if (!sessionId) {
    res.status(400).json({ ok: false, error: "sessionId is required." });
    return;
  }
  const session = watchSessions.get(sessionId);
  if (!session) {
    res.status(404).json({ ok: false, error: "Watch session not found." });
    return;
  }
  stopWatchSession(session.id, "manual_stop");
  res.json({
    ok: true,
    session,
  });
});

app.post("/api/watch/frame", (req, res) => {
  const sourceId = String(req.body?.sourceId || "").trim();
  const taskId = typeof req.body?.taskId === "string" ? req.body.taskId.trim() : "";
  const frame = typeof req.body?.frame === "string" ? req.body.frame.trim() : "";
  const mime = typeof req.body?.mime === "string" ? req.body.mime.trim() : "image/png";
  if (!sourceId || !frame) {
    res.status(400).json({ ok: false, error: "sourceId and frame are required." });
    return;
  }
  emitLiveEvent("frame", {
    sourceId,
    taskId: taskId || null,
    frame,
    mime,
  });
  if (taskId) {
    taskLog(taskId, "frame", "external_frame_tick", {
      sourceId,
      mime,
    });
  }
  res.json({
    ok: true,
  });
});

app.get("/api/live/ws", (_req, res) => {
  res.status(426).json({
    ok: false,
    error: "WebSocket upgrade required. Connect with ws://<host>/api/live/ws",
  });
});

app.get("/api/code/status", async (_req, res) => {
  const onboarding = await getOnboardingState();
  pruneCodeApprovalQueue();
  pruneSkillApprovalQueue();
  const sessions = listWorkspaceSessions(20);
  res.json({
    ok: true,
    extension: onboarding.extensions.code,
    pendingApprovals: codeApprovalQueue.filter((item) => item.status === "pending").length,
    pendingSkillApprovals: skillApprovalQueue.filter((item) => item.status === "pending").length,
    runningTasks: Array.from(taskRuns.values()).filter((task) => task.status === "running" || task.status === "queued").length,
    sessions: sessions.map((session) => ({
      id: session.id,
      command: session.command,
      cwd: session.cwd,
      status: session.status,
      startedAt: session.startedAt,
      finishedAt: session.finishedAt,
      exitCode: session.exitCode,
      readOnly: session.readOnly,
    })),
  });
});

app.get("/api/code/sessions", (_req, res) => {
  const sessions = listWorkspaceSessions(60);
  res.json({
    ok: true,
    sessions,
  });
});

app.get("/api/code/sessions/:id", (req, res) => {
  const id = String(req.params.id || "").trim();
  const session = getWorkspaceSession(id);
  if (!session) {
    res.status(404).json({ ok: false, error: "Session not found." });
    return;
  }
  res.json({
    ok: true,
    session,
  });
});

app.post("/api/code/plan", async (req, res) => {
  const task = typeof req.body?.task === "string" ? req.body.task.trim() : "";
  if (!task) {
    res.status(400).json({ ok: false, error: "task is required" });
    return;
  }
  const context = typeof req.body?.context === "string" ? req.body.context.trim() : "";
  try {
    emitLiveEvent("code_plan_start", {
      task: compactText(task, 180),
    });
    const result = await runTextWithProviderRouting({
      system:
        "You are a staff-level coding agent. Produce execution-ready steps with safety checks, validation commands, and rollback notes.",
      prompt: [
        `Task:\n${task}`,
        context ? `Additional context:\n${context}` : "",
        `Workspace root:\n${projectRoot}`,
        "Response format:\n1) intent\n2) implementation steps\n3) exact commands\n4) risks/rollback",
      ]
        .filter(Boolean)
        .join("\n\n"),
      temperature: 0.2,
    });
    emitLiveEvent("code_plan_result", {
      provider: result.provider,
      model: result.model || null,
    });
    res.json({
      ok: true,
      plan: result.text,
      provider: result.provider,
      model: result.model || null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitLiveEvent("code_plan_error", {
      error: message,
    });
    res.status(400).json({ ok: false, error: message });
  }
});

app.post("/api/code/exec", async (req, res) => {
  const command = typeof req.body?.command === "string" ? req.body.command.trim() : "";
  const cwd = typeof req.body?.cwd === "string" ? req.body.cwd.trim() : undefined;
  if (!command) {
    res.status(400).json({ ok: false, error: "command is required" });
    return;
  }
  const result = await runCodeCommand(command, cwd, { reason: "manual_code_exec" });
  res.status(codeResultStatus(result)).json(result);
});

app.get("/api/code/approvals", (_req, res) => {
  pruneCodeApprovalQueue();
  res.json({
    ok: true,
    approvals: codeApprovalQueue.filter((item) => item.status === "pending"),
  });
});

app.post("/api/code/approvals/:id/approve", async (req, res) => {
  pruneCodeApprovalQueue();
  const id = String(req.params.id || "").trim();
  const item = codeApprovalQueue.find((approval) => approval.id === id);
  if (!item) {
    res.status(404).json({ ok: false, error: "Code approval item not found." });
    return;
  }
  if (item.status !== "pending") {
    res.status(400).json({ ok: false, error: `Code approval item is already ${item.status}.` });
    return;
  }
  item.status = "approved";
  const result = await runCodeCommand(item.command, item.cwd, {
    allowApprovalBypass: true,
    reason: "manual_code_approved_execution",
  });
  emitLiveEvent("code_approval_approved", {
    approvalId: item.id,
    command: item.command,
    ok: result.ok,
  });
  res.status(codeResultStatus(result)).json({
    ok: result.ok,
    approval: item,
    result,
  });
});

app.post("/api/code/approvals/:id/reject", (req, res) => {
  pruneCodeApprovalQueue();
  const id = String(req.params.id || "").trim();
  const item = codeApprovalQueue.find((approval) => approval.id === id);
  if (!item) {
    res.status(404).json({ ok: false, error: "Code approval item not found." });
    return;
  }
  if (item.status !== "pending") {
    res.status(400).json({ ok: false, error: `Code approval item is already ${item.status}.` });
    return;
  }
  item.status = "rejected";
  emitLiveEvent("code_approval_rejected", {
    approvalId: item.id,
    command: item.command,
  });
  res.json({
    ok: true,
    approval: item,
  });
});

app.get("/api/agent/autonomy", async (_req, res) => {
  const onboarding = await getOnboardingState();
  autonomyState.enabled = onboarding.autonomy.enabled;
  pruneApprovalQueue();
  pruneCodeApprovalQueue();
  pruneSkillApprovalQueue();
  res.json({
    ok: true,
    enabled: autonomyState.enabled,
    thinking: heartbeatState.inProgress,
    queueSize: pendingApprovalCount(),
    policy: onboarding.autonomy.policy,
  });
});

app.post("/api/agent/autonomy", async (req, res) => {
  if (typeof req.body?.enabled !== "boolean") {
    res.status(400).json({ ok: false, error: "enabled boolean is required" });
    return;
  }
  const onboarding = await saveOnboardingState({
    autonomy: {
      enabled: req.body.enabled,
    },
  } as Parameters<typeof saveOnboardingState>[0]);
  autonomyState.enabled = onboarding.autonomy.enabled;
  res.json({
    ok: true,
    autonomy: onboarding.autonomy.enabled,
    thinking: heartbeatState.inProgress,
    queueSize: pendingApprovalCount(),
  });
  emitLiveEvent("autonomy_toggled", {
    enabled: onboarding.autonomy.enabled,
  });
});

app.get("/api/agent/approvals", async (_req, res) => {
  pruneApprovalQueue();
  pruneCodeApprovalQueue();
  pruneSkillApprovalQueue();
  res.json({
    ok: true,
    approvals: {
      x: approvalQueue.filter((item) => item.status === "pending"),
      code: codeApprovalQueue.filter((item) => item.status === "pending"),
      skills: skillApprovalQueue.filter((item) => item.status === "pending"),
    },
  });
});

app.post("/api/agent/approvals/:id/approve", async (req, res) => {
  pruneApprovalQueue();
  pruneCodeApprovalQueue();
  pruneSkillApprovalQueue();
  const id = String(req.params.id || "").trim();
  const xItem = approvalQueue.find((approval) => approval.id === id);
  if (xItem) {
    if (xItem.status !== "pending") {
      res.status(400).json({ ok: false, error: `Approval item is already ${xItem.status}.` });
      return;
    }
    xItem.status = "approved";
    const result = await runX(xItem.endpoint, xItem.args, xItem.globalArgs, {
      allowApprovalBypass: true,
      reason: "manual_approved_execution",
    });
    emitLiveEvent("approval_approved", {
      approvalId: xItem.id,
      endpoint: xItem.endpoint,
      ok: result.ok,
      approvalType: "x",
    });
    res.status(xResultStatus(result)).json({
      ok: result.ok,
      approvalType: "x",
      approval: xItem,
      result,
    });
    return;
  }

  const codeItem = codeApprovalQueue.find((approval) => approval.id === id);
  if (codeItem) {
    if (codeItem.status !== "pending") {
      res.status(400).json({ ok: false, error: `Code approval item is already ${codeItem.status}.` });
      return;
    }
    codeItem.status = "approved";
    const result = await runCodeCommand(codeItem.command, codeItem.cwd, {
      allowApprovalBypass: true,
      reason: "manual_code_approval_execution",
    });
    emitLiveEvent("approval_approved", {
      approvalId: codeItem.id,
      ok: result.ok,
      approvalType: "code",
    });
    res.status(codeResultStatus(result)).json({
      ok: result.ok,
      approvalType: "code",
      approval: codeItem,
      result,
    });
    return;
  }

  const skillItem = skillApprovalQueue.find((approval) => approval.id === id);
  if (skillItem) {
    if (skillItem.status !== "pending") {
      res.status(400).json({ ok: false, error: `Skill approval item is already ${skillItem.status}.` });
      return;
    }
    skillItem.status = "approved";
    const result = await runSkillRequest(
      {
        skillId: skillItem.skillId,
        args: skillItem.args,
        mode: "manual",
        approvalBypass: true,
      },
      {
        approvalBypass: true,
        taskId: skillItem.taskId,
      },
    );
    if (skillItem.taskId && result.ok) {
      setTaskStatus(skillItem.taskId, "completed", {
        approvalId: skillItem.id,
      });
    } else if (skillItem.taskId && !result.ok) {
      setTaskStatus(skillItem.taskId, "failed", {
        approvalId: skillItem.id,
        error: result.message,
      });
    }
    emitLiveEvent("approval_approved", {
      approvalId: skillItem.id,
      approvalType: "skill",
      skillId: skillItem.skillId,
      ok: result.ok,
    });
    res.status(result.ok ? 200 : result.code === "app_not_allowed" ? 403 : result.code === "approval_required" ? 409 : 400).json({
      ok: result.ok,
      approvalType: "skill",
      approval: skillItem,
      result,
    });
    return;
  }

  res.status(404).json({ ok: false, error: "Approval item not found." });
});

app.post("/api/agent/approvals/:id/reject", async (req, res) => {
  pruneApprovalQueue();
  pruneCodeApprovalQueue();
  pruneSkillApprovalQueue();
  const id = String(req.params.id || "").trim();
  const xItem = approvalQueue.find((approval) => approval.id === id);
  if (xItem) {
    if (xItem.status !== "pending") {
      res.status(400).json({ ok: false, error: `Approval item is already ${xItem.status}.` });
      return;
    }
    xItem.status = "rejected";
    emitLiveEvent("approval_rejected", {
      approvalId: xItem.id,
      approvalType: "x",
      endpoint: xItem.endpoint,
    });
    res.json({
      ok: true,
      approvalType: "x",
      approval: xItem,
    });
    return;
  }

  const codeItem = codeApprovalQueue.find((approval) => approval.id === id);
  if (codeItem) {
    if (codeItem.status !== "pending") {
      res.status(400).json({ ok: false, error: `Code approval item is already ${codeItem.status}.` });
      return;
    }
    codeItem.status = "rejected";
    emitLiveEvent("approval_rejected", {
      approvalId: codeItem.id,
      approvalType: "code",
      command: codeItem.command,
    });
    res.json({
      ok: true,
      approvalType: "code",
      approval: codeItem,
    });
    return;
  }

  const skillItem = skillApprovalQueue.find((approval) => approval.id === id);
  if (skillItem) {
    if (skillItem.status !== "pending") {
      res.status(400).json({ ok: false, error: `Skill approval item is already ${skillItem.status}.` });
      return;
    }
    skillItem.status = "rejected";
    if (skillItem.taskId) {
      setTaskStatus(skillItem.taskId, "cancelled", {
        cancelledAt: new Date().toISOString(),
        approvalId: skillItem.id,
      });
    }
    emitLiveEvent("approval_rejected", {
      approvalId: skillItem.id,
      approvalType: "skill",
      skillId: skillItem.skillId,
    });
    res.json({
      ok: true,
      approvalType: "skill",
      approval: skillItem,
    });
    return;
  }

  res.status(404).json({ ok: false, error: "Approval item not found." });
});

app.get("/api/onboarding/state", async (_req, res) => {
  const onboarding = await getOnboardingState();
  const modelCache = await getModelCache();
  res.json({
    ok: true,
    onboarding,
    modelCache,
  });
});

app.get("/api/heartbeat/status", async (_req, res) => {
  pruneApprovalQueue();
  pruneCodeApprovalQueue();
  pruneSkillApprovalQueue();
  res.json({
    ok: true,
    heartbeat: heartbeatState,
    autonomy: {
      enabled: autonomyState.enabled,
      thinking: heartbeatState.inProgress,
      queueSize: pendingApprovalCount(),
    },
  });
});

app.post("/api/heartbeat/run-now", async (_req, res) => {
  const result = await runHeartbeatCycle("manual_api");
  res.status(result.ok ? 200 : result.skipped ? 202 : 400).json({
    ok: result.ok,
    skipped: result.skipped || false,
    reason: result.reason || null,
    heartbeat: result.state,
  });
});

app.post("/api/onboarding/test-openrouter-key", async (req, res) => {
  const apiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
  try {
    const result = await testOpenRouterKey(apiKey || undefined);
    res.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ ok: false, error: message });
  }
});

app.post("/api/onboarding/refresh-model-cache", async (req, res) => {
  const apiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
  try {
    const cache = await refreshModelCache(apiKey || undefined);
    res.json({ ok: true, cache });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ ok: false, error: message });
  }
});

app.post("/api/onboarding/save", async (req, res) => {
  const patch = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  const exportEnv = req.body?.exportEnv === true;
  try {
    const saved = await saveOnboardingState(patch as Parameters<typeof saveOnboardingState>[0]);
    let exported: Awaited<ReturnType<typeof exportPromptOrDieConfig>> | null = null;
    if (exportEnv && saved.pordie.enabled) {
      exported = await exportPromptOrDieConfig(saved, {
        scope: saved.pordie.scope,
        syncProjectEnv: saved.pordie.syncProjectEnv,
      });
    }
    res.json({ ok: true, onboarding: saved, exported });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ ok: false, error: message });
  }
});

app.post("/api/onboarding/complete", async (req, res) => {
  const patch = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  const forceExport = req.body?.exportEnv === true;
  try {
    const saved = await completeOnboarding(patch as Parameters<typeof completeOnboarding>[0]);
    let exported: Awaited<ReturnType<typeof exportPromptOrDieConfig>> | null = null;
    if (saved.pordie.enabled && (saved.pordie.autoExportOnComplete || forceExport)) {
      exported = await exportPromptOrDieConfig(saved, {
        scope: saved.pordie.scope,
        syncProjectEnv: saved.pordie.syncProjectEnv,
      });
    }
    res.json({ ok: true, onboarding: saved, exported });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ ok: false, error: message });
  }
});

app.post("/api/onboarding/export-env", async (req, res) => {
  try {
    const onboarding = await getOnboardingState();
    const syncProjectEnv =
      typeof req.body?.syncProjectEnv === "boolean"
        ? req.body.syncProjectEnv
        : onboarding.pordie.syncProjectEnv;
    const exported = await exportPromptOrDieConfig(onboarding, {
      scope: onboarding.pordie.scope,
      syncProjectEnv,
    });
    res.json({
      ok: true,
      exported,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ ok: false, error: message });
  }
});

app.post("/api/onboarding/import-local-secrets", async (req, res) => {
  const allowLocalSecretsRead = req.body?.allowLocalSecretsRead === true;
  if (!allowLocalSecretsRead) {
    res.status(400).json({
      ok: false,
      error: "allowLocalSecretsRead=true is required for local secret import.",
    });
    return;
  }

  const options = {
    includeProcessEnv: req.body?.includeProcessEnv === true,
    includeHomeDefaults: req.body?.includeHomeDefaults === true,
    includeShellProfiles: req.body?.includeShellProfiles === true,
    includeClaudeAuth: req.body?.includeClaudeAuth === true,
    additionalPaths: resolveStringArray(req.body?.additionalPaths),
    overrideExisting: req.body?.overrideExisting === true,
  };

  if (
    !options.includeProcessEnv &&
    !options.includeHomeDefaults &&
    !options.includeShellProfiles &&
    !options.includeClaudeAuth &&
    options.additionalPaths.length === 0
  ) {
    res.status(400).json({
      ok: false,
      error: "Select at least one local source to import from.",
    });
    return;
  }

  const persist = req.body?.persist !== false;
  const exportEnv = req.body?.exportEnv === true;

  try {
    const current = await getOnboardingState();
    const imported = await importLocalSecrets(current, options);
    let onboarding = current;

    if (persist && Object.keys(imported.patch).length > 0) {
      onboarding = await saveOnboardingState(imported.patch);
    }

    let exported: Awaited<ReturnType<typeof exportPromptOrDieConfig>> | null = null;
    if (exportEnv && onboarding.pordie.enabled) {
      const syncProjectEnv =
        typeof req.body?.syncProjectEnv === "boolean"
          ? req.body.syncProjectEnv
          : onboarding.pordie.syncProjectEnv;
      exported = await exportPromptOrDieConfig(onboarding, {
        scope: onboarding.pordie.scope,
        syncProjectEnv,
      });
    }

    res.json({
      ok: true,
      onboarding,
      import: {
        detectedFields: imported.detectedFields,
        updatedFields: imported.updatedFields,
        detectedCount: imported.detectedFields.length,
        updatedCount: imported.updatedFields.length,
        sourcesRead: imported.sourcesRead,
        sourcesWithMatches: imported.sourcesWithMatches,
        warnings: imported.warnings,
      },
      exported,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ ok: false, error: message });
  }
});

app.post("/api/persona/derive", async (req, res) => {
  const sourceType = typeof req.body?.sourceType === "string" ? req.body.sourceType : "manual";
  const sourceValue = typeof req.body?.sourceValue === "string" ? req.body.sourceValue : "";
  const styleHint = typeof req.body?.styleHint === "string" ? req.body.styleHint : "";
  const globalArgs = resolveObject(req.body?.globalArgs);

  try {
    const artifacts = await collectPersonaArtifacts(sourceType, sourceValue, globalArgs);
    const persona = await derivePersonaFromArtifacts(artifacts, styleHint);
    const artifactSummary = {
      handle: artifacts.handle,
      counts: {
        timelinePosts: artifacts.timelinePosts.length,
        authoredPosts: artifacts.authoredPosts.length,
        reposts: artifacts.reposts.length,
        mediaPosts: artifacts.mediaPosts.length,
        followersSample: artifacts.followers.length,
        followingsSample: artifacts.followings.length,
      },
      authoredExamples: artifacts.authoredPosts
        .slice(0, 12)
        .map((post) => ({
          text: compactText(post.text, 280),
          url: post.url || null,
          timestamp: post.timestamp || null,
          hasMedia: post.hasMedia,
        })),
      repostExamples: artifacts.reposts.slice(0, 8).map((post) => ({
        text: compactText(post.text, 220),
        author: post.author || null,
        url: post.url || null,
      })),
      mediaExamples: artifacts.mediaPosts.slice(0, 8).map((post) => ({
        text: compactText(post.text, 220),
        url: post.url || null,
        mediaUrls: post.mediaUrls.slice(0, 3),
      })),
    };

    res.json({
      ok: true,
      sourceType,
      sourceValue,
      resolvedHandle: artifacts.handle || "",
      persona,
      artifactSummary,
      onboardingPersonaPatch: {
        stylePrompt: persona.stylePrompt,
        voiceStyle: persona.voiceStyle,
        sourceValue: artifacts.handle || sourceValue || undefined,
        characterPrompt: persona.characterPrompt,
        postExamples: persona.postExamples,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ ok: false, error: message });
  }
});

app.post("/api/onboarding/test-x-login", async (req, res) => {
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  const globalArgs = resolveObject(req.body?.globalArgs);
  const useCredentialRefresh = Boolean(username && password);

  const endpoint = useCredentialRefresh ? "refresh_login_v3" : "user_login_v3";
  const endpointArgs = useCredentialRefresh
    ? {
        userName: username,
        password,
        email: email || undefined,
      }
    : {
        userName: username || undefined,
        email: email || undefined,
      };

  const result = await runX(endpoint, endpointArgs, globalArgs, { reason: "manual_auth_test" });
  res.status(xResultStatus(result)).json({
    ...result,
    mode: useCredentialRefresh ? "credential_refresh" : "cookie_session",
  });
});

app.get("/api/x/catalog", async (_req, res) => {
  const onboarding = await getOnboardingState();
  res.json({
    ok: true,
    count: xEndpointCatalog.length,
    extensionEnabled: onboarding.extensions.x.enabled,
    endpoints: xEndpointCatalog,
  });
});

app.post("/api/x/run", async (req, res) => {
  const body = req.body as XRunRequest;
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim() : "";
  if (!endpoint) {
    res.status(400).json({ ok: false, error: "endpoint is required" });
    return;
  }
  const endpointArgs = resolveObject(body.args);
  const requestGlobalArgs = resolveObject(body.globalArgs);
  const result = await runX(endpoint, endpointArgs, requestGlobalArgs, { reason: "manual_x_run" });
  res.status(xResultStatus(result)).json(result);
});

app.post("/api/x/workflow", async (req, res) => {
  const stepsInput: unknown[] = Array.isArray(req.body?.steps) ? req.body.steps : [];
  if (stepsInput.length === 0) {
    res.status(400).json({ ok: false, error: "steps must be a non-empty array" });
    return;
  }

  const stopOnError = req.body?.stopOnError !== false;
  const requestGlobalArgs = resolveObject(req.body?.globalArgs);

  const steps = stepsInput
    .map((step: unknown) => {
      if (!step || typeof step !== "object") {
        return null;
      }
      const raw = step as Record<string, unknown>;
      const endpoint = typeof raw.endpoint === "string" ? raw.endpoint.trim() : "";
      if (!endpoint) {
        return null;
      }
      const args = resolveObject(raw.args);
      const waitMs = typeof raw.waitMs === "number" ? Math.max(0, Math.min(60_000, Math.trunc(raw.waitMs))) : 0;
      return { endpoint, args, waitMs };
    })
    .filter((item: { endpoint: string; args: XArgMap; waitMs: number } | null): item is { endpoint: string; args: XArgMap; waitMs: number } => Boolean(item));

  if (steps.length === 0) {
    res.status(400).json({ ok: false, error: "No valid steps to run." });
    return;
  }

  const results: Array<{
    index: number;
    endpoint: string;
    args: XArgMap;
    waitMs: number;
    result: Awaited<ReturnType<typeof runX>>;
  }> = [];
  emitLiveEvent("x_workflow_start", {
    requestedSteps: steps.length,
    stopOnError,
  });

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step.waitMs > 0) {
      await sleep(step.waitMs);
    }
    const stepResult = await runX(step.endpoint, step.args, requestGlobalArgs, {
      reason: "manual_workflow_step",
    });
    results.push({
      index,
      endpoint: step.endpoint,
      args: step.args,
      waitMs: step.waitMs,
      result: stepResult,
    });
    emitLiveEvent("x_workflow_step", {
      index,
      endpoint: step.endpoint,
      ok: stepResult.ok,
      error: stepResult.error || stepResult.code || null,
    });
    if (stopOnError && !stepResult.ok) {
      break;
    }
  }

  const allPassed = results.every((item) => item.result.ok);
  const stoppedEarly = results.length < steps.length;

  const hasExtensionDisabled = results.some((item) => item.result.code === "extension_disabled");
  const hasApprovalRequired = results.some((item) => item.result.code === "approval_required");

  res.status(allPassed ? 200 : hasExtensionDisabled ? 423 : hasApprovalRequired ? 409 : 400).json({
    ok: allPassed,
    stopOnError,
    requested: steps.length,
    executed: results.length,
    stoppedEarly,
    results,
  });
  emitLiveEvent("x_workflow_result", {
    ok: allPassed,
    executed: results.length,
    requested: steps.length,
    stoppedEarly,
  });
});

app.post("/api/x/login", async (req, res) => {
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  const requestGlobalArgs = resolveObject(req.body?.globalArgs);
  if (!username || !password) {
    res.status(400).json({ ok: false, error: "username and password are required" });
    return;
  }
  const result = await runX(
    "refresh_login_v3",
    {
      userName: username,
      password,
      email: email || undefined,
    },
    requestGlobalArgs,
    { reason: "manual_login" },
  );
  res.status(xResultStatus(result)).json(result);
});

app.post("/api/x/post", async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) {
    res.status(400).json({ ok: false, error: "text is required" });
    return;
  }
  const requestGlobalArgs = resolveObject(req.body?.globalArgs);
  const result = await runX("send_tweet_v3", { text }, requestGlobalArgs, {
    reason: "manual_post",
  });
  res.status(xResultStatus(result)).json(result);
});

app.post("/api/ai/chat", async (req, res) => {
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
  if (!prompt.trim()) {
    res.status(400).json({ ok: false, error: "prompt is required" });
    return;
  }
  try {
    emitLiveEvent("ai_chat_start", {
      promptPreview: compactText(prompt, 160),
    });
    const data = await runTextWithProviderRouting({
      prompt,
      system: typeof req.body?.system === "string" ? req.body.system : undefined,
      model: typeof req.body?.model === "string" ? req.body.model : undefined,
      temperature: typeof req.body?.temperature === "number" ? req.body.temperature : undefined,
    });
    emitLiveEvent("ai_chat_result", {
      provider: data.provider,
      model: data.model || null,
    });
    res.json({ ok: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ ok: false, error: message });
  }
});

app.post("/api/ai/x-algorithm-intel", async (req, res) => {
  const handle = typeof req.body?.handle === "string" ? req.body.handle : "";
  const draft = typeof req.body?.draft === "string" ? req.body.draft : "";
  const styleHint = typeof req.body?.styleHint === "string" ? req.body.styleHint : "";
  const globalArgs = resolveObject(req.body?.globalArgs);

  try {
    const data = await buildXAlgorithmIntel({
      handle,
      draft,
      styleHint,
      globalArgs,
    });
    res.json({ ok: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ ok: false, error: message });
  }
});

app.post("/api/ai/automation-plan", async (req, res) => {
  const goal = typeof req.body?.goal === "string" ? req.body.goal.trim() : "";
  if (!goal) {
    res.status(400).json({ ok: false, error: "goal is required" });
    return;
  }
  try {
    emitLiveEvent("ai_plan_start", {
      goalPreview: compactText(goal, 180),
    });
    const data = await runAutomationPlannerWithRouting({
      goal,
      context: typeof req.body?.context === "string" ? req.body.context : undefined,
      model: typeof req.body?.model === "string" ? req.body.model : undefined,
    });
    emitLiveEvent("ai_plan_result", {
      provider: data.provider,
      model: data.model,
      stepCount: data.plan.steps.length,
    });
    res.json({ ok: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ ok: false, error: message });
  }
});

app.post("/api/ai/image", async (req, res) => {
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
  if (!prompt.trim()) {
    res.status(400).json({ ok: false, error: "prompt is required" });
    return;
  }
  try {
    await ensureOpenRouterForModality("image");
    const data = await createImageFromPrompt(prompt, typeof req.body?.model === "string" ? req.body.model : undefined);
    res.json({ ok: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ ok: false, error: message });
  }
});

app.post("/api/ai/embedding", async (req, res) => {
  const input = req.body?.input;
  if (typeof input !== "string" && !Array.isArray(input)) {
    res.status(400).json({ ok: false, error: "input must be string or string[]" });
    return;
  }
  try {
    await ensureOpenRouterForModality("embedding");
    const data = await createEmbedding(input as string | string[], typeof req.body?.model === "string" ? req.body.model : undefined);
    res.json({ ok: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ ok: false, error: message });
  }
});

app.post("/api/ai/video", async (req, res) => {
  const videoUrl = typeof req.body?.videoUrl === "string" ? req.body.videoUrl.trim() : "";
  const videoBase64 = typeof req.body?.videoBase64 === "string" ? req.body.videoBase64.trim() : "";
  if (!videoUrl && !videoBase64) {
    res.status(400).json({ ok: false, error: "videoUrl or videoBase64 is required" });
    return;
  }
  try {
    await ensureOpenRouterForModality("video");
    const data = await runVideoAnalysis({
      videoUrl: videoUrl || undefined,
      videoBase64: videoBase64 || undefined,
      format: typeof req.body?.format === "string" ? req.body.format : undefined,
      prompt: typeof req.body?.prompt === "string" ? req.body.prompt : undefined,
      model: typeof req.body?.model === "string" ? req.body.model : undefined,
    });
    res.json({ ok: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ ok: false, error: message });
  }
});

app.post("/api/ai/voice", async (req, res) => {
  const audioBase64 = typeof req.body?.audioBase64 === "string" ? req.body.audioBase64.trim() : "";
  if (!audioBase64) {
    res.status(400).json({ ok: false, error: "audioBase64 is required" });
    return;
  }
  try {
    await ensureOpenRouterForModality("voice");
    const data = await runVoiceAnalysis({
      audioBase64,
      format: typeof req.body?.format === "string" ? req.body.format : undefined,
      prompt: typeof req.body?.prompt === "string" ? req.body.prompt : undefined,
      model: typeof req.body?.model === "string" ? req.body.model : undefined,
    });
    res.json({ ok: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ ok: false, error: message });
  }
});

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(serverDir, "../web");

app.use("/", express.static(webDir));
app.get("*", (_req, res) => {
  res.sendFile(path.join(webDir, "index.html"));
});

const startHeartbeatScheduler = () => {
  if (!heartbeatState.enabled) {
    heartbeatState.nextRunAt = null;
    return;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  const intervalMs = Math.max(60_000, heartbeatState.intervalMinutes * 60_000);
  heartbeatState.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
  heartbeatTimer = setInterval(() => {
    heartbeatState.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    void runHeartbeatCycle("cron_20m");
  }, intervalMs);
  void runHeartbeatCycle("startup");
};

const handleWebSocketUpgrade = (request: { url?: string; headers: Record<string, string | string[] | undefined> }, socket: Socket) => {
  const requestUrl = request.url || "";
  if (!requestUrl.startsWith("/api/live/ws")) {
    socket.destroy();
    return;
  }
  const keyHeader = request.headers["sec-websocket-key"];
  const key = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader;
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  const headers = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n",
  ];
  socket.write(headers.join("\r\n"));
  liveWsClients.add(socket);
  const bootstrap = liveEventHistory.slice(-40);
  for (const event of bootstrap) {
    socket.write(encodeWebSocketFrame(JSON.stringify(event)));
  }
  socket.on("close", () => {
    liveWsClients.delete(socket);
  });
  socket.on("end", () => {
    liveWsClients.delete(socket);
  });
  socket.on("error", () => {
    liveWsClients.delete(socket);
  });
  socket.on("data", (buffer: Buffer) => {
    if (!buffer || buffer.length < 2) {
      return;
    }
    const opcode = buffer[0] & 0x0f;
    if (opcode === 0x8) {
      try {
        socket.end();
      } catch {
        // ignore
      }
      liveWsClients.delete(socket);
    }
  });
};

const server = app.listen(appConfig.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Prompt or Die Social Suite listening on http://localhost:${appConfig.port}`);
  emitLiveEvent("server_started", {
    port: appConfig.port,
  });
  void (async () => {
    try {
      const onboarding = await getOnboardingState();
      autonomyState.enabled = onboarding.autonomy.enabled;
    } catch {
      autonomyState.enabled = false;
    }
  })();
  startHeartbeatScheduler();
});

server.on("upgrade", (request, socket) => {
  handleWebSocketUpgrade(request as { url?: string; headers: Record<string, string | string[] | undefined> }, socket as Socket);
});
