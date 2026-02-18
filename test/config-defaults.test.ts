import { describe, expect, it } from "bun:test";

import { defaultOnboardingState } from "../src/config.ts";
import { skillCatalog } from "../src/skills/catalog.ts";

describe("config/defaultOnboardingState", () => {
  it("builds required provider/extension/autonomy/watch defaults", () => {
    const defaults = defaultOnboardingState();

    expect(defaults.providers.mode).toBe("openrouter");
    expect(defaults.extensions.x.enabled).toBe(true);
    expect(defaults.extensions.code.enabled).toBe(true);
    expect(defaults.autonomy.policy).toBe("mixed_auto");
    expect(defaults.watch.mode).toBe("screenshare");
    expect(defaults.watch.captureScope).toBe("agent_surfaces_only");
    expect(defaults.livekit.enabled).toBe(false);
    expect(defaults.livekit.streamMode).toBe("events_only");
    expect(defaults.livekit.roomPrefix.length).toBeGreaterThan(0);
    expect(defaults.storage?.engine).toBe("sqlite");
    expect(typeof defaults.storage?.path).toBe("string");
  });

  it("enables all catalog skills by default", () => {
    const defaults = defaultOnboardingState();

    skillCatalog.forEach((skill) => {
      expect(defaults.skills.enabled[skill.id]).toBe(true);
    });
  });

  it("sets guarded mac policy defaults", () => {
    const defaults = defaultOnboardingState();

    expect(defaults.macControl.appAllowlist).toEqual(["antigravity", "terminal", "chrome"]);
    expect(defaults.macControl.requireApprovalFor).toEqual([
      "terminal_exec",
      "codex_exec",
      "browser_external",
      "write_command",
    ]);
  });
});
