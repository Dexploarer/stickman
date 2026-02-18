export const validateBranchName = (raw: string): { ok: true; name: string } | { ok: false; error: string } => {
  const name = String(raw || "").trim();
  if (!name) {
    return { ok: false, error: "branch name is required." };
  }
  if (name.length > 120) {
    return { ok: false, error: "branch name too long (max 120 chars)." };
  }
  if (name.startsWith("-")) {
    return { ok: false, error: "branch name cannot start with '-'." };
  }
  if (name.endsWith("/")) {
    return { ok: false, error: "branch name cannot end with '/'." };
  }
  if (name.includes("..") || name.includes("@{")) {
    return { ok: false, error: "branch name contains a forbidden sequence." };
  }
  if (/\s/.test(name)) {
    return { ok: false, error: "branch name cannot contain whitespace." };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9._-]$/.test(name)) {
    return { ok: false, error: "branch name contains invalid characters." };
  }
  if (name.includes("//")) {
    return { ok: false, error: "branch name cannot contain consecutive slashes." };
  }
  return { ok: true, name };
};

export const normalizeCommitMessage = (raw: string): { ok: true; message: string } | { ok: false; error: string } => {
  const message = String(raw || "").trim();
  if (!message) {
    return { ok: false, error: "commit message is required." };
  }
  if (message.length > 120) {
    return { ok: false, error: "commit message too long (max 120 chars)." };
  }
  return { ok: true, message };
};

