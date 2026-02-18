import type { ApprovalCategory, SkillDefinition, SkillId } from "../types.js";

export type SkillExecutionMode = "manual" | "scheduled" | "autonomy";

export interface SkillExecutionInput {
  skillId: SkillId;
  args?: Record<string, unknown>;
  mode?: SkillExecutionMode;
  approvalBypass?: boolean;
}

export interface SkillExecutionResult {
  ok: boolean;
  skillId: SkillId;
  message: string;
  payload?: Record<string, unknown>;
  code?: "skill_disabled" | "approval_required" | "app_not_allowed" | "invalid_args" | "execution_error";
  approvalId?: string;
  approvalCategory?: ApprovalCategory;
}

export interface RuntimeSkillContext {
  getSkillDefinition: (id: SkillId) => SkillDefinition | undefined;
  isSkillEnabled: (id: SkillId) => boolean;
  requiresApproval: (category: ApprovalCategory) => boolean;
  queueSkillApproval: (input: {
    skillId: SkillId;
    approvalCategory: ApprovalCategory;
    args: Record<string, unknown>;
    reason: string;
  }) => { id: string };
  openMacApp: (appId: "antigravity" | "terminal" | "chrome", options?: { url?: string }) => Promise<{ ok: boolean; message: string }>;
  runTerminalCommand: (command: string, cwd?: string, options?: { allowApprovalBypass?: boolean }) => Promise<{
    ok: boolean;
    message: string;
    payload?: Record<string, unknown>;
    code?: "approval_required" | "execution_error" | "invalid_command" | "extension_disabled";
    approvalId?: string;
  }>;
  runCodexTask: (prompt: string, options?: { tool?: "codex" | "claude" }) => Promise<{
    ok: boolean;
    message: string;
    payload?: Record<string, unknown>;
    code?: "approval_required" | "execution_error" | "invalid_command" | "extension_disabled";
    approvalId?: string;
  }>;
  runXEndpoint: (endpoint: string, args?: Record<string, unknown>) => Promise<{
    ok: boolean;
    message: string;
    payload?: Record<string, unknown>;
    code?: "approval_required" | "extension_disabled" | "execution_error";
    approvalId?: string;
  }>;
}
