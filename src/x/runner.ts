import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { JsonValue, XArgMap, XArgValue, XRunResult } from "../types.js";

const execFileAsync = promisify(execFile);

const toFlagName = (key: string): string => {
  if (key.includes("-")) {
    return key;
  }
  return key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
};

const pushArg = (args: string[], key: string, value: Exclude<XArgValue, null | undefined>) => {
  const flag = `--${toFlagName(key)}`;

  if (typeof value === "boolean") {
    if (value) {
      args.push(flag);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (item === null || item === undefined) {
        continue;
      }
      args.push(flag, String(item));
    }
    return;
  }

  if (typeof value === "object") {
    args.push(flag, JSON.stringify(value));
    return;
  }

  const normalized = String(value);
  if (normalized.trim() === "") {
    return;
  }
  args.push(flag, normalized);
};

const buildCliArgs = (endpoint: string, globalArgs?: XArgMap, endpointArgs?: XArgMap): string[] => {
  const out: string[] = [];
  if (globalArgs) {
    for (const [key, value] of Object.entries(globalArgs)) {
      if (value == null) {
        continue;
      }
      pushArg(out, key, value);
    }
  }
  out.push(endpoint);
  if (endpointArgs) {
    for (const [key, value] of Object.entries(endpointArgs)) {
      if (value == null) {
        continue;
      }
      pushArg(out, key, value);
    }
  }
  return out;
};

const tryParseJSON = (value: string): JsonValue | undefined => {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    return undefined;
  }
};

interface RunXEndpointInput {
  scriptPath: string;
  endpoint: string;
  globalArgs?: XArgMap;
  endpointArgs?: XArgMap;
  timeoutMs?: number;
}

export const runXEndpoint = async ({
  scriptPath,
  endpoint,
  globalArgs,
  endpointArgs,
  timeoutMs = 120_000,
}: RunXEndpointInput): Promise<XRunResult> => {
  const cliArgs = buildCliArgs(endpoint, globalArgs, endpointArgs);

  try {
    const { stdout, stderr } = await execFileAsync(scriptPath, cliArgs, {
      timeout: timeoutMs,
      maxBuffer: 12 * 1024 * 1024,
      env: process.env,
    });
    const parsed = tryParseJSON(stdout);
    return {
      ok: true,
      endpoint,
      payload: parsed ?? stdout.trim(),
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
    };
    const stdout = (err.stdout || "").trim();
    const stderr = (err.stderr || "").trim();
    const parsedStdout = tryParseJSON(stdout);
    const parsedStderr = tryParseJSON(stderr);
    const payload =
      parsedStderr ??
      parsedStdout ??
      (stderr ? stderr : stdout ? stdout : String(err.message || err));
    return {
      ok: false,
      endpoint,
      payload,
      stdout,
      stderr,
      error: typeof err.code === "number" ? `Process exited with code ${err.code}` : String(err.message || err),
    };
  }
};
