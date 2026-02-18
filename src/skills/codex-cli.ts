import { spawn } from "node:child_process";

const MAX_OUTPUT = 120_000;

const clip = (value: string): string => {
  if (value.length <= MAX_OUTPUT) {
    return value;
  }
  return value.slice(value.length - MAX_OUTPUT);
};

const runShellCommand = async (cmd: string, cwd: string): Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}> => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await new Promise<number>((resolve) => {
    const child = spawn(cmd, {
      cwd,
      shell: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout.push(chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr.push(chunk.toString());
    });
    child.on("close", (exitCode) => {
      resolve(typeof exitCode === "number" ? exitCode : 1);
    });
    child.on("error", (error) => {
      stderr.push(error.message);
    });
  });
  return {
    ok: code === 0,
    stdout: clip(stdout.join("")),
    stderr: clip(stderr.join("")),
    exitCode: code,
  };
};

const shellEscape = (value: string): string => {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
};

export const runCodexCliTask = async (prompt: string, cwd: string) => {
  const codexCmd = (process.env.POD_CODEX_CLI_PATH || process.env.CODEX_CLI_COMMAND || "codex").trim();
  const command = `${codexCmd} ${shellEscape(prompt)}`;
  const result = await runShellCommand(command, cwd);
  return {
    ok: result.ok,
    message: result.ok ? "Codex task completed." : "Codex task failed.",
    payload: {
      command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      tool: "codex",
    },
  };
};

export const runClaudeCliTask = async (prompt: string, cwd: string) => {
  const claudeCmd = (process.env.CLAUDE_CLI_COMMAND || "claude -p").trim();
  const command = `${claudeCmd} ${shellEscape(prompt)}`;
  const result = await runShellCommand(command, cwd);
  return {
    ok: result.ok,
    message: result.ok ? "Claude task completed." : "Claude task failed.",
    payload: {
      command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      tool: "claude",
    },
  };
};
