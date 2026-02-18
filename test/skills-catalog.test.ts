import { describe, expect, it } from "bun:test";

import { getSkillDefinition, skillCatalog } from "../src/skills/catalog.ts";
import type { SkillId } from "../src/types.ts";

describe("skills/catalog", () => {
  it("contains unique skill ids", () => {
    const ids = skillCatalog.map((skill) => skill.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolves core skills by id", () => {
    const required: SkillId[] = [
      "antigravity.open",
      "terminal.run_command",
      "codex.run_task",
      "claude.run_task",
      "x-social.run_endpoint",
      "code-workspace.exec",
      "workspace.tree",
      "git.status",
    ];

    required.forEach((id) => {
      const definition = getSkillDefinition(id);
      expect(definition).toBeDefined();
      expect(definition?.id).toBe(id);
      expect(definition?.title.length).toBeGreaterThan(0);
    });
  });
});
