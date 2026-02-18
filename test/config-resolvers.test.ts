import { describe, expect, it } from "bun:test";
import path from "node:path";

const loadConfigModule = async (overrides: Record<string, string | undefined>) => {
  const prior: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    prior[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await import(`../src/config.ts?test=${Math.random().toString(36).slice(2)}`);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

describe("config resolvers", () => {
  it("honors PORDIE_SCOPE override for resolvePordieScope/resolvePordiePaths", async () => {
    const config = await loadConfigModule({
      PORDIE_SCOPE: "project",
    });

    expect(config.resolvePordieScope("global")).toBe("project");
    expect(config.resolvePordieScope()).toBe("project");

    const paths = config.resolvePordiePaths();
    expect(paths.scope).toBe("project");
    expect(paths.dir).toBe(config.projectPordieDir);
  });

  it("defaults resolvePordieScope to global when no override is set", async () => {
    const config = await loadConfigModule({
      PORDIE_SCOPE: undefined,
    });

    expect(config.resolvePordieScope("project")).toBe("project");
    expect(config.resolvePordieScope("invalid")).toBe("global");
    expect(config.resolvePordieScope()).toBe("global");
  });

  it("builds deterministic path outputs for resolvePordiePaths", async () => {
    const config = await loadConfigModule({
      PORDIE_SCOPE: undefined,
    });

    const paths = config.resolvePordiePaths("project");
    expect(paths.scope).toBe("project");
    expect(paths.dir).toBe(config.projectPordieDir);
    expect(paths.configPath).toBe(path.resolve(config.projectPordieDir, "config.json"));
    expect(paths.envPath).toBe(path.resolve(config.projectPordieDir, ".env"));
    expect(paths.envScriptPath).toBe(path.resolve(config.projectPordieDir, "env.sh"));
  });

  it("buildDefaultXGlobalArgs includes optional args only when configured", async () => {
    const config = await loadConfigModule({
      X_BROWSER: "edge",
      X_CHROME_PROFILE_NAME: "Profile 7",
      X_VISIBLE: "1",
      X_NOTIFY: "0",
      X_COMPAT_PROVIDER: "openrouter",
      X_CHROME_PROFILE: "/tmp/chrome-profile",
      X_NOTIFY_WEBHOOK: "https://example.local/webhook",
    });

    const args = config.buildDefaultXGlobalArgs();
    expect(args.browser).toBe("edge");
    expect(args.chromeProfileName).toBe("Profile 7");
    expect(args.visible).toBe(true);
    expect(args.notify).toBe(false);
    expect(args.compatProvider).toBe("openrouter");
    expect(args.chromeProfile).toBe("/tmp/chrome-profile");
    expect(args.notifyWebhook).toBe("https://example.local/webhook");
  });
});
