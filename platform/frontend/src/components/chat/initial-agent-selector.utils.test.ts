import { describe, expect, it } from "vitest";
import { filterAndSortInitialAgents } from "./initial-agent-selector.utils";

const userId = "user-1";

function makeAgent(
  overrides: Partial<{
    id: string;
    name: string;
    scope: "personal" | "team" | "org";
    authorId: string | null;
    description: string | null;
    icon: string | null;
    systemPrompt: string | null;
  }> = {},
) {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    name: overrides.name ?? "Agent",
    scope: overrides.scope ?? "org",
    authorId: overrides.authorId ?? null,
    description: overrides.description ?? null,
    icon: overrides.icon ?? null,
    systemPrompt: overrides.systemPrompt ?? null,
  };
}

describe("filterAndSortInitialAgents", () => {
  it("shows only the current user's personal agents", () => {
    const agents = [
      makeAgent({
        id: "mine",
        name: "My Personal Agent",
        scope: "personal",
        authorId: userId,
      }),
      makeAgent({
        id: "other",
        name: "Other Personal Agent",
        scope: "personal",
        authorId: "user-2",
      }),
      makeAgent({ id: "shared", name: "Shared Agent", scope: "org" }),
    ];

    const result = filterAndSortInitialAgents({
      allAgents: agents,
      currentAgentId: null,
      search: "",
      userId,
    });

    expect(result.map((agent) => agent.id)).toEqual(["mine", "shared"]);
  });

  it("prioritizes the current user's personal agent over the selected shared agent", () => {
    const agents = [
      makeAgent({
        id: "shared",
        name: "Alpha Shared Agent",
        scope: "org",
      }),
      makeAgent({
        id: "personal",
        name: "Zulu Personal Agent",
        scope: "personal",
        authorId: userId,
      }),
    ];

    const result = filterAndSortInitialAgents({
      allAgents: agents,
      currentAgentId: "shared",
      search: "",
      userId,
    });

    expect(result.map((agent) => agent.id)).toEqual(["personal", "shared"]);
  });

  it("keeps the selected non-personal agent first after the personal-agent priority", () => {
    const agents = [
      makeAgent({
        id: "org-selected",
        name: "Zulu Org Agent",
        scope: "org",
      }),
      makeAgent({
        id: "team",
        name: "Alpha Team Agent",
        scope: "team",
      }),
      makeAgent({
        id: "org-other",
        name: "Alpha Org Agent",
        scope: "org",
      }),
    ];

    const result = filterAndSortInitialAgents({
      allAgents: agents,
      currentAgentId: "org-selected",
      search: "",
      userId,
    });

    expect(result.map((agent) => agent.id)).toEqual([
      "org-selected",
      "team",
      "org-other",
    ]);
  });

  it("filters by name and description case-insensitively", () => {
    const agents = [
      makeAgent({
        id: "name-match",
        name: "Database Helper",
        scope: "org",
      }),
      makeAgent({
        id: "description-match",
        name: "Support Agent",
        description: "Finds DATABASE issues",
        scope: "team",
      }),
      makeAgent({
        id: "no-match",
        name: "Calendar Agent",
        scope: "org",
      }),
    ];

    const result = filterAndSortInitialAgents({
      allAgents: agents,
      currentAgentId: null,
      search: "database",
      userId,
    });

    expect(result.map((agent) => agent.id)).toEqual([
      "description-match",
      "name-match",
    ]);
  });

  it("falls back to alphabetical order inside the same scope", () => {
    const agents = [
      makeAgent({ id: "z", name: "Zulu Team Agent", scope: "team" }),
      makeAgent({ id: "a", name: "Alpha Team Agent", scope: "team" }),
      makeAgent({ id: "m", name: "Mike Team Agent", scope: "team" }),
    ];

    const result = filterAndSortInitialAgents({
      allAgents: agents,
      currentAgentId: null,
      search: "",
      userId,
    });

    expect(result.map((agent) => agent.id)).toEqual(["a", "m", "z"]);
  });
});
