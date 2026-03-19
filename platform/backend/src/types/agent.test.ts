import { BUILT_IN_AGENT_IDS } from "@shared";
import { describe, expect, test } from "@/test";
import { BuiltInAgentConfigSchema } from "./agent";

describe("BuiltInAgentConfigSchema", () => {
  test("requires maxRounds to be an integer for dual LLM main agent config", () => {
    const valid = BuiltInAgentConfigSchema.safeParse({
      name: BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN,
      maxRounds: 5,
    });
    const invalid = BuiltInAgentConfigSchema.safeParse({
      name: BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN,
      maxRounds: 5.5,
    });

    expect(valid.success).toBe(true);
    expect(invalid.success).toBe(false);
  });
});
