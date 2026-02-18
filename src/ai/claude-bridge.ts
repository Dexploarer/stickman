import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { appConfig } from "../config.js";
import { getOnboardingState } from "../onboarding.js";

const execFileAsync = promisify(execFile);

const defaultSessionCandidates = (): string[] => {
  const home = os.homedir();
  return [
    path.join(home, ".claude", "auth.json"),
    path.join(home, ".claude", "credentials.json"),
    path.join(home, ".claude", "config.json"),
    path.join(home, ".config", "claude", "auth.json"),
    path.join(home, ".config", "claude", "credentials.json"),
  ];
};

const parseCommand = (command: string): { bin: string; args: string[] } => {
  const parts = command
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) {
    return { bin: "claude", args: ["-p"] };
  }
  const [bin, ...args] = parts;
  return { bin, args: args.length ? args : ["-p"] };
};

const resolveSessionCandidates = async (): Promise<string[]> => {
  const onboarding = await getOnboardingState();
  const configured = [
    onboarding.providers.claude.sessionPath,
    appConfig.claude.sessionPath,
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  return Array.from(new Set([...configured, ...defaultSessionCandidates()]));
};

const hasReadableFile = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    const raw = await readFile(filePath, "utf-8");
    return raw.trim().length > 0;
  } catch {
    return false;
  }
};

export const detectClaudeSession = async (): Promise<{
  detected: boolean;
  path: string | null;
}> => {
  const candidates = await resolveSessionCandidates();
  for (const candidate of candidates) {
    if (await hasReadableFile(candidate)) {
      return { detected: true, path: candidate };
    }
  }
  return { detected: false, path: null };
};

export const startClaudeCliLogin = async (): Promise<{
  ok: boolean;
  command: string;
  instructions: string[];
}> => {
  return {
    ok: true,
    command: "claude login",
    instructions: [
      "Run the command in a local shell where Claude Code CLI is installed.",
      "Complete the browser-based subscription login flow.",
      "Return to this app and click 'Check Claude Session'.",
    ],
  };
};

export const runClaudeText = async (input: {
  prompt: string;
  system?: string;
}): Promise<{ text: string; provider: "claude_subscription"; command: string }> => {
  const prompt = String(input.prompt || "").trim();
  if (!prompt) {
    throw new Error("prompt is required");
  }

  const { detected } = await detectClaudeSession();
  if (!detected) {
    throw new Error("Claude subscription session not detected. Run `claude login` first.");
  }

  const command = appConfig.claude.cliCommand || "claude -p";
  const parsed = parseCommand(command);
  const composite = input.system?.trim()
    ? `System instructions:\n${input.system.trim()}\n\nUser prompt:\n${prompt}`
    : prompt;

  try {
    const { stdout, stderr } = await execFileAsync(parsed.bin, [...parsed.args, composite], {
      timeout: 120_000,
      maxBuffer: 12 * 1024 * 1024,
      env: process.env,
    });
    const text = String(stdout || "").trim();
    if (!text) {
      const stderrText = String(stderr || "").trim();
      throw new Error(stderrText || "Claude CLI returned empty output.");
    }
    return {
      text,
      provider: "claude_subscription",
      command,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Claude CLI bridge failed (${command}): ${message}`);
  }
};
