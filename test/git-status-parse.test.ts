import { describe, expect, it } from "bun:test";

import { parseGitPorcelainV2Status } from "../src/git/status.ts";

describe("git/status porcelain v2 parse", () => {
  it("parses branch metadata and change buckets", () => {
    const raw = [
      "# branch.oid 0123456789abcdef",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +1 -2",
      "1 M. N... 100644 100644 100644 0123456 0123456 src/server.ts",
      "1 .M N... 100644 100644 100644 0123456 0123456 web/app.js",
      "? untracked.txt",
      "",
    ].join("\n");

    const parsed = parseGitPorcelainV2Status(raw);
    expect(parsed.ok).toBe(true);
    expect(parsed.branch).toBe("main");
    expect(parsed.upstream).toBe("origin/main");
    expect(parsed.ahead).toBe(1);
    expect(parsed.behind).toBe(2);
    expect(parsed.changes.staged).toEqual(["src/server.ts"]);
    expect(parsed.changes.unstaged).toEqual(["web/app.js"]);
    expect(parsed.changes.untracked).toEqual(["untracked.txt"]);
    expect(typeof parsed.rawPorcelain).toBe("string");
  });
});

