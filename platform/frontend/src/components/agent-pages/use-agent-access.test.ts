import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useMyTeams } from "@/lib/teams/team.query";
import { computeCanModifyAgent, useAgentAccess } from "./use-agent-access";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/teams/team.query");

const teams = new Set(["team-a"]);

describe("computeCanModifyAgent", () => {
  it("lets a resource admin modify anything", () => {
    expect(
      computeCanModifyAgent({
        agent: { scope: "org", authorId: "someone-else", teams: [] },
        isAdmin: true,
        isTeamAdmin: false,
        currentUserId: "me",
        userTeamIds: teams,
      }),
    ).toBe(true);
  });

  it("lets a team admin modify a team-scoped row of a team they belong to", () => {
    const base = {
      isAdmin: false,
      isTeamAdmin: true,
      currentUserId: "me",
      userTeamIds: teams,
    };
    expect(
      computeCanModifyAgent({
        ...base,
        agent: { scope: "team", authorId: null, teams: [{ id: "team-a" }] },
      }),
    ).toBe(true);
    expect(
      computeCanModifyAgent({
        ...base,
        agent: { scope: "team", authorId: null, teams: [{ id: "team-b" }] },
      }),
    ).toBe(false);
  });

  it("lets everyone modify their own personal rows and nobody else's", () => {
    const base = {
      isAdmin: false,
      isTeamAdmin: false,
      currentUserId: "me",
      userTeamIds: teams,
    };
    expect(
      computeCanModifyAgent({
        ...base,
        agent: { scope: "personal", authorId: "me", teams: [] },
      }),
    ).toBe(true);
    expect(
      computeCanModifyAgent({
        ...base,
        agent: { scope: "personal", authorId: "them", teams: [] },
      }),
    ).toBe(false);
    expect(
      computeCanModifyAgent({
        ...base,
        agent: { scope: "org", authorId: "me", teams: [] },
      }),
    ).toBe(false);
  });

  it("answers false while there is no agent to check", () => {
    expect(
      computeCanModifyAgent({
        agent: null,
        isAdmin: true,
        isTeamAdmin: true,
        currentUserId: "me",
        userTeamIds: teams,
      }),
    ).toBe(false);
  });
});

describe("useAgentAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "me" } },
    } as unknown as ReturnType<typeof useSession>);
    vi.mocked(useMyTeams).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useMyTeams>);
  });

  it("checks a legacy profile against agent permissions, not the facade it is shown under", () => {
    const profile = {
      scope: "personal" as const,
      authorId: "me",
      teams: [],
      agentType: "profile" as const,
    };

    grantPermissions({ agent: ["update"] });
    expect(
      renderHook(() => useAgentAccess(profile, "llm_proxy")).result.current
        .canEdit,
    ).toBe(true);

    // The route family alone would have asked `llmProxy` and got it wrong.
    grantPermissions({ llmProxy: ["update", "admin"] });
    expect(
      renderHook(() => useAgentAccess(profile, "llm_proxy")).result.current
        .canEdit,
    ).toBe(false);
  });

  it("lets only a resource admin edit a built-in agent", () => {
    const builtIn = {
      scope: "org" as const,
      authorId: null,
      teams: [],
      builtIn: true,
      agentType: "agent" as const,
    };

    grantPermissions({ agent: ["update"] });
    expect(
      renderHook(() => useAgentAccess(builtIn, "agent")).result.current.canEdit,
    ).toBe(false);

    grantPermissions({ agent: ["update", "admin"] });
    expect(
      renderHook(() => useAgentAccess(builtIn, "agent")).result.current.canEdit,
    ).toBe(true);
  });
});

/** Answers `useHasPermissions` from a resource → allowed actions table. */
function grantPermissions(granted: Record<string, string[]>) {
  vi.mocked(useHasPermissions).mockImplementation((permissionsToCheck) => {
    const allowed = Object.entries(permissionsToCheck).every(
      ([resource, actions]) =>
        (actions as string[]).every((action) =>
          granted[resource]?.includes(action),
        ),
    );
    return { data: allowed, isPending: false } as unknown as ReturnType<
      typeof useHasPermissions
    >;
  });
}
