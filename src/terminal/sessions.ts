import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

import { resolveWorkspaceCwd } from "../code/workspace.js";
import type { InteractiveTerminalSessionStatus, InteractiveTerminalSessionSummary, TerminalWsEvent } from "../types.js";

const MAX_BUFFER_CHARS = 200_000;
const MAX_EVENT_CHUNK_CHARS = 4000;
const MAX_CLOSED_SESSION_HISTORY = 120;

type TerminalPtyBackend = "pipe" | "node_pty";

interface TerminalInteractiveSession {
  id: string;
  cwd: string;
  createdAt: string;
  status: InteractiveTerminalSessionStatus;
  backend: TerminalPtyBackend;
  exitCode?: number;
  cols?: number;
  rows?: number;
  buffer: string;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  listeners: Set<(event: TerminalWsEvent) => void>;
}

const sessions = new Map<string, TerminalInteractiveSession>();
const closedSessionHistory: InteractiveTerminalSessionSummary[] = [];

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
  backend: session.backend,
  createdAt: session.createdAt,
  exitCode: session.exitCode,
  cols: session.cols,
  rows: session.rows,
});

const addClosedSessionSummary = (session: TerminalInteractiveSession) => {
  const summary = toSummary(session);
  const existingIndex = closedSessionHistory.findIndex((item) => item.id === summary.id);
  if (existingIndex >= 0) {
    closedSessionHistory.splice(existingIndex, 1);
  }
  closedSessionHistory.unshift(summary);
  if (closedSessionHistory.length > MAX_CLOSED_SESSION_HISTORY) {
    closedSessionHistory.length = MAX_CLOSED_SESSION_HISTORY;
  }
};

const finalizeSession = (session: TerminalInteractiveSession, input?: { exitCode?: number; emitExitEvent?: boolean }) => {
  if (session.status === "exited") {
    return;
  }
  session.status = "exited";
  if (typeof input?.exitCode === "number" && Number.isFinite(input.exitCode)) {
    session.exitCode = input.exitCode;
  }
  if (input?.emitExitEvent ?? true) {
    emit(session, {
      type: "terminal_exit",
      ts: new Date().toISOString(),
      sessionId: session.id,
      payload: {
        exitCode: session.exitCode,
      },
    });
  }
  addClosedSessionSummary(session);
  sessions.delete(session.id);
};

let nodePtyModule: unknown | null | undefined = undefined;

const loadNodePty = async (): Promise<any | null> => {
  if (nodePtyModule !== undefined) {
    return nodePtyModule as any;
  }
  try {
    // @ts-ignore - optional dependency (may be absent in Bun installs)
    const imported: any = await import("node-pty");
    nodePtyModule = imported?.default || imported;
  } catch {
    nodePtyModule = null;
  }
  return nodePtyModule as any;
};

export const createTerminalSession = async (input: {
  projectRoot: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  backend?: TerminalPtyBackend;
}): Promise<{ ok: true; session: InteractiveTerminalSessionSummary } | { ok: false; error: string }> => {
  const cwd = resolveWorkspaceCwd(input.projectRoot, input.cwd);
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  const cols = typeof input.cols === "number" && Number.isFinite(input.cols) ? Math.floor(input.cols) : undefined;
  const rows = typeof input.rows === "number" && Number.isFinite(input.rows) ? Math.floor(input.rows) : undefined;

  const requestedBackend: TerminalPtyBackend = input.backend === "node_pty" ? "node_pty" : "pipe";
  let warning = "";

  const session: TerminalInteractiveSession = {
    id,
    cwd,
    createdAt,
    status: "running",
    backend: "pipe",
    cols,
    rows,
    buffer: "",
    write: () => {},
    resize: () => {},
    kill: () => {},
    listeners: new Set(),
  };
  sessions.set(id, session);

  const pushOutput = (stream: "stdout" | "stderr", raw: string) => {
    const text = String(raw ?? "");
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

  const markExited = (code: unknown) => {
    const exitCode = typeof code === "number" && Number.isFinite(code) ? code : 1;
    finalizeSession(session, { exitCode, emitExitEvent: true });
  };

  const initPipeBackend = (): ChildProcessWithoutNullStreams => {
    const child = spawn("/bin/zsh", ["-l"], {
      cwd,
      shell: false,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    session.backend = "pipe";
    session.write = (data) => {
      child.stdin.write(String(data ?? ""));
    };
    session.resize = () => {
      // best-effort only for pipe backend
    };
    session.kill = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) => pushOutput("stdout", chunk.toString()));
    child.stderr.on("data", (chunk: Buffer | string) => pushOutput("stderr", chunk.toString()));
    child.on("close", (code) => markExited(code));
    child.on("error", (error) => pushOutput("stderr", `\n[spawn_error] ${error.message}\n`));
    return child;
  };

  if (requestedBackend === "node_pty") {
    const nodePty = await loadNodePty();
    if (!nodePty) {
      warning = "[pty_backend] node-pty not available; falling back to pipe backend.\n";
    } else {
      try {
        const safeCols = typeof cols === "number" ? Math.max(20, Math.min(240, cols)) : 120;
        const safeRows = typeof rows === "number" ? Math.max(5, Math.min(120, rows)) : 30;
        const env = {
          ...process.env,
          TERM: process.env.TERM || "xterm-256color",
        };

        const ptyProcess: any = nodePty.spawn("/bin/zsh", ["-l"], {
          name: "xterm-256color",
          cols: safeCols,
          rows: safeRows,
          cwd,
          env,
        });

        session.backend = "node_pty";
        session.cols = safeCols;
        session.rows = safeRows;
        session.write = (data) => {
          ptyProcess.write(String(data ?? ""));
        };
        session.resize = (nextCols, nextRows) => {
          try {
            ptyProcess.resize(nextCols, nextRows);
          } catch {
            // ignore
          }
        };
        session.kill = () => {
          try {
            ptyProcess.kill();
          } catch {
            // ignore
          }
        };

        if (typeof ptyProcess.onData === "function") {
          ptyProcess.onData((data: string) => pushOutput("stdout", data));
        } else if (typeof ptyProcess.on === "function") {
          ptyProcess.on("data", (data: string) => pushOutput("stdout", data));
        }

        if (typeof ptyProcess.onExit === "function") {
          ptyProcess.onExit((event: { exitCode?: number }) => markExited(event?.exitCode));
        } else if (typeof ptyProcess.on === "function") {
          ptyProcess.on("exit", (code: number) => markExited(code));
        }
      } catch (error) {
        warning = `[pty_backend] node-pty failed to start; falling back to pipe backend: ${
          error instanceof Error ? error.message : String(error)
        }\n`;
      }
    }
  }

  if (session.backend === "pipe") {
    initPipeBackend();
  }

  if (warning) {
    pushOutput("stderr", warning);
  }

  return { ok: true, session: toSummary(session) };
};

export const listTerminalSessions = (limit = 25): InteractiveTerminalSessionSummary[] => {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const active = Array.from(sessions.values())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, safeLimit)
    .map((session) => toSummary(session));
  if (active.length >= safeLimit) {
    return active;
  }
  return [...active, ...closedSessionHistory.slice(0, safeLimit - active.length)];
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
    session.write(String(data ?? ""));
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
  const nextCols = typeof cols === "number" ? Math.max(20, Math.min(240, Math.floor(cols))) : session.cols;
  const nextRows = typeof rows === "number" ? Math.max(5, Math.min(120, Math.floor(rows))) : session.rows;
  session.cols = nextCols;
  session.rows = nextRows;
  if (session.status === "running" && typeof nextCols === "number" && typeof nextRows === "number") {
    session.resize(nextCols, nextRows);
  }
  return { ok: true };
};

export const closeTerminalSession = (id: string): { ok: true } | { ok: false; error: string } => {
  const session = getTerminalSession(id);
  if (!session) {
    return { ok: false, error: "session not found." };
  }
  try {
    session.kill();
  } catch {
    // ignore
  }
  finalizeSession(session, { emitExitEvent: true });
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
