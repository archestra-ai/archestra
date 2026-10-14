// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  filterAndSortInitialAgents,
  groupInitialAgents,
} from "./initial-agent-selector.utils";

const userId = "user-1";

function makeAgent(
  overrides: Partial<{
    builtIn: boolean;
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
    runtime: null,
    builtIn: overrides.builtIn ?? false,
  };
}

describe("filterAndSortInitialAgents", () => {
  it("hides built-ins even when selected or matched by search", () => {
    const agents = [
      makeAgent({ id: "builtin", name: "APPA Keeper", builtIn: true }),
      makeAgent({
        id: "personal",
        name: "My Assistant",
        scope: "personal",
        authorId: userId,
      }),
    ];
    expect(
      filterAndSortInitialAgents({
        allAgents: agents,
        currentAgentId: "builtin",
        search: "",
        userId,
      }).map((agent) => agent.id),
    ).toEqual(["personal"]);
    expect(
      filterAndSortInitialAgents({
        allAgents: agents,
        currentAgentId: "builtin",
        search: "APPA Keeper",
        userId,
      }),
    ).toEqual([]);
  });
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

  it("puts the current agent first even if it is a shared agent", () => {
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

    expect(result.map((agent) => agent.id)).toEqual(["shared", "personal"]);
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

describe("groupInitialAgents", () => {
  it("splits the user's own agents from shared ones, keeping the sort order", () => {
    const mine = makeAgent({ id: "mine", scope: "personal", authorId: userId });
    const team = makeAgent({ id: "team", scope: "team" });
    const org = makeAgent({ id: "org", scope: "org" });

    const groups = groupInitialAgents({ agents: [team, mine, org], userId });

    expect(
      groups.map((group) => ({
        label: group.label,
        ids: group.agents.map((agent) => agent.id),
      })),
    ).toEqual([
      { label: "Yours", ids: ["mine"] },
      { label: "Shared with you", ids: ["team", "org"] },
    ]);
  });

  it("puts pinned agents first, newest pin first, and out of their own group", () => {
    const mine = makeAgent({ id: "mine", scope: "personal", authorId: userId });
    const minePinned = makeAgent({
      id: "mine-pinned",
      scope: "personal",
      authorId: userId,
    });
    const orgPinned = makeAgent({ id: "org-pinned", scope: "org" });
    const org = makeAgent({ id: "org", scope: "org" });

    const groups = groupInitialAgents({
      agents: [minePinned, mine, orgPinned, org],
      userId,
      pinnedIds: ["org-pinned", "mine-pinned"],
    });

    expect(
      groups.map((group) => ({
        label: group.label,
        ids: group.agents.map((agent) => agent.id),
      })),
    ).toEqual([
      { label: "Pinned", ids: ["org-pinned", "mine-pinned"] },
      { label: "Yours", ids: ["mine"] },
      { label: "Shared with you", ids: ["org"] },
    ]);
  });

  it("drops a group with nothing in it", () => {
    const groups = groupInitialAgents({
      agents: [makeAgent({ id: "org", scope: "org" })],
      userId,
    });

    expect(groups.map((group) => group.label)).toEqual(["Shared with you"]);
  });
});
