import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, "..");
const port = 8900 + Math.floor(Math.random() * 200);
const baseUrl = `http://127.0.0.1:${port}`;

let server: ReturnType<typeof spawn> | null = null;
let serverLogs = "";

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

beforeAll(async () => {
  server = spawn("bun", ["run", "dev"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
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
  if (!server) {
    return;
  }
  server.kill("SIGTERM");
  await sleep(200);
  if (!server.killed) {
    server.kill("SIGKILL");
  }
});

describe("api read-only smoke", () => {
  it("returns healthy status and runtime metadata", async () => {
    const health = await apiGet("/api/health");
    expect(health.status).toBe(200);
    expect(typeof (health.body as Record<string, unknown>).ok).toBe("boolean");
    expect((health.body as Record<string, unknown>).ok).toBe(true);
  });

  it("serves provider, extension, skills, and autonomy control planes", async () => {
    const provider = await apiGet("/api/providers/status");
    const extensions = await apiGet("/api/extensions");
    const skills = await apiGet("/api/skills");
    const autonomy = await apiGet("/api/agent/autonomy");
    const coworkState = await apiGet("/api/cowork/state");
    const missions = await apiGet("/api/cowork/missions");

    expect(provider.status).toBe(200);
    expect(extensions.status).toBe(200);
    expect(skills.status).toBe(200);
    expect(autonomy.status).toBe(200);
    expect(coworkState.status).toBe(200);
    expect(missions.status).toBe(200);

    expect((provider.body as Record<string, unknown>).ok).toBe(true);
    expect((extensions.body as Record<string, unknown>).ok).toBe(true);
    expect(Array.isArray((skills.body as Record<string, unknown>).skills)).toBe(true);
    expect((autonomy.body as Record<string, unknown>).ok).toBe(true);
    expect((coworkState.body as Record<string, unknown>).ok).toBe(true);
    expect(Array.isArray((missions.body as Record<string, unknown>).missions)).toBe(true);
  });

  it("serves task/mac/watch/code status surfaces and ws upgrade guard", async () => {
    const tasks = await apiGet("/api/agent/tasks");
    const macApps = await apiGet("/api/mac/apps");
    const watchSources = await apiGet("/api/watch/sources");
    const livekit = await apiGet("/api/livekit/status");
    const codeStatus = await apiGet("/api/code/status");
    const wsUpgrade = await apiGet("/api/live/ws");

    expect(tasks.status).toBe(200);
    expect(macApps.status).toBe(200);
    expect(watchSources.status).toBe(200);
    expect(livekit.status).toBe(200);
    expect(codeStatus.status).toBe(200);
    expect(wsUpgrade.status).toBe(426);

    expect((tasks.body as Record<string, unknown>).ok).toBe(true);
    expect(Array.isArray((macApps.body as Record<string, unknown>).apps)).toBe(true);
    expect(Array.isArray((watchSources.body as Record<string, unknown>).sources)).toBe(true);
    expect((livekit.body as Record<string, unknown>).ok).toBe(true);
    expect((codeStatus.body as Record<string, unknown>).ok).toBe(true);
    expect((wsUpgrade.body as Record<string, unknown>).ok).toBe(false);
  });
});
