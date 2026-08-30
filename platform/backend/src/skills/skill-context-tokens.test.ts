import { describe, expect, test } from "@/test";
import { measureSkillContextTokens } from "./skill-context-tokens";

describe("measureSkillContextTokens", () => {
  test("uses the resolved model's tokenizer", () => {
    const block = `export function resolveTargets(modelId: string) {
  const withoutRegion = modelId.replace(REGION_PREFIX, "");
  return withoutRegion;
}
`.repeat(60);

    expect(
      measureSkillContextTokens({
        block,
        provider: "bedrock",
        model: "us.anthropic.claude-opus-4-8",
      }),
    ).toBe(2101);
    expect(
      measureSkillContextTokens({
        block,
        provider: "bedrock",
        model: "us.amazon.nova-pro-v1:0",
      }),
    ).toBe(1741);
  });

  test("uses the default cl100k_base tokenizer without a resolved model", () => {
    expect(
      measureSkillContextTokens({
        block: "# Skill\nsome instructions",
      }),
    ).toBe(6);
  });

  test("measures a fixed Anthropic block", () => {
    expect(
      measureSkillContextTokens({
        block: "# Skill\nUse pdftotext -layout.",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
      }),
    ).toBe(12);
  });

  test("returns null for an empty block rather than a misleading zero cost", () => {
    expect(measureSkillContextTokens({ block: "" })).toBeNull();
  });
});
