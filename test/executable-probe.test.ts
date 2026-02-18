import { describe, expect, it } from "bun:test";

import { clearExecutableProbeCache, getExecutableProbe } from "../src/integrations/executable-probe.ts";

describe("executable probe cache", () => {
  it("returns unavailable for empty binaries", async () => {
    clearExecutableProbeCache();
    const result = await getExecutableProbe("");
    expect(result.available).toBe(false);
    expect(result.path).toBeNull();
  });

  it("resolves absolute executable paths asynchronously", async () => {
    clearExecutableProbeCache();
    const result = await getExecutableProbe("/bin/sh");
    expect(result.available).toBe(true);
    expect(result.path).toBe("/bin/sh");
  });

  it("returns unavailable for missing binaries", async () => {
    clearExecutableProbeCache();
    const result = await getExecutableProbe("definitely-not-a-real-binary-xyz");
    expect(result.available).toBe(false);
    expect(result.path).toBeNull();
  });
});
