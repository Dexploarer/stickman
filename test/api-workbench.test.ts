import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, "..");
const port = 9100 + Math.floor(Math.random() * 200);
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(repoRoot, ".state", `stickman-test-workbench-${port}.db`);
const tempRelPath = `test/.tmp/workbench-${port}.txt`;
const tempAbsPath = path.join(repoRoot, tempRelPath);

let server: ReturnType<typeof spawn> | null = null;
let serverLogs = "";

setDefaultTimeout(45_000);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForHealth = async () => {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // retry
    }
    await sleep(250);
  }
  throw new Error(`Server did not become healthy on ${baseUrl}. Logs:\n${serverLogs.slice(-4000)}`);
};

const apiGet = async (endpoint: string) => {
  const response = await fetch(`${baseUrl}${endpoint}`);
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text || "{}");
  } catch {
    // keep text
  }
  return {
    status: response.status,
    body,
  };
};

const apiPost = async (endpoint: string, payload: Record<string, unknown>) => {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text || "{}");
  } catch {
    // keep text
  }
  return {
    status: response.status,
    body,
  };
};

beforeAll(async () => {
  server = spawn("bun", ["run", "dev"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      STICKMAN_DB_PATH: dbPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk: Buffer | string) => {
    serverLogs += chunk.toString();
  });
  server.stderr.on("data", (chunk: Buffer | string) => {
    serverLogs += chunk.toString();
  });
  await waitForHealth();
});

afterAll(async () => {
  if (server) {
    server.kill("SIGTERM");
    await sleep(200);
    if (!server.killed) {
      server.kill("SIGKILL");
    }
  }
  await rm(tempAbsPath, { force: true });
});

describe("api workbench: workspace file guarded writes", () => {
  it("dry-run issues confirm token and execute enforces confirm token", async () => {
    const dryRun = await apiPost("/api/workspace/file", {
      mode: "dry_run",
      path: tempRelPath,
      content: "hello",
      baseSha256: "",
    });
    expect(dryRun.status).toBe(200);
    expect((dryRun.body as Record<string, unknown>).ok).toBe(true);
    const confirmToken = String((dryRun.body as Record<string, unknown>).confirmToken || "");
    expect(confirmToken.length).toBeGreaterThan(10);

    const executeMissing = await apiPost("/api/workspace/file", {
      mode: "execute",
      path: tempRelPath,
      content: "hello",
      baseSha256: "",
    });
    expect(executeMissing.status).toBe(409);

    const executeOk = await apiPost("/api/workspace/file", {
      mode: "execute",
      path: tempRelPath,
      content: "hello",
      baseSha256: "",
      confirmToken,
    });
    expect(executeOk.status).toBe(200);
    expect((executeOk.body as Record<string, unknown>).ok).toBe(true);

    const readBack = await apiGet(`/api/workspace/file?path=${encodeURIComponent(tempRelPath)}`);
    expect(readBack.status).toBe(200);
    expect((readBack.body as Record<string, unknown>).ok).toBe(true);
    expect((readBack.body as Record<string, unknown>).content).toBe("hello");
  });
});

describe("api workbench: git actions guardrails", () => {
  it("dry-run returns confirm token and execute requires confirm token", async () => {
    const dryRun = await apiPost("/api/git/actions", {
      mode: "dry_run",
      action: "create_branch",
      params: {
        name: `codex/workbench-test-${port}`,
        checkout: true,
      },
    });
    expect(dryRun.status).toBe(200);
    expect((dryRun.body as Record<string, unknown>).ok).toBe(true);
    expect(typeof (dryRun.body as Record<string, unknown>).confirmToken).toBe("string");

    const execMissing = await apiPost("/api/git/actions", {
      mode: "execute",
      action: "create_branch",
      params: {
        name: `codex/workbench-test-${port}`,
        checkout: true,
      },
    });
    expect(execMissing.status).toBe(409);
  });
});

