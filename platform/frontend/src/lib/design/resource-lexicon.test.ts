import { describe, expect, it } from "vitest";
import { AGENT_PAGE_CONFIGS } from "@/components/agent-pages/agent-page-config";
import {
  ACTION_LABEL,
  backToListLabel,
  backToRecordLabel,
  FIELD_LABEL,
  notYoursToChange,
  RESOURCE_LEXICON,
  type ResourceKey,
} from "./resource-lexicon";

const RESOURCES = Object.keys(RESOURCE_LEXICON) as ResourceKey[];

/**
 * The lexicon's job is that five surfaces cannot disagree. These pin the four
 * ways they used to: a second spelling of a name, a pluralised field label, a
 * back link that does not match the list it returns to, and a second phrasing
 * of the same date.
 */
describe("resource lexicon", () => {
  it("covers the five entity surfaces", () => {
    expect(RESOURCES).toEqual([
      "agent",
      "llm_proxy",
      "mcp_gateway",
      "skill",
      "mcp_server",
    ]);
  });

  it("takes the agent-shaped names from the route configs rather than repeating them", () => {
    for (const kind of ["agent", "llm_proxy", "mcp_gateway"] as const) {
      expect(RESOURCE_LEXICON[kind]).toEqual({
        singular: AGENT_PAGE_CONFIGS[kind].singular,
        singularInSentence: AGENT_PAGE_CONFIGS[kind].singularInSentence,
        plural: AGENT_PAGE_CONFIGS[kind].plural,
      });
    }
  });

  it("builds the detail page's back link from the plural the list is titled with", () => {
    for (const resource of RESOURCES) {
      expect(backToListLabel(resource)).toBe(RESOURCE_LEXICON[resource].plural);
    }
    expect(backToListLabel("skill")).toBe("Skills");
    // The wizard returns to the record, so it is the only one that says "Back to".
    expect(backToRecordLabel("skill")).toBe("Back to skill");
    expect(backToRecordLabel("mcp_gateway")).toBe("Back to MCP gateway");
  });

  it("keeps the environment field singular, on every surface", () => {
    // The agents list said "Environment" and a skill said "Environments",
    // which read as two different fields.
    expect(FIELD_LABEL.environment).toBe("Environment");
  });

  it("names, for each scope, the people who can actually change the record", () => {
    // The backend admits a team admin only for a team-scoped record they are a
    // member of, and nobody but a resource admin for an org-scoped one
    // (`requireScopedModifyPermission`). One sentence for all three scopes
    // sent the reader of an org-scoped record to a team admin who would be
    // refused exactly as they were.
    expect(notYoursToChange({ resource: "skill", scope: "personal" })).toBe(
      "Only this skill's author or an admin can change it",
    );
    expect(notYoursToChange({ resource: "skill", scope: "team" })).toBe(
      "Only this skill's author, a team admin of the teams it is shared with, or an admin can change it",
    );
    expect(notYoursToChange({ resource: "skill", scope: "org" })).toBe(
      "Only an admin can change this org-wide skill",
    );
  });

  it("spells the acronyms the way the lexicon does, in the refusal too", () => {
    // Lowercasing a title-case plural produced "mcp gateways" on the detail
    // header, which is the drift the lexicon exists to stop.
    expect(notYoursToChange({ resource: "mcp_gateway", scope: "org" })).toBe(
      "Only an admin can change this org-wide MCP gateway",
    );
    expect(notYoursToChange({ resource: "llm_proxy", scope: "personal" })).toBe(
      "Only this LLM proxy's author or an admin can change it",
    );
  });

  it("names each shared verb once", () => {
    const labels = Object.values(ACTION_LABEL);
    expect(new Set(labels).size).toBe(labels.length);
    // The label a skill's Chat used to carry was "Chat with a skill", which is
    // the same verb as an agent's "Chat" wearing the object in its name.
    expect(ACTION_LABEL.chat).toBe("Chat");
  });
});
