import { TOOL_LOAD_SKILL_FULL_NAME } from "@archestra/shared";
import { describe, expect, it } from "vitest";
import {
  buildSkillDescriptionPrompt,
  type DescribableAgent,
  sanitizeDescription,
} from "./skill-description";

function makeAgent(
  overrides: Partial<DescribableAgent> = {},
): DescribableAgent {
  return {
    id: "agent-1",
    name: "Support Helper",
    description: "Helps with support tickets",
    systemPrompt: "You are a support assistant. Be concise and kind.",
    tools: [],
    suggestedPrompts: [],
    llmApiKeyId: null,
    modelId: null,
    ...overrides,
  };
}

describe("buildSkillDescriptionPrompt", () => {
  it("includes the agent name, description, and system prompt", () => {
    const prompt = buildSkillDescriptionPrompt(makeAgent());

    expect(prompt).toContain("Agent name: Support Helper");
    expect(prompt).toContain(
      "Existing description: Helps with support tickets",
    );
    expect(prompt).toContain("You are a support assistant.");
  });

  it("omits empty optional sections", () => {
    const prompt = buildSkillDescriptionPrompt(
      makeAgent({ description: null, systemPrompt: null }),
    );

    expect(prompt).toBe("Agent name: Support Helper");
  });

  it("lists tools but excludes skill-runtime tools", () => {
    const prompt = buildSkillDescriptionPrompt(
      makeAgent({
        tools: [{ name: "slack__send" }, { name: TOOL_LOAD_SKILL_FULL_NAME }],
      }),
    );

    expect(prompt).toContain("slack__send");
    expect(prompt).not.toContain(TOOL_LOAD_SKILL_FULL_NAME);
  });

  it("lists suggested prompts as examples", () => {
    const prompt = buildSkillDescriptionPrompt(
      makeAgent({
        suggestedPrompts: [
          { summaryTitle: "Refund", prompt: "How do I issue a refund?" },
        ],
      }),
    );

    expect(prompt).toContain("Refund: How do I issue a refund?");
  });

  it("truncates an oversized system prompt", () => {
    const prompt = buildSkillDescriptionPrompt(
      makeAgent({ systemPrompt: "x".repeat(5000) }),
    );

    expect(prompt).toContain("…");
    expect(prompt.length).toBeLessThan(5000);
  });
});

describe("sanitizeDescription", () => {
  it("collapses whitespace into a single line", () => {
    expect(sanitizeDescription("Drafts replies\n  to  tickets.")).toBe(
      "Drafts replies to tickets.",
    );
  });

  it("strips wrapping quotes and backticks", () => {
    expect(sanitizeDescription('"Reviews pull requests."')).toBe(
      "Reviews pull requests.",
    );
    expect(sanitizeDescription("`Summarizes logs.`")).toBe("Summarizes logs.");
  });

  it("caps an overlong response at the spec limit", () => {
    expect(sanitizeDescription("x".repeat(2000)).length).toBe(1024);
  });
});
