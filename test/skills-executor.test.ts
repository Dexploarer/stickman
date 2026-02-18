import { describe, expect, it } from "bun:test";

import { getSkillDefinition } from "../src/skills/catalog.ts";
import { executeSkill } from "../src/skills/executor.ts";
import type { RuntimeSkillContext } from "../src/skills/types.ts";
import type { SkillId } from "../src/types.ts";

const createContext = (
  overrides: Partial<RuntimeSkillContext> = {},
): RuntimeSkillContext & { workspaceRoot: string } => {
  return {
    workspaceRoot: "/tmp",
    getSkillDefinition,
    isSkillEnabled: () => true,
    requiresApproval: () => false,
    queueSkillApproval: () => ({ id: "approval-1" }),
    openMacApp: async () => ({ ok: true, message: "opened" }),
    runTerminalCommand: async () => ({ ok: true, message: "ok", payload: {} }),
    runCodexTask: async () => ({ ok: true, message: "ok", payload: {} }),
    runXEndpoint: async () => ({ ok: true, message: "ok", payload: {} }),
    ...overrides,
  };
};

describe("skills/executor", () => {
  it("rejects disabled skills", async () => {
    const result = await executeSkill(
      { skillId: "terminal.open" },
      createContext({
        isSkillEnabled: () => false,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("skill_disabled");
  });

  it("creates approval requests for guarded skills", async () => {
    const result = await executeSkill(
      { skillId: "terminal.run_command", args: { command: "pwd" } },
      createContext({
        requiresApproval: (category) => category === "terminal_exec",
        queueSkillApproval: ({ skillId }) => ({ id: `approval-${skillId}` }),
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("approval_required");
    expect(result.approvalId).toBe("approval-terminal.run_command");
  });

  it("validates required args for terminal.run_command", async () => {
    const result = await executeSkill(
      { skillId: "terminal.run_command", args: {} },
      createContext(),
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_args");
    expect(result.message).toContain("command");
  });

  it("rejects manual-only workbench skills outside manual mode", async () => {
    const result = await executeSkill(
      { skillId: "git.push", mode: "autonomy", args: {} },
      createContext(),
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_args");
    expect(result.message).toContain("mode");
  });

  it("validates required args for workspace.read_file", async () => {
    const result = await executeSkill(
      { skillId: "workspace.read_file", args: {} },
      createContext(),
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_args");
    expect(result.message).toContain("path");
  });

  it("maps codex execution failures to execution_error", async () => {
    const result = await executeSkill(
      { skillId: "codex.run_task", args: { prompt: "refactor this" } },
      createContext({
        runCodexTask: async () => ({
          ok: false,
          message: "code extension disabled",
          code: "extension_disabled",
        }),
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("execution_error");
  });

  it("preserves codex approval_required responses", async () => {
    const result = await executeSkill(
      { skillId: "codex.run_task", args: { prompt: "run migration" } },
      createContext({
        runCodexTask: async () => ({
          ok: false,
          message: "approval required",
          code: "approval_required",
          approvalId: "approval-9",
        }),
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("approval_required");
    expect(result.approvalId).toBe("approval-9");
  });

  it("returns invalid_args for missing x endpoint", async () => {
    const result = await executeSkill(
      { skillId: "x-social.run_endpoint", args: {} },
      createContext(),
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_args");
  });

  it("handles unknown skill ids defensively", async () => {
    const result = await executeSkill(
      { skillId: "unknown.skill" as SkillId },
      createContext(),
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_args");
    expect(result.message).toContain("Unknown skill");
  });
});
