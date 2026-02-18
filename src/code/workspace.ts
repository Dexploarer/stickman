import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

export type WorkspaceSessionStatus = "running" | "succeeded" | "failed";

export interface WorkspaceSession {
  id: string;
  command: string;
  cwd: string;
  status: WorkspaceSessionStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  readOnly: boolean;
}

export interface WorkspaceRunResult {
  ok: boolean;
  session: WorkspaceSession;
}

export interface WorkspaceRunEvent {
  type: "start" | "stdout" | "stderr" | "exit";
  sessionId: string;
  payload: Record<string, unknown>;
}

export interface CommandSafety {
  ok: boolean;
  readOnly: boolean;
  reason?: string;
  normalizedCommand: string;
}

const MAX_OUTPUT_CHARS = 120_000;
const MAX_SESSION_HISTORY = 120;
const sessions = new Map<string, WorkspaceSession>();
const sessionOrder: string[] = [];

const readOnlyPrefixes = [
  "ls",
  "pwd",
  "cat ",
  "head ",
  "tail ",
  "sed ",
  "awk ",
  "rg ",
  "grep ",
  "find ",
  "wc ",
  "stat ",
  "du ",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git rev-parse",
  "bun test",
  "bunx tsc --noemit",
  "node -v",
  "npm -v",
  "pnpm -v",
  "bun -v",
  "python --version",
  "python3 --version",
  "swift --version",
];

const blockedPatterns = [
  "rm -rf /",
  "mkfs",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  ":(){:|:&};:",
];

const writeHints = [
  " rm ",
  "mv ",
  " mv ",
  "cp ",
  " cp ",
  "touch ",
  " touch ",
  "mkdir ",
  " mkdir ",
  "rmdir ",
  " rmdir ",
  "chmod ",
  " chown ",
  " chgrp ",
  " git add",
  " git commit",
  " git push",
  " npm install",
  " pnpm add",
  " pnpm install",
  " bun add",
  " bun install",
  " cargo add",
  " cargo build",
  " cargo run",
  "apply_patch",
  " sed -i",
  " perl -i",
  " >",
  " >>",
  " tee ",
];

const sanitizeChunk = (value: string): string => {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
};

const appendChunk = (base: string, chunk: string): string => {
  const next = `${base}${chunk}`;
  if (next.length <= MAX_OUTPUT_CHARS) {
    return next;
  }
  return next.slice(next.length - MAX_OUTPUT_CHARS);
};

const retainSession = (session: WorkspaceSession) => {
  sessions.set(session.id, session);
  sessionOrder.push(session.id);
  if (sessionOrder.length <= MAX_SESSION_HISTORY) {
    return;
  }
  const overflow = sessionOrder.splice(0, sessionOrder.length - MAX_SESSION_HISTORY);
  for (const id of overflow) {
    sessions.delete(id);
  }
};

export const listWorkspaceSessions = (limit = 40): WorkspaceSession[] => {
  const safeLimit = Math.max(1, Math.min(limit, 120));
  return sessionOrder
    .slice(-safeLimit)
    .reverse()
    .map((id) => sessions.get(id))
    .filter((item): item is WorkspaceSession => Boolean(item));
};

export const getWorkspaceSession = (sessionId: string): WorkspaceSession | null => {
  return sessions.get(sessionId) || null;
};

export const resolveWorkspaceCwd = (projectRoot: string, requestedCwd?: string): string => {
  const candidate = requestedCwd?.trim() ? requestedCwd.trim() : projectRoot;
  const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(projectRoot, candidate);
  const rootWithSep = projectRoot.endsWith(path.sep) ? projectRoot : `${projectRoot}${path.sep}`;
  if (resolved !== projectRoot && !resolved.startsWith(rootWithSep)) {
    throw new Error("cwd must stay inside project workspace");
  }
  return resolved;
};

export const assessWorkspaceCommand = (command: string): CommandSafety => {
  const normalizedCommand = command.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalizedCommand) {
    return {
      ok: false,
      readOnly: false,
      reason: "command is required",
      normalizedCommand,
    };
  }
  if (blockedPatterns.some((pattern) => normalizedCommand.includes(pattern))) {
    return {
      ok: false,
      readOnly: false,
      reason: "command contains blocked system-level operation",
      normalizedCommand,
    };
  }
  const readOnlyPrefix = readOnlyPrefixes.some((prefix) => normalizedCommand.startsWith(prefix));
  const hasWriteHint = writeHints.some((hint) => normalizedCommand.includes(hint));
  return {
    ok: true,
    readOnly: readOnlyPrefix && !hasWriteHint,
    normalizedCommand,
  };
};

export const runWorkspaceCommand = async (input: {
  projectRoot: string;
  command: string;
  cwd?: string;
  readOnly: boolean;
  timeoutMs?: number;
  onEvent?: (event: WorkspaceRunEvent) => void;
}): Promise<WorkspaceRunResult> => {
  const command = input.command.trim();
  const cwd = resolveWorkspaceCwd(input.projectRoot, input.cwd);
  const timeoutMs = Math.max(5_000, Math.min(input.timeoutMs ?? 180_000, 600_000));
  const id = randomUUID();
  const startedAtEpoch = Date.now();
  const session: WorkspaceSession = {
    id,
    command,
    cwd,
    status: "running",
    startedAt: new Date(startedAtEpoch).toISOString(),
    finishedAt: null,
    durationMs: null,
    exitCode: null,
    stdout: "",
    stderr: "",
    readOnly: input.readOnly,
  };
  retainSession(session);
  input.onEvent?.({
    type: "start",
    sessionId: id,
    payload: {
      command,
      cwd,
      readOnly: input.readOnly,
      timeoutMs,
    },
  });

  const child = spawn(command, {
    cwd,
    shell: true,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk: Buffer | string) => {
    const text = sanitizeChunk(chunk.toString());
    session.stdout = appendChunk(session.stdout, text);
    input.onEvent?.({
      type: "stdout",
      sessionId: id,
      payload: {
        chunk: text.slice(-1200),
      },
    });
  });

  child.stderr.on("data", (chunk: Buffer | string) => {
    const text = sanitizeChunk(chunk.toString());
    session.stderr = appendChunk(session.stderr, text);
    input.onEvent?.({
      type: "stderr",
      sessionId: id,
      payload: {
        chunk: text.slice(-1200),
      },
    });
  });

  const timeout = setTimeout(() => {
    try {
      child.kill("SIGTERM");
    } catch {
      // no-op
    }
  }, timeoutMs);

  const exitCode = await new Promise<number>((resolve) => {
    child.on("error", (error) => {
      session.stderr = appendChunk(session.stderr, `\n[spawn_error] ${error.message}\n`);
    });
    child.on("close", (code) => {
      resolve(typeof code === "number" ? code : 1);
    });
  });
  clearTimeout(timeout);

  session.exitCode = exitCode;
  session.finishedAt = new Date().toISOString();
  session.durationMs = Date.now() - startedAtEpoch;
  session.status = exitCode === 0 ? "succeeded" : "failed";
  input.onEvent?.({
    type: "exit",
    sessionId: id,
    payload: {
      exitCode: session.exitCode,
      status: session.status,
      durationMs: session.durationMs,
    },
  });

  return {
    ok: session.status === "succeeded",
    session,
  };
};
