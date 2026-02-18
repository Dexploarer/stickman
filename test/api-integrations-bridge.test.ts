import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, "..");
const port = 9400 + Math.floor(Math.random() * 200);
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(repoRoot, ".state", `stickman-test-${port}.db`);

let server: ReturnType<typeof spawn> | null = null;
let serverLogs = "";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForHealth = async () => {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
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

const apiDelete = async (endpoint: string) => {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "DELETE",
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
  if (!server) return;
  server.kill("SIGTERM");
  await sleep(200);
  if (!server.killed) {
    server.kill("SIGKILL");
  }
});

describe("api integrations bridge", () => {
  it("supports subscriber lifecycle and signed webhook delivery", async () => {
    const received: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
    const collector = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received.push({
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf-8"),
        });
        res.statusCode = 200;
        res.end("ok");
      });
    });
    await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", () => resolve()));
    const address = collector.address();
    const webhookPort = typeof address === "object" && address ? address.port : 0;
    const webhookUrl = `http://127.0.0.1:${webhookPort}/hook`;

    const create = await apiPost("/api/integrations/subscriptions", {
      url: webhookUrl,
      events: ["integration_*"],
    });
    expect(create.status).toBe(201);
    const subId = String((create.body.subscriber as Record<string, unknown>)?.id || "");
    expect(subId.length).toBeGreaterThan(10);
    expect(typeof create.body.secret).toBe("string");

    const testSend = await apiPost(`/api/integrations/subscriptions/${encodeURIComponent(subId)}/test`, {});
    expect(testSend.status).toBe(200);

    const deadline = Date.now() + 4000;
    while (!received.length && Date.now() < deadline) {
      await sleep(100);
    }
    expect(received.length).toBeGreaterThan(0);
    const headers = received[0]?.headers || {};
    expect(typeof headers["x-stickman-signature"]).toBe("string");
    expect(typeof headers["x-stickman-event-id"]).toBe("string");
    expect(typeof headers["x-stickman-event-type"]).toBe("string");
    expect(typeof headers["x-stickman-attempt"]).toBe("string");

    const bridgeStatus = await apiGet("/api/integrations/bridge/status");
    expect(bridgeStatus.status).toBe(200);
    const bridge = bridgeStatus.body.bridge as Record<string, unknown>;
    expect(Number(bridge.subscribersTotal || 0)).toBeGreaterThan(0);
    expect(Number(bridge.delivered || 0)).toBeGreaterThanOrEqual(1);

    const disable = await apiPost(`/api/integrations/subscriptions/${encodeURIComponent(subId)}/disable`, {});
    expect(disable.status).toBe(200);
    const enable = await apiPost(`/api/integrations/subscriptions/${encodeURIComponent(subId)}/enable`, {});
    expect(enable.status).toBe(200);

    const remove = await apiDelete(`/api/integrations/subscriptions/${encodeURIComponent(subId)}`);
    expect(remove.status).toBe(200);
    await new Promise<void>((resolve) => collector.close(() => resolve()));
  });

  it("schedules retries on webhook delivery failures", async () => {
    const create = await apiPost("/api/integrations/subscriptions", {
      url: "http://127.0.0.1:9/unreachable",
      events: ["integration_*"],
    });
    expect(create.status).toBe(201);
    const subId = String((create.body.subscriber as Record<string, unknown>)?.id || "");
    expect(subId.length).toBeGreaterThan(10);

    const send = await apiPost(`/api/integrations/subscriptions/${encodeURIComponent(subId)}/test`, {});
    expect(send.status).toBe(200);

    await sleep(1500);
    const bridgeStatus = await apiGet("/api/integrations/bridge/status");
    const bridge = bridgeStatus.body.bridge as Record<string, unknown>;
    expect(Number(bridge.retriesScheduled || 0)).toBeGreaterThanOrEqual(1);

    await apiDelete(`/api/integrations/subscriptions/${encodeURIComponent(subId)}`);
  });
});
