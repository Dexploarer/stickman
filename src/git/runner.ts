import { spawnSync } from "node:child_process";

export interface GitRunResult {
  ok: boolean;
  status: number;
  stdout: string;
  stderr: string;
}

export const tailText = (value: string, maxChars: number): string => {
  const text = String(value || "");
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(text.length - maxChars);
};

export const runGit = (args: string[], options?: { cwd?: string; timeoutMs?: number }): GitRunResult => {
  const result = spawnSync("git", args, {
    cwd: options?.cwd,
    shell: false,
    encoding: "utf-8",
    timeout: Math.max(500, Math.min(options?.timeoutMs ?? 25_000, 120_000)),
    maxBuffer: 6_000_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  return {
    ok: result.status === 0,
    status: typeof result.status === "number" ? result.status : 1,
    stdout,
    stderr,
  };
};

