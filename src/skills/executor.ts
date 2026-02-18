import type { SkillId } from "../types.js";
import { openEmbeddedBrowserTab } from "./browser-actions.js";
import type { RuntimeSkillContext, SkillExecutionInput, SkillExecutionResult } from "./types.js";

const getString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const toResult = (skillId: SkillId, input: { ok: boolean; message: string; payload?: Record<string, unknown> }): SkillExecutionResult => {
  return {
    ok: input.ok,
    skillId,
    message: input.message,
    payload: input.payload,
    ...(input.ok ? {} : { code: "execution_error" as const }),
  };
};

export const executeSkill = async (
  input: SkillExecutionInput,
  context: RuntimeSkillContext & { workspaceRoot: string },
): Promise<SkillExecutionResult> => {
  const skill = context.getSkillDefinition(input.skillId);
  if (!skill) {
    return {
      ok: false,
      skillId: input.skillId,
      message: "Unknown skill.",
      code: "invalid_args",
    };
  }

  if (!context.isSkillEnabled(skill.id)) {
    return {
      ok: false,
      skillId: skill.id,
      message: "Skill is disabled.",
      code: "skill_disabled",
    };
  }

  if (!input.approvalBypass && skill.requiresApproval && context.requiresApproval(skill.approvalCategory)) {
    const approval = context.queueSkillApproval({
      skillId: skill.id,
      approvalCategory: skill.approvalCategory,
      args: input.args || {},
      reason: `skill_requires_approval:${skill.id}`,
    });
    return {
      ok: false,
      skillId: skill.id,
      message: "Manual approval required before executing this skill.",
      code: "approval_required",
      approvalId: approval.id,
      approvalCategory: skill.approvalCategory,
    };
  }

  const args = input.args || {};

  switch (skill.id) {
    case "antigravity.open":
      return toResult(skill.id, await context.openMacApp("antigravity"));
    case "antigravity.open_mission_url":
      return toResult(skill.id, await context.openMacApp("antigravity", { url: getString(args.missionUrl) || undefined }));
    case "terminal.open":
      return toResult(skill.id, await context.openMacApp("terminal"));
    case "terminal.run_command": {
      const command = getString(args.command);
      const cwd = getString(args.cwd) || undefined;
      if (!command) {
        return {
          ok: false,
          skillId: skill.id,
          message: "command is required",
          code: "invalid_args",
        };
      }
      const result = await context.runTerminalCommand(command, cwd, { allowApprovalBypass: input.approvalBypass });
      return {
        ok: result.ok,
        skillId: skill.id,
        message: result.message,
        payload: result.payload,
        code: result.code === "approval_required" ? "approval_required" : result.ok ? undefined : "execution_error",
        approvalId: result.approvalId,
      };
    }
    case "codex.run_task": {
      const prompt = getString(args.prompt || args.task);
      if (!prompt) {
        return { ok: false, skillId: skill.id, message: "prompt is required", code: "invalid_args" };
      }
      const result = await context.runCodexTask(prompt, { tool: "codex" });
      return {
        ok: result.ok,
        skillId: skill.id,
        message: result.message,
        payload: result.payload,
        code: result.code === "approval_required" ? "approval_required" : result.ok ? undefined : "execution_error",
        approvalId: result.approvalId,
      };
    }
    case "claude.run_task": {
      const prompt = getString(args.prompt || args.task);
      if (!prompt) {
        return { ok: false, skillId: skill.id, message: "prompt is required", code: "invalid_args" };
      }
      const result = await context.runCodexTask(prompt, { tool: "claude" });
      return {
        ok: result.ok,
        skillId: skill.id,
        message: result.message,
        payload: result.payload,
        code: result.code === "approval_required" ? "approval_required" : result.ok ? undefined : "execution_error",
        approvalId: result.approvalId,
      };
    }
    case "browser.embedded.open_tab": {
      const url = getString(args.url);
      return toResult(skill.id, await openEmbeddedBrowserTab(url));
    }
    case "browser.external.chrome.open": {
      const url = getString(args.url);
      const result = await context.openMacApp("chrome", { url: url || undefined });
      if (!result.ok) {
        return {
          ok: false,
          skillId: skill.id,
          message: result.message,
          code: "execution_error",
        };
      }
      return toResult(skill.id, {
        ok: true,
        message: result.message,
        payload: {
          url,
        },
      });
    }
    case "x-social.run_endpoint": {
      const endpoint = getString(args.endpoint);
      if (!endpoint) {
        return {
          ok: false,
          skillId: skill.id,
          message: "endpoint is required",
          code: "invalid_args",
        };
      }
      const result = await context.runXEndpoint(endpoint, (args.endpointArgs as Record<string, unknown> | undefined) || {});
      return {
        ok: result.ok,
        skillId: skill.id,
        message: result.message,
        payload: result.payload,
        code: result.code === "approval_required" ? "approval_required" : result.ok ? undefined : "execution_error",
        approvalId: result.approvalId,
      };
    }
    case "code-workspace.exec": {
      const command = getString(args.command);
      const cwd = getString(args.cwd) || undefined;
      if (!command) {
        return {
          ok: false,
          skillId: skill.id,
          message: "command is required",
          code: "invalid_args",
        };
      }
      const result = await context.runTerminalCommand(command, cwd, { allowApprovalBypass: input.approvalBypass });
      return {
        ok: result.ok,
        skillId: skill.id,
        message: result.message,
        payload: result.payload,
        code: result.code === "approval_required" ? "approval_required" : result.ok ? undefined : "execution_error",
        approvalId: result.approvalId,
      };
    }
    default:
      return {
        ok: false,
        skillId: skill.id,
        message: "Unsupported skill",
        code: "invalid_args",
      };
  }
};
