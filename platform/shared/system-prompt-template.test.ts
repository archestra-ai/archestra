import { describe, expect, test } from "vitest";
import { BUILT_IN_AGENT_IDS } from "./built-in-agents";
import {
  getSystemPromptTemplateExpressions,
  SYSTEM_PROMPT_TEMPLATE_EXPRESSIONS,
} from "./system-prompt-template";

describe("getSystemPromptTemplateExpressions", () => {
  test("returns shared expressions by default", () => {
    expect(getSystemPromptTemplateExpressions()).toEqual(
      SYSTEM_PROMPT_TEMPLATE_EXPRESSIONS,
    );
  });

  test("adds policy configuration expressions for the policy built-in agent", () => {
    const expressions = getSystemPromptTemplateExpressions({
      builtInAgentId: BUILT_IN_AGENT_IDS.POLICY_CONFIG,
    });

    expect(expressions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expression: "{{tool.name}}",
        }),
        expect.objectContaining({
          expression: "{{tool.description}}",
        }),
        expect.objectContaining({
          expression: "{{tool.parameters}}",
        }),
        expect.objectContaining({
          expression: "{{tool.annotations}}",
        }),
        expect.objectContaining({
          expression: "{{mcpServerName}}",
        }),
      ]),
    );
  });
});
