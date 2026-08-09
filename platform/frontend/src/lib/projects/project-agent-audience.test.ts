import { describe, expect, it } from "vitest";
import { agentsForProjectAudience } from "./project-agent-audience";

const orgAgent = { id: "org", scope: "org" as const };
const teamAgent = {
  id: "team-ab",
  scope: "team" as const,
  teams: [
    { id: "team-a", name: "A" },
    { id: "team-b", name: "B" },
  ],
};
const teamAOnly = {
  id: "team-a-only",
  scope: "team" as const,
  teams: [{ id: "team-a", name: "A" }],
};
const personalAgent = {
  id: "personal",
  scope: "personal" as const,
  authorId: "author",
  users: [{ id: "granted" }],
};

const agents = [orgAgent, teamAgent, teamAOnly, personalAgent];

const ids = (result: Array<{ id: string }>) => result.map((a) => a.id);

describe("agentsForProjectAudience", () => {
  it("offers everything the owner can use on an unshared project", () => {
    expect(
      ids(
        agentsForProjectAudience(agents, {
          share: { visibility: "none", teamIds: [], userIds: [] },
          editorIsOwner: true,
        }),
      ),
    ).toEqual(["org", "team-ab", "team-a-only", "personal"]);
  });

  it("falls back to org agents when an admin edits someone else's unshared project", () => {
    // The list is filtered to what the admin can reach, which says nothing
    // about what the owner can reach.
    expect(
      ids(
        agentsForProjectAudience(agents, {
          share: { visibility: "none", teamIds: [], userIds: [] },
          editorIsOwner: false,
        }),
      ),
    ).toEqual(["org"]);
  });

  it("offers only org agents once the project is org-wide", () => {
    expect(
      ids(
        agentsForProjectAudience(agents, {
          share: { visibility: "organization", teamIds: [], userIds: [] },
          editorIsOwner: true,
        }),
      ),
    ).toEqual(["org"]);
  });

  it("requires a team agent to cover every shared team", () => {
    expect(
      ids(
        agentsForProjectAudience(agents, {
          share: {
            visibility: "team",
            teamIds: ["team-a", "team-b"],
            userIds: [],
          },
          editorIsOwner: true,
        }),
      ),
    ).toEqual(["org", "team-ab"]);
  });

  it("keeps a team agent that covers the single shared team", () => {
    expect(
      ids(
        agentsForProjectAudience(agents, {
          share: { visibility: "team", teamIds: ["team-a"], userIds: [] },
          editorIsOwner: true,
        }),
      ),
    ).toEqual(["org", "team-ab", "team-a-only"]);
  });

  it("offers no team agent while the team share names no team yet", () => {
    expect(
      ids(
        agentsForProjectAudience(agents, {
          share: { visibility: "team", teamIds: [], userIds: [] },
          editorIsOwner: true,
        }),
      ),
    ).toEqual(["org"]);
  });

  it("requires a personal agent to reach every named user", () => {
    expect(
      ids(
        agentsForProjectAudience(agents, {
          share: {
            visibility: "user",
            teamIds: [],
            userIds: ["author", "granted"],
          },
          editorIsOwner: true,
        }),
      ),
    ).toEqual(["org", "personal"]);

    expect(
      ids(
        agentsForProjectAudience(agents, {
          share: {
            visibility: "user",
            teamIds: [],
            userIds: ["author", "stranger"],
          },
          editorIsOwner: true,
        }),
      ),
    ).toEqual(["org"]);
  });

  it("withholds team agents from a named-user share, whose membership it cannot check", () => {
    expect(
      ids(
        agentsForProjectAudience(agents, {
          share: { visibility: "user", teamIds: [], userIds: ["granted"] },
          editorIsOwner: true,
        }),
      ),
    ).not.toContain("team-ab");
  });
});
