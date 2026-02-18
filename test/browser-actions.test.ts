import { describe, expect, it } from "bun:test";

import { openEmbeddedBrowserTab } from "../src/skills/browser-actions.ts";

describe("skills/browser-actions", () => {
  it("rejects missing urls", async () => {
    const result = await openEmbeddedBrowserTab("   ");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("url is required");
  });

  it("normalizes bare hostnames to https", async () => {
    const result = await openEmbeddedBrowserTab("example.com/path");
    expect(result.ok).toBe(true);
    expect(result.payload?.url).toBe("https://example.com/path");
  });

  it("keeps explicit http/https urls", async () => {
    const secure = await openEmbeddedBrowserTab("https://milady.ai");
    const plain = await openEmbeddedBrowserTab("http://localhost:3000");

    expect(secure.payload?.url).toBe("https://milady.ai");
    expect(plain.payload?.url).toBe("http://localhost:3000");
  });

  it("keeps antigravity deep links", async () => {
    const result = await openEmbeddedBrowserTab("antigravity://mission/abc123");
    expect(result.ok).toBe(true);
    expect(result.payload?.url).toBe("antigravity://mission/abc123");
  });
});
