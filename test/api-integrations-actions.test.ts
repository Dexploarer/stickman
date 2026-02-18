import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, "..");
const port = 9200 + Math.floor(Math.random() * 200);
const baseUrl = `http://127.0.0.1:${port}`;

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

describe("api integrations actions", () => {
  it("returns catalog and performs dry-run with confirm token", async () => {
    const dryRun = await apiPost("/api/integrations/actions", {
      mode: "dry_run",
      actionId: "prepare_observer_workspace",
    });
    expect(dryRun.status).toBe(200);
    expect(dryRun.body.ok).toBe(true);
    expect(typeof dryRun.body.confirmToken).toBe("string");
    const trace = Array.isArray(dryRun.body.trace) ? dryRun.body.trace : [];
    expect(trace.length).toBeGreaterThan(0);
    expect(trace.every((step) => step.status === "planned")).toBe(true);
  });

  it("requires confirm token for execute mode", async () => {
    const execute = await apiPost("/api/integrations/actions", {
      mode: "execute",
      actionId: "prepare_observer_workspace",
    });
    expect(execute.status).toBe(409);
    expect(execute.body.ok).toBe(false);
    expect(execute.body.code).toBe("confirm_required");
  });

  it("executes with valid confirm token and rejects token reuse", async () => {
    const dryRun = await apiPost("/api/integrations/actions", {
      mode: "dry_run",
      actionId: "prepare_observer_workspace",
    });
    const confirmToken = String(dryRun.body.confirmToken || "");
    expect(confirmToken.length).toBeGreaterThan(10);

    const execute = await apiPost("/api/integrations/actions", {
      mode: "execute",
      actionId: "prepare_observer_workspace",
      confirmToken,
    });
    expect(execute.status).toBe(200);
    expect(execute.body.ok).toBe(true);
    const trace = Array.isArray(execute.body.trace) ? execute.body.trace : [];
    expect(trace.length).toBeGreaterThan(0);
    expect(trace[0]?.status).toBe("executed");

    const reused = await apiPost("/api/integrations/actions", {
      mode: "execute",
      actionId: "prepare_observer_workspace",
      confirmToken,
    });
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe("confirm_required");
  });

  it("rejects invalid custom step id", async () => {
    const dryRun = await apiPost("/api/integrations/actions", {
      mode: "dry_run",
      steps: [{ id: "invalid_step" }],
    });
    expect(dryRun.status).toBe(400);
    expect(dryRun.body.code).toBe("invalid_action");
  });

  it("returns app_not_allowed when launching without allowlist and no ensure step", async () => {
    const policy = await apiPost("/api/mac/policy", {
      appAllowlist: [],
    });
    expect(policy.status).toBe(200);

    const dryRun = await apiPost("/api/integrations/actions", {
      mode: "dry_run",
      steps: [
        {
          id: "open_mac_app",
          args: {
            appId: "chrome",
          },
        },
      ],
    });
    const confirmToken = String(dryRun.body.confirmToken || "");
    const execute = await apiPost("/api/integrations/actions", {
      mode: "execute",
      steps: [
        {
          id: "open_mac_app",
          args: {
            appId: "chrome",
          },
        },
      ],
      confirmToken,
    });
    expect(execute.status).toBe(403);
    expect(execute.body.code).toBe("app_not_allowed");

    await apiPost("/api/mac/policy", {
      appAllowlist: ["antigravity", "terminal", "chrome"],
    });
  });
});
