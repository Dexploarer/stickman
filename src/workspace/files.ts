import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, lstat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceEntry } from "../types.js";

export const MAX_WORKSPACE_FILE_BYTES = 512_000;
export const MAX_WORKSPACE_TREE_ENTRIES = 2_000;

type WorkspaceResolveKind = "file" | "dir";

export type WorkspaceResolveResult =
  | { ok: true; absPath: string; relPath: string }
  | { ok: false; code: "invalid_path" | "blocked_path"; error: string };

export type WorkspaceTreeResult =
  | { ok: true; path: string; entries: WorkspaceEntry[] }
  | { ok: false; code: "invalid_path" | "blocked_path" | "not_found" | "not_a_directory" | "too_many_entries"; error: string };

export type WorkspaceFileReadResult =
  | { ok: true; path: string; content: string; sha256: string; sizeBytes: number; mtime: string }
  | { ok: false; code: "invalid_path" | "blocked_path" | "not_found" | "not_a_file" | "too_large" | "binary_file"; error: string };

export type WorkspaceFileWriteResult =
  | { ok: true; path: string; sha256: string; wroteBytes: number }
  | {
      ok: false;
      code:
        | "invalid_path"
        | "blocked_path"
        | "too_large"
        | "binary_file"
        | "base_sha_mismatch"
        | "is_symlink"
        | "not_a_file";
      error: string;
      currentSha256?: string;
    };

const normalizeRelPath = (raw: string): string => {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    return "";
  }
  const withSlashes = trimmed.replace(/\\/g, "/");
  const noLeading = withSlashes.replace(/^\/+/, "");
  const normalized = path.posix.normalize(noLeading);
  if (normalized === "." || normalized === "./") {
    return "";
  }
  return normalized;
};

const splitSegments = (relPath: string): string[] => {
  return normalizeRelPath(relPath)
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
};

const isBlockedEnvName = (segment: string): boolean => segment === ".env" || segment.startsWith(".env.");

export const isWorkspacePathBlocked = (relPath: string): boolean => {
  const segments = splitSegments(relPath);
  if (!segments.length) {
    return false;
  }
  for (const segment of segments) {
    if (segment === ".git" || segment === "node_modules" || segment === ".pordie" || segment === ".state") {
      return true;
    }
    if (isBlockedEnvName(segment)) {
      return true;
    }
  }
  return false;
};

export const resolveWorkspacePath = (input: {
  workspaceRoot: string;
  relPath: string;
  kind: WorkspaceResolveKind;
}): WorkspaceResolveResult => {
  const rel = normalizeRelPath(input.relPath);
  if (input.kind === "file" && !rel) {
    return { ok: false, code: "invalid_path", error: "path is required." };
  }
  if (rel.includes("\0")) {
    return { ok: false, code: "invalid_path", error: "path contains invalid null byte." };
  }
  if (isWorkspacePathBlocked(rel)) {
    return { ok: false, code: "blocked_path", error: "path is blocked by workspace policy." };
  }

  const resolved = path.resolve(input.workspaceRoot, rel || ".");
  const root = path.resolve(input.workspaceRoot);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    return { ok: false, code: "invalid_path", error: "path must stay inside workspace root." };
  }
  if (input.kind === "file" && resolved === root) {
    return { ok: false, code: "invalid_path", error: "path must point to a file inside workspace." };
  }
  const relOut = path.relative(root, resolved).split(path.sep).join("/");
  return { ok: true, absPath: resolved, relPath: relOut === "." ? "" : relOut };
};

const looksBinary = (buffer: Buffer): boolean => {
  if (!buffer.length) {
    return false;
  }
  if (buffer.includes(0)) {
    return true;
  }
  let printable = 0;
  for (const byte of buffer) {
    if (byte === 9 || byte === 10 || byte === 13) {
      printable += 1;
      continue;
    }
    if (byte >= 32 && byte <= 126) {
      printable += 1;
    }
  }
  const ratio = 1 - printable / buffer.length;
  return ratio > 0.3;
};

export const sha256Hex = (value: string | Buffer): string => {
  return createHash("sha256").update(value).digest("hex");
};

export const listWorkspaceTree = async (input: {
  workspaceRoot: string;
  relDir: string;
}): Promise<WorkspaceTreeResult> => {
  const resolved = resolveWorkspacePath({ workspaceRoot: input.workspaceRoot, relPath: input.relDir, kind: "dir" });
  if (!resolved.ok) {
    return { ok: false, code: resolved.code, error: resolved.error };
  }
  let dirStat;
  try {
    dirStat = await stat(resolved.absPath);
  } catch {
    return { ok: false, code: "not_found", error: "directory not found." };
  }
  if (!dirStat.isDirectory()) {
    return { ok: false, code: "not_a_directory", error: "path is not a directory." };
  }

  const items = await readdir(resolved.absPath, { withFileTypes: true });
  if (items.length > MAX_WORKSPACE_TREE_ENTRIES) {
    return {
      ok: false,
      code: "too_many_entries",
      error: `directory has too many entries (max ${MAX_WORKSPACE_TREE_ENTRIES}).`,
    };
  }

  const entries: WorkspaceEntry[] = [];
  for (const item of items) {
    if (item.isSymbolicLink()) {
      continue;
    }
    const childRel = [resolved.relPath, item.name].filter(Boolean).join("/");
    if (isWorkspacePathBlocked(childRel)) {
      continue;
    }
    const childAbs = path.join(resolved.absPath, item.name);
    let childStat;
    try {
      childStat = await stat(childAbs);
    } catch {
      continue;
    }
    if (childStat.isDirectory()) {
      entries.push({
        name: item.name,
        relPath: childRel,
        type: "dir",
        mtime: childStat.mtime.toISOString(),
      });
      continue;
    }
    if (childStat.isFile()) {
      entries.push({
        name: item.name,
        relPath: childRel,
        type: "file",
        sizeBytes: childStat.size,
        mtime: childStat.mtime.toISOString(),
      });
    }
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "dir" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return {
    ok: true,
    path: resolved.relPath,
    entries,
  };
};

export const readWorkspaceTextFile = async (input: {
  workspaceRoot: string;
  relPath: string;
}): Promise<WorkspaceFileReadResult> => {
  const resolved = resolveWorkspacePath({ workspaceRoot: input.workspaceRoot, relPath: input.relPath, kind: "file" });
  if (!resolved.ok) {
    return { ok: false, code: resolved.code, error: resolved.error };
  }

  let fileStat;
  try {
    fileStat = await stat(resolved.absPath);
  } catch {
    return { ok: false, code: "not_found", error: "file not found." };
  }
  if (!fileStat.isFile()) {
    return { ok: false, code: "not_a_file", error: "path is not a file." };
  }
  if (fileStat.size > MAX_WORKSPACE_FILE_BYTES) {
    return { ok: false, code: "too_large", error: `file exceeds max size (${MAX_WORKSPACE_FILE_BYTES} bytes).` };
  }

  const buffer = await readFile(resolved.absPath);
  if (buffer.byteLength > MAX_WORKSPACE_FILE_BYTES) {
    return { ok: false, code: "too_large", error: `file exceeds max size (${MAX_WORKSPACE_FILE_BYTES} bytes).` };
  }
  if (looksBinary(buffer)) {
    return { ok: false, code: "binary_file", error: "file appears to be binary; text-only editor is enforced." };
  }

  return {
    ok: true,
    path: resolved.relPath,
    content: buffer.toString("utf-8"),
    sha256: sha256Hex(buffer),
    sizeBytes: buffer.byteLength,
    mtime: fileStat.mtime.toISOString(),
  };
};

export const writeWorkspaceTextFile = async (input: {
  workspaceRoot: string;
  relPath: string;
  content: string;
  baseSha256: string;
}): Promise<WorkspaceFileWriteResult> => {
  const resolved = resolveWorkspacePath({ workspaceRoot: input.workspaceRoot, relPath: input.relPath, kind: "file" });
  if (!resolved.ok) {
    return { ok: false, code: resolved.code, error: resolved.error };
  }

  const content = String(input.content ?? "");
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > MAX_WORKSPACE_FILE_BYTES) {
    return { ok: false, code: "too_large", error: `content exceeds max size (${MAX_WORKSPACE_FILE_BYTES} bytes).` };
  }
  if (content.includes("\0")) {
    return { ok: false, code: "binary_file", error: "content contains null byte; refusing to write." };
  }

  const expected = String(input.baseSha256 || "").trim();

  let currentSha = "";
  try {
    const meta = await stat(resolved.absPath);
    if (!meta.isFile()) {
      return { ok: false, code: "not_a_file", error: "existing path is not a file." };
    }
    const link = await lstat(resolved.absPath);
    if (link.isSymbolicLink()) {
      return { ok: false, code: "is_symlink", error: "refusing to write to symlinked file." };
    }
    const buffer = await readFile(resolved.absPath);
    currentSha = sha256Hex(buffer);
  } catch {
    currentSha = "";
  }

  if (currentSha && currentSha !== expected) {
    return {
      ok: false,
      code: "base_sha_mismatch",
      error: "baseSha256 does not match current file contents.",
      currentSha256: currentSha,
    };
  }
  if (!currentSha && expected) {
    return {
      ok: false,
      code: "base_sha_mismatch",
      error: "baseSha256 does not match current file contents.",
      currentSha256: currentSha,
    };
  }

  await mkdir(path.dirname(resolved.absPath), { recursive: true });
  await writeFile(resolved.absPath, content, "utf-8");

  return {
    ok: true,
    path: resolved.relPath,
    sha256: sha256Hex(content),
    wroteBytes: bytes,
  };
};

