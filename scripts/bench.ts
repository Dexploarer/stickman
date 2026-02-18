import { performance } from "node:perf_hooks";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { listWorkspaceTree, readWorkspaceTextFile, resolveWorkspacePath } from "../src/workspace/files.ts";

type BenchSample = {
  name: string;
  iterations: number;
  warmup: number;
  medianMs: number;
  meanMs: number;
  p95Ms: number;
  cpuUserMs: number;
  cpuSystemMs: number;
};

type BenchRun = {
  startedAt: string;
  endedAt: string;
  repoRoot: string;
  nodeVersion: string;
  platform: string;
  cpuModel: string;
  cpuCount: number;
  samples: BenchSample[];
};

const REGRESSION_THRESHOLD = 0.2;
const BASELINE_PATH = path.join(process.cwd(), ".state", "benchmarks", "baseline.json");
const LATEST_PATH = path.join(process.cwd(), ".state", "benchmarks", "latest.json");

const median = (values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
};

const mean = (values: number[]): number => {
  if (!values.length) return 0;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
};

const p95 = (values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(0.95 * (sorted.length - 1)));
  return sorted[idx];
};

const measure = async (name: string, fn: () => Promise<void>, iterations: number, warmup: number): Promise<BenchSample> => {
  for (let i = 0; i < warmup; i += 1) {
    await fn();
  }

  const samples: number[] = [];
  const cpuStart = process.cpuUsage();
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  const cpuEnd = process.cpuUsage(cpuStart);

  return {
    name,
    iterations,
    warmup,
    medianMs: median(samples),
    meanMs: mean(samples),
    p95Ms: p95(samples),
    cpuUserMs: cpuEnd.user / 1000,
    cpuSystemMs: cpuEnd.system / 1000,
  };
};

const readJson = async <T,>(filePath: string): Promise<T | null> => {
  try {
    const data = await readFile(filePath, "utf-8");
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
};

const writeJson = async (filePath: string, payload: unknown): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
};

const main = async () => {
  const repoRoot = process.cwd();
  const startedAt = new Date().toISOString();

  const cpuInfo = os.cpus();
  const cpuModel = cpuInfo[0]?.model ?? "unknown";
  const cpuCount = cpuInfo.length || 0;

  const run: BenchRun = {
    startedAt,
    endedAt: "",
    repoRoot,
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpuModel,
    cpuCount,
    samples: [],
  };

  const workspaceRoot = repoRoot;
  const resolvedRoot = resolveWorkspacePath({ workspaceRoot, relPath: "", kind: "dir" });
  if (!resolvedRoot.ok) {
    throw new Error(`Failed to resolve workspace root: ${resolvedRoot.error}`);
  }

  run.samples.push(
    await measure(
      "resolveWorkspacePath:src/server.ts",
      async () => {
        resolveWorkspacePath({ workspaceRoot, relPath: "src/server.ts", kind: "file" });
      },
      200,
      50,
    ),
  );

  run.samples.push(
    await measure(
      "listWorkspaceTree:src",
      async () => {
        await listWorkspaceTree({ workspaceRoot, relDir: "src" });
      },
      60,
      10,
    ),
  );

  run.samples.push(
    await measure(
      "readWorkspaceTextFile:src/server.ts",
      async () => {
        await readWorkspaceTextFile({ workspaceRoot, relPath: "src/server.ts" });
      },
      60,
      10,
    ),
  );

  run.endedAt = new Date().toISOString();

  const baseline = await readJson<BenchRun>(BASELINE_PATH);
  await writeJson(LATEST_PATH, run);

  if (!baseline) {
    await writeJson(BASELINE_PATH, run);
    console.log("Baseline created:", BASELINE_PATH);
    return;
  }

  const baselineMap = new Map(baseline.samples.map((sample) => [sample.name, sample]));
  const regressions: Array<{ name: string; baselineMs: number; currentMs: number; deltaPct: number }> = [];

  for (const sample of run.samples) {
    const baselineSample = baselineMap.get(sample.name);
    if (!baselineSample) continue;
    if (baselineSample.medianMs <= 0) continue;
    const delta = (sample.medianMs - baselineSample.medianMs) / baselineSample.medianMs;
    if (delta > REGRESSION_THRESHOLD) {
      regressions.push({
        name: sample.name,
        baselineMs: baselineSample.medianMs,
        currentMs: sample.medianMs,
        deltaPct: delta * 100,
      });
    }
  }

  if (regressions.length) {
    console.error("Performance regressions detected:");
    for (const reg of regressions) {
      console.error(
        `- ${reg.name}: ${reg.baselineMs.toFixed(2)}ms -> ${reg.currentMs.toFixed(2)}ms (${reg.deltaPct.toFixed(
          1,
        )}%)`,
      );
    }
    process.exitCode = 2;
  } else {
    console.log("No regressions detected.");
  }
};

await main();
