// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  groupInitialAgents,
  matchesAgentSearch,
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

describe("matchesAgentSearch", () => {
  it("matches the name or the description, ignoring case and edges", () => {
    const agent = makeAgent({
      id: "a",
      name: "Alpha Agent",
      description: "Handles Billing questions",
    });
    expect(matchesAgentSearch(agent, "alpha")).toBe(true);
    expect(matchesAgentSearch(agent, "  BILLING ")).toBe(true);
    expect(matchesAgentSearch(agent, "gamma")).toBe(false);
  });

  it("matches everything when the search is blank", () => {
    const agent = makeAgent({ id: "a", name: "Alpha", description: null });
    expect(matchesAgentSearch(agent, "")).toBe(true);
    expect(matchesAgentSearch(agent, "   ")).toBe(true);
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
