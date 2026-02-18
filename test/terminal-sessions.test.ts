import { describe, expect, it } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { closeTerminalSession, createTerminalSession, getTerminalSession, listTerminalSessions } from "../src/terminal/sessions.ts";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, "..");

describe("terminal sessions lifecycle", () => {
  it("archives closed sessions and releases active session storage", async () => {
    const created = await createTerminalSession({ projectRoot: repoRoot });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    const sessionId = created.session.id;
    expect(getTerminalSession(sessionId)).not.toBeNull();

    const closed = closeTerminalSession(sessionId);
    expect(closed.ok).toBe(true);
    expect(getTerminalSession(sessionId)).toBeNull();

    const sessions = listTerminalSessions(40);
    const archived = sessions.find((item) => item.id === sessionId);
    expect(archived).toBeDefined();
    expect(archived?.status).toBe("exited");
  });
});
