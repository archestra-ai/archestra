import {
  TOOL_ACTIVATE_SKILL_FULL_NAME,
  TOOL_CREATE_SKILL_FULL_NAME,
  TOOL_LIST_SKILLS_FULL_NAME,
  TOOL_READ_SKILL_FILE_FULL_NAME,
  TOOL_UPDATE_SKILL_FULL_NAME,
} from "@shared";
import { describe, expect, it } from "vitest";
import {
  agentToSkill,
  type MigratableAgent,
  SKILL_ORIGIN_AGENT,
} from "./agent-migration";

function makeMigratableAgent(
  overrides: Partial<MigratableAgent> = {},
): MigratableAgent {
  return {
    id: "agent-1",
    name: "Support Helper",
    description: "Helps with support tickets",
    systemPrompt: "You are a support assistant. Be concise and kind.",
    icon: null,
    scope: "personal",
    modelId: null,
    llmModel: null,
    tools: [],
    teams: [],
    labels: [],
    suggestedPrompts: [],
    knowledgeBaseIds: [],
    connectorIds: [],
    ...overrides,
  };
}

describe("agentToSkill", () => {
  it("carries clean fields and keeps the system prompt as the body", () => {
    const { draft, report } = agentToSkill(makeMigratableAgent());

    expect(draft.name).toBe("support-helper");
    expect(draft.description).toBe("Helps with support tickets");
    expect(draft.content).toBe(
      "You are a support assistant. Be concise and kind.",
    );
    expect(draft.scope).toBe("personal");
    expect(report.carried.map((field) => field.field)).toEqual(
      expect.arrayContaining(["description", "systemPrompt"]),
    );
    // scope is a persistence-surface concern; the transform leaves it to callers.
    expect(report.carried.map((field) => field.field)).not.toContain("scope");
    expect(report.annotated.map((field) => field.field)).not.toContain("scope");
  });

  it("records provenance in metadata", () => {
    const { draft } = agentToSkill(makeMigratableAgent({ id: "abc-123" }));

    expect(draft.metadata.origin).toBe(SKILL_ORIGIN_AGENT);
    expect(draft.metadata.originAgentId).toBe("abc-123");
  });

  it("normalizes a display name into a slash-command-safe slug", () => {
    const { draft, report } = agentToSkill(
      makeMigratableAgent({ name: "My Sales Agent!!" }),
    );

    expect(draft.name).toBe("my-sales-agent");
    expect(report.annotated.map((field) => field.field)).toContain("name");
  });

  it("falls back to a stable name when the agent name slugifies to nothing", () => {
    const { draft } = agentToSkill(makeMigratableAgent({ name: "🤖🤖" }));
    expect(draft.name).toBe("migrated-agent");
  });

  it("prefers an explicit description override and reports it carried", () => {
    const { draft, report } = agentToSkill(
      makeMigratableAgent({ description: "stale" }),
      { description: "  A crisp, user-written description  " },
    );

    expect(draft.description).toBe("A crisp, user-written description");
    expect(report.carried.map((field) => field.field)).toContain("description");
  });

  it("falls back to the agent name (never a migration line) when no description is available", () => {
    const { draft, report } = agentToSkill(
      makeMigratableAgent({ name: "Helper", description: null }),
    );

    expect(draft.description).toBe("Helper");
    expect(draft.description).not.toContain("Migrated");
    expect(report.annotated.map((field) => field.field)).toContain(
      "description",
    );
  });

  it("lists tools as recommended and reports model/knowledge as not carried", () => {
    const { draft, report } = agentToSkill(
      makeMigratableAgent({
        tools: [{ name: "slack__send" }, { name: "github__pr" }],
        modelId: "model-1",
        knowledgeBaseIds: ["kb-1", "kb-2"],
        connectorIds: ["conn-1"],
      }),
    );

    expect(draft.content).toContain("## Recommended tools");
    expect(draft.content).toContain("- slack__send");
    expect(draft.content).toContain("- github__pr");
    // the migration is never mentioned in the body; downstream agents don't care.
    expect(draft.content).not.toContain("Migrated");
    expect(draft.content).not.toContain("## Requirements");
    // model/knowledge have no skill equivalent and stay out of the body.
    expect(draft.content).not.toContain("Knowledge");
    expect(draft.metadata.originAgentModelId).toBe("model-1");
    expect(report.carried.map((field) => field.field)).toContain("tools");
    expect(report.annotated.map((field) => field.field)).toEqual(
      expect.arrayContaining(["modelId", "knowledgeBaseIds", "connectorIds"]),
    );
  });

  it("omits the Recommended tools section when the agent has no tools", () => {
    const { draft } = agentToSkill(makeMigratableAgent());
    expect(draft.content).not.toContain("## Recommended tools");
  });

  it("excludes the whole skill toolset from the recommended list", () => {
    const skillTools = [
      TOOL_ACTIVATE_SKILL_FULL_NAME,
      TOOL_READ_SKILL_FILE_FULL_NAME,
      TOOL_LIST_SKILLS_FULL_NAME,
      TOOL_CREATE_SKILL_FULL_NAME,
      TOOL_UPDATE_SKILL_FULL_NAME,
    ];
    const { draft } = agentToSkill(
      makeMigratableAgent({
        tools: [
          ...skillTools.map((name) => ({ name })),
          { name: "slack__send" },
        ],
      }),
    );

    expect(draft.content).toContain("- slack__send");
    for (const name of skillTools) {
      expect(draft.content).not.toContain(name);
    }
  });

  it("excludes skill tools carrying a white-labeled prefix", () => {
    // white-labeled orgs store skill tools under a branded prefix; only the
    // short name is stable, so filtering must be prefix-agnostic.
    const { draft } = agentToSkill(
      makeMigratableAgent({
        tools: [{ name: "mycorp__create_skill" }, { name: "slack__send" }],
      }),
    );

    expect(draft.content).toContain("- slack__send");
    expect(draft.content).not.toContain("mycorp__create_skill");
  });

  it("omits the Recommended tools section when only skill-runtime tools are present", () => {
    const { draft } = agentToSkill(
      makeMigratableAgent({
        tools: [
          { name: TOOL_ACTIVATE_SKILL_FULL_NAME },
          { name: TOOL_READ_SKILL_FILE_FULL_NAME },
        ],
      }),
    );
    expect(draft.content).not.toContain("## Recommended tools");
  });

  it("lists suggested prompts as examples", () => {
    const { draft } = agentToSkill(
      makeMigratableAgent({
        suggestedPrompts: [
          { summaryTitle: "Refund", prompt: "How do I issue a refund?" },
        ],
      }),
    );

    expect(draft.content).toContain("## Example prompts");
    expect(draft.content).toContain("Refund: How do I issue a refund?");
  });

  it("copies labels and icon into metadata", () => {
    const { draft } = agentToSkill(
      makeMigratableAgent({
        icon: "🎧",
        labels: [{ key: "team", value: "support" }],
      }),
    );

    expect(draft.metadata.icon).toBe("🎧");
    expect(draft.metadata.team).toBe("support");
  });

  it("synthesizes a body when the agent has no system prompt and no bindings", () => {
    const { draft, report } = agentToSkill(
      makeMigratableAgent({ name: "Empty", systemPrompt: null }),
    );

    expect(draft.content).toBe("# empty\n\nHelps with support tickets");
    expect(report.annotated.map((field) => field.field)).toContain(
      "systemPrompt",
    );
  });

  it("carries teams only for team-scoped agents", () => {
    const teamScoped = agentToSkill(
      makeMigratableAgent({
        scope: "team",
        teams: [{ id: "team-1" }, { id: "team-2" }],
      }),
    );
    expect(teamScoped.teamIds).toEqual(["team-1", "team-2"]);

    const personalScoped = agentToSkill(
      makeMigratableAgent({ scope: "personal", teams: [{ id: "team-1" }] }),
    );
    expect(personalScoped.teamIds).toEqual([]);
  });
});
