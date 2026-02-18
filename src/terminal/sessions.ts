import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

import { resolveWorkspaceCwd } from "../code/workspace.js";
import type { InteractiveTerminalSessionStatus, InteractiveTerminalSessionSummary, TerminalWsEvent } from "../types.js";

const MAX_BUFFER_CHARS = 200_000;
const MAX_EVENT_CHUNK_CHARS = 4000;

interface TerminalInteractiveSession {
  id: string;
  cwd: string;
  createdAt: string;
  status: InteractiveTerminalSessionStatus;
  exitCode?: number;
  cols?: number;
  rows?: number;
  buffer: string;
  child: ChildProcessWithoutNullStreams;
  listeners: Set<(event: TerminalWsEvent) => void>;
}

const sessions = new Map<string, TerminalInteractiveSession>();

const stripAnsi = (value: string): string => {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
};

const appendBuffer = (base: string, chunk: string): string => {
  const next = `${base}${chunk}`;
  if (next.length <= MAX_BUFFER_CHARS) {
    return next;
  }
  return next.slice(next.length - MAX_BUFFER_CHARS);
};

const emit = (session: TerminalInteractiveSession, event: TerminalWsEvent) => {
  for (const listener of session.listeners) {
    try {
      listener(event);
    } catch {
      // ignore listener errors
    }
  }
};

const toSummary = (session: TerminalInteractiveSession): InteractiveTerminalSessionSummary => ({
  id: session.id,
  cwd: session.cwd,
  status: session.status,
  createdAt: session.createdAt,
  exitCode: session.exitCode,
  cols: session.cols,
  rows: session.rows,
});

export const createTerminalSession = (input: {
  projectRoot: string;
  cwd?: string;
  cols?: number;
  rows?: number;
}): { ok: true; session: InteractiveTerminalSessionSummary } | { ok: false; error: string } => {
  const cwd = resolveWorkspaceCwd(input.projectRoot, input.cwd);
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  const child = spawn("/bin/zsh", ["-l"], {
    cwd,
    shell: false,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const session: TerminalInteractiveSession = {
    id,
    cwd,
    createdAt,
    status: "running",
    cols: typeof input.cols === "number" ? input.cols : undefined,
    rows: typeof input.rows === "number" ? input.rows : undefined,
    buffer: "",
    child,
    listeners: new Set(),
  };
  sessions.set(id, session);

  const pushOutput = (stream: "stdout" | "stderr", raw: string) => {
    const text = stripAnsi(raw);
    session.buffer = appendBuffer(session.buffer, text);
    emit(session, {
      type: "terminal_output",
      ts: new Date().toISOString(),
      sessionId: session.id,
      payload: {
        stream,
        chunk: text.slice(-MAX_EVENT_CHUNK_CHARS),
      },
    });
  };

  child.stdout.on("data", (chunk: Buffer | string) => pushOutput("stdout", chunk.toString()));
  child.stderr.on("data", (chunk: Buffer | string) => pushOutput("stderr", chunk.toString()));

  child.on("close", (code) => {
    session.status = "exited";
    session.exitCode = typeof code === "number" ? code : 1;
    emit(session, {
      type: "terminal_exit",
      ts: new Date().toISOString(),
      sessionId: session.id,
      payload: {
        exitCode: session.exitCode,
      },
    });
  });

  child.on("error", (error) => {
    pushOutput("stderr", `\n[spawn_error] ${error.message}\n`);
  });

  return { ok: true, session: toSummary(session) };
};

export const listTerminalSessions = (limit = 25): InteractiveTerminalSessionSummary[] => {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  return Array.from(sessions.values())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, safeLimit)
    .map((session) => toSummary(session));
};

export const getTerminalSession = (id: string): TerminalInteractiveSession | null => {
  const trimmed = String(id || "").trim();
  return sessions.get(trimmed) || null;
};

export const sendTerminalSessionInput = (id: string, data: string): { ok: true } | { ok: false; error: string } => {
  const session = getTerminalSession(id);
  if (!session) {
    return { ok: false, error: "session not found." };
  }
  if (session.status !== "running") {
    return { ok: false, error: "session is not running." };
  }
  try {
    session.child.stdin.write(String(data ?? ""));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

export const resizeTerminalSession = (id: string, cols?: number, rows?: number): { ok: true } | { ok: false; error: string } => {
  const session = getTerminalSession(id);
  if (!session) {
    return { ok: false, error: "session not found." };
  }
  session.cols = typeof cols === "number" ? Math.max(20, Math.min(240, Math.floor(cols))) : session.cols;
  session.rows = typeof rows === "number" ? Math.max(5, Math.min(120, Math.floor(rows))) : session.rows;
  return { ok: true };
};

export const closeTerminalSession = (id: string): { ok: true } | { ok: false; error: string } => {
  const session = getTerminalSession(id);
  if (!session) {
    return { ok: false, error: "session not found." };
  }
  try {
    session.child.kill("SIGTERM");
  } catch {
    // ignore
  }
  session.status = "exited";
  return { ok: true };
};

export const addTerminalSessionListener = (
  id: string,
  listener: (event: TerminalWsEvent) => void,
): { ok: true; unsubscribe: () => void } | { ok: false; error: string } => {
  const session = getTerminalSession(id);
  if (!session) {
    return { ok: false, error: "session not found." };
  }
  session.listeners.add(listener);
  return {
    ok: true,
    unsubscribe: () => {
      session.listeners.delete(listener);
    },
  };
};

