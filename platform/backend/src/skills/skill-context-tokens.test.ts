import { describe, expect, test } from "@/test";
import { measureSkillContextTokens } from "./skill-context-tokens";

describe("measureSkillContextTokens", () => {
  test("measures a block's size and scales with its length", () => {
    const short = measureSkillContextTokens({
      block: "# Skill\nUse pdftotext -layout.",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
    const long = measureSkillContextTokens({
      block: "# Skill\nUse pdftotext -layout.\n".repeat(50),
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });

    expect(short).toBeGreaterThan(0);
    expect(long).toBeGreaterThan((short ?? 0) * 10);
  });

  test("falls back to the default tokenizer when no model is resolved", () => {
    // `load_skill` over the gateway and subagent dispatch have no model in hand;
    // a measurement is still better than none.
    expect(
      measureSkillContextTokens({ block: "# Skill\nsome instructions" }),
    ).toBeGreaterThan(0);
  });

  test("returns null for an empty block rather than a misleading zero cost", () => {
    expect(measureSkillContextTokens({ block: "" })).toBeNull();
  });
});
