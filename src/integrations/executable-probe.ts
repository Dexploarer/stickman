import { spawn } from "node:child_process";
import { access, constants as fsConstants } from "node:fs/promises";
import path from "node:path";

export interface ExecutableProbeResult {
  available: boolean;
  path: string | null;
}

const DEFAULT_TTL_MS = 60_000;
const WHICH_TIMEOUT_MS = 2_000;

interface ProbeCacheEntry {
  result: ExecutableProbeResult | null;
  checkedAt: number;
  inflight: Promise<ExecutableProbeResult> | null;
}

const probeCache = new Map<string, ProbeCacheEntry>();

const probeWithWhich = (binary: string): Promise<string | null> => {
  return new Promise((resolve) => {
    let resolved = false;
    const child = spawn("which", [binary], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
    });

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    const settle = (value: string | null) => {
      if (resolved) {
        return;
      }
      resolved = true;
      resolve(value);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      settle(null);
    }, WHICH_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        settle(null);
        return;
      }
      const candidate = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      settle(candidate || null);
    });

    child.on("error", () => {
      clearTimeout(timer);
      settle(null);
    });
  });
};

const runProbe = async (binary: string): Promise<ExecutableProbeResult> => {
  const candidate = String(binary || "").trim();
  if (!candidate) {
    return { available: false, path: null };
  }

  if (path.isAbsolute(candidate)) {
    try {
      await access(candidate, fsConstants.X_OK);
      return { available: true, path: candidate };
    } catch {
      return { available: false, path: null };
    }
  }

  const resolved = await probeWithWhich(candidate);
  if (!resolved) {
    return { available: false, path: null };
  }
  return { available: true, path: resolved };
};

const refreshProbe = async (binary: string): Promise<ExecutableProbeResult> => {
  const next = await runProbe(binary);
  const existing = probeCache.get(binary);
  if (existing) {
    existing.result = next;
    existing.checkedAt = Date.now();
    existing.inflight = null;
  } else {
    probeCache.set(binary, {
      result: next,
      checkedAt: Date.now(),
      inflight: null,
    });
  }
  return next;
};

export const getExecutableProbe = async (
  binary: string,
  options?: {
    ttlMs?: number;
  },
): Promise<ExecutableProbeResult> => {
  const candidate = String(binary || "").trim();
  if (!candidate) {
    return { available: false, path: null };
  }

  const ttlMs = Math.max(1_000, options?.ttlMs ?? DEFAULT_TTL_MS);
  const now = Date.now();
  const entry = probeCache.get(candidate);

  if (entry && entry.result && now - entry.checkedAt < ttlMs) {
    return entry.result;
  }

  if (entry?.result) {
    if (!entry.inflight) {
      entry.inflight = refreshProbe(candidate);
    }
    return entry.result;
  }

  if (entry?.inflight) {
    return entry.inflight;
  }

  const inflight = refreshProbe(candidate);
  probeCache.set(candidate, {
    result: null,
    checkedAt: 0,
    inflight,
  });
  return inflight;
};

export const clearExecutableProbeCache = () => {
  probeCache.clear();
};
