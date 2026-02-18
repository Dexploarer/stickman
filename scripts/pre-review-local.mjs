#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Lightweight local PR gate.
 *
 * - Zero network usage.
 * - Bun-first (package.json runs this via `bun`), but also works under Node.
 * - Deterministic: no polling, no flaky timing assertions.
 */

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function run(cmd, { allowFail = false, cwd = process.cwd() } = {}) {
  try {
    return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
  } catch (err) {
    if (allowFail) return "";
    const stdout = err?.stdout?.toString?.() ?? "";
    const stderr = err?.stderr?.toString?.() ?? "";
    const msg = [
      `Command failed: ${cmd}`,
      stdout ? `\nstdout:\n${stdout}` : "",
      stderr ? `\nstderr:\n${stderr}` : "",
    ].join("");
    throw new Error(msg);
  }
}

function hasRef(ref) {
  return spawnSync("git", ["rev-parse", "--verify", ref], { stdio: "ignore" }).status === 0;
}

function pickBaseRef() {
  // Keep parity with the milady skill's preference, but support this repo's `main`.
  if (hasRef("origin/develop")) return "origin/develop";
  if (hasRef("origin/main")) return "origin/main";
  if (hasRef("develop")) return "develop";
  return "main";
}

function parseArgs(argv) {
  const args = {
    base: undefined,
    noVerify: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--base") args.base = argv[i + 1];
    if (a === "--no-verify") args.noVerify = true;
  }
  return args;
}

function getChangedFiles(baseRef) {
  const outs = [
    run(`git diff --name-only ${baseRef}...HEAD`, { allowFail: true }),
    run("git diff --name-only --cached", { allowFail: true }),
    run("git diff --name-only", { allowFail: true }),
  ].filter(Boolean);

  const set = new Set();
  for (const out of outs) {
    for (const line of out.split("\n")) {
      const f = line.trim();
      if (f) set.add(f);
    }
  }
  return [...set];
}

function getUnifiedDiffs(baseRef) {
  // Include committed, staged, and unstaged changes so the tool is useful before commit.
  const diffs = [
    run(`git diff -U0 ${baseRef}...HEAD`, { allowFail: true }),
    run("git diff -U0 --cached", { allowFail: true }),
    run("git diff -U0", { allowFail: true }),
  ].filter(Boolean);
  return diffs.join("\n");
}

function getAddedLinesByFile(baseRef) {
  const out = getUnifiedDiffs(baseRef);
  if (!out) return [];

  const results = [];
  let currentFile = null;

  for (const line of out.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // diff --git a/foo b/foo
      const parts = line.split(" ");
      const b = parts[3]; // b/<path>
      currentFile = b?.startsWith("b/") ? b.slice(2) : null;
      continue;
    }

    if (!currentFile) continue;
    if (line.startsWith("+++")) continue;
    if (line.startsWith("+")) results.push({ file: currentFile, line });
  }

  return results;
}

function classify(changedFiles, addedLines) {
  const onlyDocs =
    changedFiles.length > 0 &&
    changedFiles.every((f) => f.endsWith(".md") || f.startsWith(".github/") || f.endsWith(".txt"));
  if (onlyDocs) return "aesthetic";

  const securityHint =
    addedLines.some((l) => /csrf|xss|ssrf|sqli|auth|jwt|secret|token|apikey/i.test(l)) ||
    changedFiles.some((f) => /auth|security/i.test(f));
  if (securityHint) return "security";

  const looksLikeFix = addedLines.some((l) => /\bfix\b|\bbug\b|\bregress/i.test(l));
  if (looksLikeFix) return "bug fix";

  return changedFiles.length === 0 ? "aesthetic" : "feature";
}

function scopeVerdict(changedFiles, addedLines) {
  const totalFiles = changedFiles.length;
  const bigDiff = addedLines.length > 600 || totalFiles > 25;
  if (bigDiff) return "needs deep review";

  const touchesInfra = changedFiles.some((f) => f.startsWith(".github/") || f.startsWith("scripts/"));
  const touchesRuntime = changedFiles.some((f) => f.startsWith("src/") || f.startsWith("web/"));
  if (touchesInfra && touchesRuntime) return "needs deep review";

  return "in scope";
}

function findProhibitedPatterns(addedLines) {
  const findings = [];

  if (addedLines.some((l) => l.includes("@ts-ignore"))) {
    findings.push("Blocked `@ts-ignore` found in added lines.");
  }

  // Keep this narrow to avoid false positives; still catches common new-any footguns.
  const anyMatchers = [
    /\bas any\b/,
    /:\s*any\b/,
  ];
  if (addedLines.some((l) => anyMatchers.some((re) => re.test(l)))) {
    findings.push("New `any` usage detected in added lines.");
  }

  return findings;
}

function findSecretishPatterns(addedLines) {
  const findings = [];
  const suspect = [
    { re: /sk-[A-Za-z0-9]{20,}/, label: "Looks like an OpenAI-style API key (`sk-...`)." },
    { re: /gho_[A-Za-z0-9_]{20,}/, label: "Looks like a GitHub token (`gho_...`)." },
    { re: /(api[_-]?key|secret|token|password)\s*[:=]\s*['\"][^'\"]+['\"]/i, label: "Looks like an inline credential assignment." },
    { re: /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/, label: "Looks like a phone number." },
  ];

  for (const l of addedLines) {
    for (const s of suspect) {
      if (s.re.test(l)) findings.push(s.label);
    }
  }

  return [...new Set(findings)];
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function dependencyDelta(baseRef) {
  const pkgPath = path.join(process.cwd(), "package.json");
  if (!fs.existsSync(pkgPath)) return { added: [], removed: [] };
  if (!getChangedFiles(baseRef).includes("package.json")) return { added: [], removed: [] };

  const basePkg = JSON.parse(run(`git show ${baseRef}:package.json`));
  const headPkg = readJson(pkgPath);

  const baseDeps = { ...(basePkg.dependencies ?? {}), ...(basePkg.optionalDependencies ?? {}) };
  const headDeps = { ...(headPkg.dependencies ?? {}), ...(headPkg.optionalDependencies ?? {}) };

  const added = Object.keys(headDeps).filter((k) => !(k in baseDeps));
  const removed = Object.keys(baseDeps).filter((k) => !(k in headDeps));

  return { added, removed };
}

function verifyCommands({ classification, noVerify }) {
  if (noVerify) return { ok: true, notes: ["Verification skipped via --no-verify."] };

  const mustTest = classification === "bug fix" || classification === "feature" || classification === "security";
  const steps = ["bun run lint", ...(mustTest ? ["bun run test:once"] : [])];

  for (const cmd of steps) {
    const res = spawnSync(cmd, { shell: true, stdio: "inherit" });
    if (res.status !== 0) return { ok: false, failed: cmd };
  }

  return { ok: true, steps };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseRef = args.base ?? pickBaseRef();
  if (!hasRef(baseRef)) {
    console.error(`Base ref not found: ${baseRef}`);
    process.exit(2);
  }

  const changedFiles = getChangedFiles(baseRef);

  const addedByFile = getAddedLinesByFile(baseRef).filter(
    // Don't self-trigger on detection strings.
    ({ file }) => file !== "scripts/pre-review-local.mjs",
  );
  const addedLines = addedByFile.map(({ line }) => line);

  if (process.env.PRE_REVIEW_DEBUG === "1") {
    console.error("[pre-review] baseRef:", baseRef);
    console.error("[pre-review] changedFiles:", changedFiles);
    console.error("[pre-review] addedByFile sample:", addedByFile.slice(0, 10));
  }

  const classification = classify(changedFiles, addedLines);
  const scope = scopeVerdict(changedFiles, addedLines);

  const requiredChanges = [];

  for (const f of findProhibitedPatterns(addedLines)) requiredChanges.push(f);
  for (const f of findSecretishPatterns(addedLines)) requiredChanges.push(f);

  const depDelta = dependencyDelta(baseRef);
  if (depDelta.added.length > 0) {
    requiredChanges.push(`New deps added: ${depDelta.added.join(", ")} (confirm runtime imports and necessity).`);
  }

  const touchesSrc = changedFiles.some((f) => f.startsWith("src/") || f.startsWith("web/"));
  const touchesTests = changedFiles.some((f) => f.startsWith("test/") || f.includes("__tests__"));
  if (touchesSrc && !touchesTests && (classification === "bug fix" || classification === "feature" || classification === "security")) {
    requiredChanges.push("Behavior change detected without test updates (expected tests for bugfix/feature/security).");
  }

  const verification = verifyCommands({ classification, noVerify: args.noVerify });

  const decision =
    requiredChanges.length === 0 && verification.ok && scope !== "out of scope" ? "APPROVE" : "REQUEST CHANGES";

  console.log("## Pre-Review Results");
  console.log(`1. **Classification:** ${classification}`);
  console.log(`2. **Scope verdict:** ${scope}`);
  console.log(`3. **Code quality:** ${verification.ok ? "pass" : "fail"}`);
  console.log(`4. **Security:** ${requiredChanges.length === 0 ? "pass" : "needs review"}`);
  console.log(`5. **Tests:** ${verification.ok ? "pass" : "fail"}`);
  console.log(`6. **Decision:** ${decision}`);

  if (!verification.ok) {
    console.log("\n### Required changes");
    console.log(`- [ ] Fix failing command: \`${verification.failed}\``);
  }

  if (requiredChanges.length > 0) {
    console.log("\n### Required changes");
    for (const item of requiredChanges) console.log(`- [ ] ${item}`);
  }

  process.exit(decision === "APPROVE" ? 0 : 1);
}

main();
