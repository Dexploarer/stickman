import { describe, expect, it } from "bun:test";

import { listKnownMacApps } from "../src/skills/mac-actions.ts";

describe("skills/mac-actions", () => {
  it("returns the expected app registry", () => {
    const apps = listKnownMacApps();
    const ids = apps.map((app) => app.id).sort();

    expect(ids).toEqual(["antigravity", "chrome", "terminal"]);
    apps.forEach((app) => {
      expect(typeof app.title).toBe("string");
      expect(typeof app.bundlePath).toBe("string");
      expect(typeof app.bundleId).toBe("string");
      expect(typeof app.available).toBe("boolean");
    });
  });
});
