import { describe, expect, it } from "bun:test";
import {
  deriveContextTags,
  normalizeContextSourcePayload,
  readPersistedJSON,
  runContextAction,
  upsertContextInboxItem,
  writePersistedJSON,
} from "../web/context-actions.js";

describe("context action router core behavior", () => {
  it("maps every allowlisted action to the expected prefill/capture effect", () => {
    const calls: Array<{ type: string; payload: any }> = [];
    const handlers = {
      setComposerDraft: (payload: any) => calls.push({ type: "composer", payload }),
      prefillPlannerGoal: (payload: any) => calls.push({ type: "planner", payload }),
      prefillMissionQuery: (payload: any) => calls.push({ type: "mission", payload }),
      prefillCommandStudio: (payload: any) => calls.push({ type: "command", payload }),
      prefillChatPrompt: (payload: any) => calls.push({ type: "chat", payload }),
      captureKnowledge: (payload: any) => calls.push({ type: "knowledge", payload }),
    };

    const baseContext = {
      selectionText: "AI trend signal to act on today.",
      pageURL: "https://x.com/home",
      sourceHint: "test",
    };

    const expectations: Array<[string, string]> = [
      ["post.append_to_composer", "composer.append"],
      ["post.replace_composer", "composer.replace"],
      ["post.build_thread_outline", "composer.thread_outline"],
      ["tools.prefill_planner_goal", "planner.prefill_goal"],
      ["tools.prefill_mission_query", "mission.prefill_query"],
      ["tools.prefill_command_studio", "command.prefill"],
      ["knowledge.capture", "knowledge.capture"],
      ["chat.prefill_prompt", "chat.prefill"],
    ];

    expectations.forEach(([actionId, effect]) => {
      const result = runContextAction(actionId, baseContext, handlers);
      expect(result.ok).toBe(true);
      expect(result.effect).toBe(effect);
    });

    expect(calls.find((call) => call.type === "composer" && call.payload.mode === "append")).toBeTruthy();
    expect(calls.find((call) => call.type === "planner")).toBeTruthy();
    expect(calls.find((call) => call.type === "mission")).toBeTruthy();
    expect(calls.find((call) => call.type === "command")).toBeTruthy();
    expect(calls.find((call) => call.type === "chat")).toBeTruthy();
    expect(calls.find((call) => call.type === "knowledge")).toBeTruthy();
  });

  it("safely ignores unknown actions", () => {
    const result = runContextAction("tools.unknown_action", { selectionText: "hello" }, {});
    expect(result.ok).toBe(false);
    expect(result.ignored).toBe(true);
    expect(result.reason).toBe("unknown_action");
  });

  it("produces deterministic auto tags and normalized context shape", () => {
    const context = normalizeContextSourcePayload({
      selectionText: "trend prompt tweet",
      linkURL: "https://x.com/example",
      sourceHint: "spec",
      x: "10",
      y: "20",
    });
    expect(context.selectionText).toBe("trend prompt tweet");
    expect(context.linkURL).toBe("https://x.com/example");
    expect(context.sourceHint).toBe("spec");
    expect(context.x).toBe(10);
    expect(context.y).toBe(20);
    expect(deriveContextTags("knowledge.capture", context)).toEqual([
      "knowledge",
      "link",
      "trend",
      "prompt",
      "tweet",
    ]);
  });
});

describe("context local persistence helpers", () => {
  it("writes and reads storage payloads with fallback safety", () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value);
      },
    };

    writePersistedJSON(storage, "k", { ok: true, n: 3 });
    expect(readPersistedJSON(storage, "k", null)).toEqual({ ok: true, n: 3 });

    memory.set("broken", "{not-json");
    expect(readPersistedJSON(storage, "broken", { fallback: true })).toEqual({ fallback: true });
  });

  it("keeps inbox ordering deterministic with pinned items first", () => {
    let list: any[] = [];
    list = upsertContextInboxItem(list, {
      id: "old",
      text: "old context",
      tags: ["tweet"],
      source: "first",
      createdAt: "2026-01-01T00:00:00.000Z",
      pinned: false,
    });
    list = upsertContextInboxItem(list, {
      id: "new-pinned",
      text: "new context",
      tags: ["mission"],
      source: "second",
      createdAt: "2026-01-02T00:00:00.000Z",
      pinned: true,
    });
    expect(list[0].id).toBe("new-pinned");
    expect(list[1].id).toBe("old");
  });
});
