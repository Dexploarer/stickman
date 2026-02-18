import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, "..");
const port = 9100 + Math.floor(Math.random() * 200);
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(repoRoot, ".state", `stickman-test-${port}.db`);

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

const parseBody = async (response: Response) => {
  const text = await response.text();
  try {
    return JSON.parse(text || "{}") as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
};

const apiGet = async (endpoint: string) => {
  const response = await fetch(`${baseUrl}${endpoint}`);
  return {
    status: response.status,
    body: await parseBody(response),
  };
};

const apiPost = async (endpoint: string, body: Record<string, unknown>) => {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await parseBody(response),
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
  if (!server) {
    return;
  }
  server.kill("SIGTERM");
  await sleep(200);
  if (!server.killed) {
    server.kill("SIGKILL");
  }
});

describe("api cowork workspace", () => {
  it("creates quick-action tasks and retries them", async () => {
    const quick = await apiPost("/api/cowork/quick-action", {
      action: "open_terminal",
    });
    expect(quick.status).toBe(200);
    expect(quick.body.ok).toBe(true);
    const task = quick.body.task as Record<string, unknown> | undefined;
    const taskId = typeof task?.id === "string" ? task.id : "";
    expect(taskId.length).toBeGreaterThan(10);

    const retry = await apiPost(`/api/agent/tasks/${encodeURIComponent(taskId)}/retry`, {});
    expect(retry.status).toBe(200);
    expect(retry.body.ok).toBe(true);
    const retriedTask = retry.body.task as Record<string, unknown> | undefined;
    const retriedTaskId = typeof retriedTask?.id === "string" ? retriedTask.id : "";
    expect(retriedTaskId.length).toBeGreaterThan(10);
    expect(retriedTaskId).not.toBe(taskId);
  });

  it("lists mission templates and runs a mission task", async () => {
    const missions = await apiGet("/api/cowork/missions");
    expect(missions.status).toBe(200);
    expect(missions.body.ok).toBe(true);
    const missionRows = Array.isArray(missions.body.missions) ? missions.body.missions : [];
    expect(missionRows.length).toBeGreaterThan(0);

    const run = await apiPost("/api/cowork/missions/social_signal_sweep/run", {
      query: "AI cowork agent workspace",
      startTask: true,
    });
    expect(run.status).toBe(200);
    expect(run.body.ok).toBe(true);
    const task = run.body.task as Record<string, unknown> | undefined;
    expect(typeof task?.id).toBe("string");
  });

  it("creates dependent task chains and serves log tails", async () => {
    const chain = await apiPost("/api/agent/tasks/chain", {
      startTask: true,
      tasks: [
        {
          prompt: "Open terminal for chain step 1",
          skillId: "terminal.open",
        },
        {
          prompt: "Open terminal for chain step 2",
          skillId: "terminal.open",
        },
      ],
    });
    expect(chain.status).toBe(200);
    expect(chain.body.ok).toBe(true);

    const tasks = Array.isArray(chain.body.tasks) ? chain.body.tasks : [];
    expect(tasks.length).toBe(2);
    const first = tasks[0] as Record<string, unknown>;
    const second = tasks[1] as Record<string, unknown>;
    const firstId = typeof first.id === "string" ? first.id : "";
    const secondId = typeof second.id === "string" ? second.id : "";
    expect(firstId.length).toBeGreaterThan(10);
    expect(secondId.length).toBeGreaterThan(10);
    expect(second.dependsOnTaskId).toBe(firstId);

    await sleep(450);

    const secondDetail = await apiGet(`/api/agent/tasks/${encodeURIComponent(secondId)}`);
    expect(secondDetail.status).toBe(200);
    expect(secondDetail.body.ok).toBe(true);
    const secondTask = secondDetail.body.task as Record<string, unknown>;
    expect(typeof secondTask.chainId).toBe("string");

    const logs = await apiGet(`/api/agent/tasks/${encodeURIComponent(secondId)}/logs?limit=25`);
    expect(logs.status).toBe(200);
    expect(logs.body.ok).toBe(true);
    expect(Array.isArray(logs.body.logs)).toBe(true);
  });

  it("returns cowork state summary with task/approval/watch counters", async () => {
    const state = await apiGet("/api/cowork/state");
    expect(state.status).toBe(200);
    expect(state.body.ok).toBe(true);

    const summary = state.body.summary as Record<string, unknown>;
    const tasks = summary.tasks as Record<string, unknown>;
    const approvals = summary.approvals as Record<string, unknown>;
    const watch = summary.watch as Record<string, unknown>;
    const skills = summary.skills as Record<string, unknown>;

    expect(typeof tasks.total).toBe("number");
    expect(typeof tasks.running).toBe("number");
    expect(typeof approvals.total).toBe("number");
    expect(typeof watch.active).toBe("number");
    expect(typeof skills.total).toBe("number");
  });
});
