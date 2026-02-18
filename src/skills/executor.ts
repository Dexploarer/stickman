import type { SkillId } from "../types.js";
import { runGit, tailText } from "../git/runner.js";
import { getGitStatus } from "../git/status.js";
import { normalizeCommitMessage, validateBranchName } from "../git/validate.js";
import { listWorkspaceTree, readWorkspaceTextFile, writeWorkspaceTextFile } from "../workspace/files.js";
import { openEmbeddedBrowserTab } from "./browser-actions.js";
import type { RuntimeSkillContext, SkillExecutionInput, SkillExecutionResult } from "./types.js";

const getString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const toInt = (value: unknown, fallback: number, options: { min: number; max: number }): number => {
  const raw = typeof value === "number" ? value : Number(getString(value));
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(options.min, Math.min(options.max, Math.floor(raw)));
};

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

  const mode = input.mode || "manual";
  if (Array.isArray(skill.allowedModes) && !skill.allowedModes.includes(mode)) {
    return {
      ok: false,
      skillId: skill.id,
      message: `Skill not allowed in mode: ${mode}`,
      code: "invalid_args",
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
    case "workspace.tree": {
      const relDir = getString(args.path);
      const result = await listWorkspaceTree({ workspaceRoot: context.workspaceRoot, relDir });
      if (!result.ok) {
        return {
          ok: false,
          skillId: skill.id,
          message: result.error,
          code: result.code === "invalid_path" || result.code === "blocked_path" ? "invalid_args" : "execution_error",
        };
      }
      return {
        ok: true,
        skillId: skill.id,
        message: "ok",
        payload: {
          tree: result,
        },
      };
    }
    case "workspace.read_file": {
      const relPath = getString(args.path);
      if (!relPath) {
        return { ok: false, skillId: skill.id, message: "path is required", code: "invalid_args" };
      }
      const result = await readWorkspaceTextFile({ workspaceRoot: context.workspaceRoot, relPath });
      if (!result.ok) {
        return {
          ok: false,
          skillId: skill.id,
          message: result.error,
          code: result.code === "invalid_path" || result.code === "blocked_path" ? "invalid_args" : "execution_error",
        };
      }
      return {
        ok: true,
        skillId: skill.id,
        message: "ok",
        payload: {
          file: result,
        },
      };
    }
    case "workspace.write_file": {
      const relPath = getString(args.path);
      if (!relPath) {
        return { ok: false, skillId: skill.id, message: "path is required", code: "invalid_args" };
      }
      if (typeof args.content !== "string") {
        return { ok: false, skillId: skill.id, message: "content must be a string", code: "invalid_args" };
      }
      let baseSha256 = getString(args.baseSha256);
      if (!baseSha256) {
        const current = await readWorkspaceTextFile({ workspaceRoot: context.workspaceRoot, relPath });
        baseSha256 = current.ok ? current.sha256 : "";
      }
      const result = await writeWorkspaceTextFile({
        workspaceRoot: context.workspaceRoot,
        relPath,
        content: args.content,
        baseSha256,
      });
      if (!result.ok) {
        return {
          ok: false,
          skillId: skill.id,
          message: result.error,
          code: result.code === "invalid_path" || result.code === "blocked_path" ? "invalid_args" : "execution_error",
          payload: result.currentSha256 ? { currentSha256: result.currentSha256 } : undefined,
        };
      }
      return {
        ok: true,
        skillId: skill.id,
        message: "ok",
        payload: {
          file: result,
        },
      };
    }
    case "git.status": {
      const status = getGitStatus(context.workspaceRoot);
      if (!status.ok) {
        return {
          ok: false,
          skillId: skill.id,
          message: "git status failed",
          code: "execution_error",
          payload: {
            status,
          },
        };
      }
      return {
        ok: true,
        skillId: skill.id,
        message: "ok",
        payload: {
          status,
        },
      };
    }
    case "git.log": {
      const limit = toInt(args.limit, 50, { min: 1, max: 100 });
      const result = runGit(["log", "--oneline", "-n", String(limit)], { cwd: context.workspaceRoot });
      if (!result.ok) {
        return {
          ok: false,
          skillId: skill.id,
          message: "git log failed",
          code: "execution_error",
          payload: {
            stderr: tailText(result.stderr || result.stdout || "", 3000),
          },
        };
      }
      const commits = String(result.stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const firstSpace = line.indexOf(" ");
          if (firstSpace === -1) {
            return { sha: line, subject: "" };
          }
          return { sha: line.slice(0, firstSpace), subject: line.slice(firstSpace + 1) };
        });
      return {
        ok: true,
        skillId: skill.id,
        message: "ok",
        payload: {
          commits,
        },
      };
    }
    case "git.diff": {
      const stagedRaw = args.staged;
      const staged =
        stagedRaw === true ||
        stagedRaw === 1 ||
        (typeof stagedRaw === "string" && ["1", "true", "yes", "on"].includes(stagedRaw.trim().toLowerCase()));
      const relPath = getString(args.path);
      const cmdArgs = ["diff"];
      if (staged) {
        cmdArgs.push("--cached");
      }
      if (relPath) {
        cmdArgs.push("--", relPath);
      }
      const result = runGit(cmdArgs, { cwd: context.workspaceRoot, timeoutMs: 25_000 });
      if (!result.ok && !result.stdout) {
        return {
          ok: false,
          skillId: skill.id,
          message: "git diff failed",
          code: "execution_error",
          payload: {
            stderr: tailText(result.stderr || "", 3000),
          },
        };
      }
      const diff = tailText(result.stdout || result.stderr || "", 200_000);
      return {
        ok: true,
        skillId: skill.id,
        message: "ok",
        payload: {
          diff,
        },
      };
    }
    case "git.create_branch": {
      const nameRaw = getString(args.name);
      const checkoutRaw = args.checkout;
      const checkout =
        checkoutRaw === undefined ||
        checkoutRaw === null ||
        checkoutRaw === true ||
        checkoutRaw === 1 ||
        (typeof checkoutRaw === "string" && ["1", "true", "yes", "on"].includes(checkoutRaw.trim().toLowerCase()));
      const validated = validateBranchName(nameRaw);
      if (!validated.ok) {
        return { ok: false, skillId: skill.id, message: validated.error, code: "invalid_args" };
      }
      const trace: Array<{ cmd: string; status: number; stdoutTail: string; stderrTail: string }> = [];
      const argsToRun = checkout ? ["checkout", "-b", validated.name] : ["branch", validated.name];
      const result = runGit(argsToRun, { cwd: context.workspaceRoot, timeoutMs: 25_000 });
      trace.push({
        cmd: `git ${argsToRun.join(" ")}`,
        status: result.status,
        stdoutTail: tailText(result.stdout, 2000),
        stderrTail: tailText(result.stderr, 2000),
      });
      if (!result.ok) {
        return { ok: false, skillId: skill.id, message: "git branch failed", code: "execution_error", payload: { trace } };
      }
      return { ok: true, skillId: skill.id, message: "ok", payload: { trace } };
    }
    case "git.commit": {
      const messageRaw = getString(args.message);
      const validated = normalizeCommitMessage(messageRaw);
      if (!validated.ok) {
        return { ok: false, skillId: skill.id, message: validated.error, code: "invalid_args" };
      }
      const addAllRaw = args.addAll;
      const addAll =
        addAllRaw === true ||
        addAllRaw === 1 ||
        (typeof addAllRaw === "string" && ["1", "true", "yes", "on"].includes(addAllRaw.trim().toLowerCase()));
      const trace: Array<{ cmd: string; status: number; stdoutTail: string; stderrTail: string }> = [];
      if (addAll) {
        const addResult = runGit(["add", "-A"], { cwd: context.workspaceRoot, timeoutMs: 25_000 });
        trace.push({
          cmd: "git add -A",
          status: addResult.status,
          stdoutTail: tailText(addResult.stdout, 2000),
          stderrTail: tailText(addResult.stderr, 2000),
        });
        if (!addResult.ok) {
          return { ok: false, skillId: skill.id, message: "git add failed", code: "execution_error", payload: { trace } };
        }
      }
      const commitResult = runGit(["commit", "-m", validated.message], { cwd: context.workspaceRoot, timeoutMs: 25_000 });
      trace.push({
        cmd: `git commit -m ${JSON.stringify(validated.message)}`,
        status: commitResult.status,
        stdoutTail: tailText(commitResult.stdout, 4000),
        stderrTail: tailText(commitResult.stderr, 4000),
      });
      if (!commitResult.ok) {
        return { ok: false, skillId: skill.id, message: "git commit failed", code: "execution_error", payload: { trace } };
      }
      return { ok: true, skillId: skill.id, message: "ok", payload: { trace } };
    }
    case "git.push": {
      const setUpstreamRaw = args.setUpstream;
      const setUpstream =
        setUpstreamRaw === undefined ||
        setUpstreamRaw === null ||
        setUpstreamRaw === true ||
        setUpstreamRaw === 1 ||
        (typeof setUpstreamRaw === "string" && ["1", "true", "yes", "on"].includes(setUpstreamRaw.trim().toLowerCase()));
      const status = getGitStatus(context.workspaceRoot);
      const branch = String(status.branch || "").trim();
      if (!branch || branch === "(detached)") {
        return { ok: false, skillId: skill.id, message: "Cannot push: no active branch detected.", code: "execution_error" };
      }
      const argsToRun = ["push", ...(setUpstream ? ["-u"] : []), "origin", branch];
      const pushResult = runGit(argsToRun, { cwd: context.workspaceRoot, timeoutMs: 60_000 });
      const trace: Array<{ cmd: string; status: number; stdoutTail: string; stderrTail: string }> = [
        {
          cmd: `git ${argsToRun.join(" ")}`,
          status: pushResult.status,
          stdoutTail: tailText(pushResult.stdout, 4000),
          stderrTail: tailText(pushResult.stderr, 4000),
        },
      ];
      if (!pushResult.ok) {
        return { ok: false, skillId: skill.id, message: "git push failed", code: "execution_error", payload: { trace } };
      }
      return { ok: true, skillId: skill.id, message: "ok", payload: { trace } };
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
