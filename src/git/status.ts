import type { GitStatusResponse } from "../types.js";
import { runGit, tailText } from "./runner.js";

const parseBranchHeader = (line: string): string => {
  return line.slice("# branch.head ".length).trim();
};

const parseUpstreamHeader = (line: string): string => {
  return line.slice("# branch.upstream ".length).trim();
};

const parseAheadBehind = (line: string): { ahead: number; behind: number } => {
  const rest = line.slice("# branch.ab ".length).trim();
  const parts = rest.split(/\s+/);
  const aheadRaw = parts.find((part) => part.startsWith("+")) || "+0";
  const behindRaw = parts.find((part) => part.startsWith("-")) || "-0";
  return {
    ahead: Math.max(0, Number(aheadRaw.slice(1)) || 0),
    behind: Math.max(0, Number(behindRaw.slice(1)) || 0),
  };
};

const readPathFromRecord = (parts: string[]): string => {
  if (parts[0] === "?") {
    return parts.slice(1).join(" ").trim();
  }
  if (parts[0] === "2") {
    return (parts[9] || "").trim();
  }
  return parts.slice(8).join(" ").trim();
};

export const parseGitPorcelainV2Status = (raw: string): GitStatusResponse => {
  const staged = new Set<string>();
  const unstaged = new Set<string>();
  const untracked = new Set<string>();

  let branch = "";
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;

  const lines = String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);

  for (const line of lines) {
    if (line.startsWith("# branch.head ")) {
      branch = parseBranchHeader(line);
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      upstream = parseUpstreamHeader(line);
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const parsed = parseAheadBehind(line);
      ahead = parsed.ahead;
      behind = parsed.behind;
      continue;
    }

    if (line.startsWith("? ")) {
      const parts = line.split(" ");
      const filePath = readPathFromRecord(parts);
      if (filePath) {
        untracked.add(filePath);
      }
      continue;
    }

    if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ")) {
      const parts = line.split(" ");
      const xy = (parts[1] || "..").slice(0, 2);
      const indexStatus = xy[0] || ".";
      const workStatus = xy[1] || ".";
      const filePath = readPathFromRecord(parts);
      if (!filePath) {
        continue;
      }
      if (indexStatus !== ".") {
        staged.add(filePath);
      }
      if (workStatus !== ".") {
        unstaged.add(filePath);
      }
    }
  }

  return {
    ok: true,
    branch,
    upstream,
    ahead,
    behind,
    changes: {
      staged: Array.from(staged).sort(),
      unstaged: Array.from(unstaged).sort(),
      untracked: Array.from(untracked).sort(),
    },
    rawPorcelain: tailText(raw, 40_000),
  };
};

export const getGitStatus = (cwd: string): GitStatusResponse => {
  const result = runGit(["status", "--porcelain=v2", "--branch"], { cwd });
  if (!result.ok) {
    return {
      ok: false,
      branch: "",
      upstream: undefined,
      ahead: 0,
      behind: 0,
      changes: { staged: [], unstaged: [], untracked: [] },
      rawPorcelain: tailText(result.stderr || result.stdout || "", 2000),
    } as GitStatusResponse;
  }
  return parseGitPorcelainV2Status(result.stdout);
};

