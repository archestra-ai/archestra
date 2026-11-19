import { vi } from "vitest";
import TeamModel from "@/models/team";
import { describe, expect, test } from "@/test";
import {
  filterMcpServersAssignableToTarget,
  isMcpServerAssignableToTarget,
} from "./mcp-server-assignability";

describe("filterMcpServersAssignableToTarget", () => {
  test("drops every personal connection without membership lookups", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const memberOwner = await makeUser();
    const outsideOwner = await makeUser();
    const filtered = await filterMcpServersAssignableToTarget({
      mcpServers: [
        {
          id: "member-owned",
          ownerId: memberOwner.id,
          teamId: null,
          scope: "personal",
        },
        {
          id: "outside-owned",
          ownerId: outsideOwner.id,
          teamId: null,
          scope: "personal",
        },
        { id: "org-owned", ownerId: null, teamId: null, scope: "org" },
      ],
      target: {
        organizationId: organization.id,
        scope: "org",
        authorId: null,
        teamIds: [],
      },
    });

    expect(filtered.map((server) => server.id)).toEqual(["org-owned"]);
  });

  test("filters team credentials by the target teams", async ({
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const requester = await makeUser();
    const selectedTeam = await makeTeam(organization.id, requester.id, {
      name: "Selected Team",
    });
    const otherTeam = await makeTeam(organization.id, requester.id, {
      name: "Other Team",
    });
    const selectedOwner = await makeUser();
    const otherOwner = await makeUser();
    await makeTeamMember(selectedTeam.id, selectedOwner.id);
    await makeTeamMember(otherTeam.id, otherOwner.id);

    const isUserInAnyTeamSpy = vi.spyOn(TeamModel, "isUserInAnyTeam");

    const filtered = await filterMcpServersAssignableToTarget({
      mcpServers: [
        {
          id: "selected-owner",
          ownerId: selectedOwner.id,
          teamId: null,
          scope: "personal",
        },
        {
          id: "other-owner",
          ownerId: otherOwner.id,
          teamId: null,
          scope: "personal",
        },
        {
          id: "selected-team",
          ownerId: requester.id,
          teamId: selectedTeam.id,
          scope: "team",
        },
        {
          id: "other-team",
          ownerId: requester.id,
          teamId: otherTeam.id,
          scope: "team",
        },
      ],
      target: {
        organizationId: organization.id,
        scope: "team",
        authorId: requester.id,
        teamIds: [selectedTeam.id],
      },
    });

    expect(filtered.map((server) => server.id)).toEqual(["selected-team"]);
    expect(isUserInAnyTeamSpy).not.toHaveBeenCalled();

    isUserInAnyTeamSpy.mockRestore();
  });

  test("uses the author's team IDs once for personal target filtering", async ({
    makeMember,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const author = await makeUser();
    await makeMember(author.id, organization.id, { role: "member" });
    const authorTeam = await makeTeam(organization.id, author.id, {
      name: "Author Team",
    });
    const otherTeam = await makeTeam(organization.id, author.id, {
      name: "Other Team",
    });
    await makeTeamMember(authorTeam.id, author.id);

    const getUserTeamIdsSpy = vi.spyOn(TeamModel, "getUserTeamIds");
    const isUserInAnyTeamSpy = vi.spyOn(TeamModel, "isUserInAnyTeam");

    const filtered = await filterMcpServersAssignableToTarget({
      mcpServers: [
        {
          id: "own-personal",
          ownerId: author.id,
          teamId: null,
          scope: "personal",
        },
        {
          id: "other-personal",
          ownerId: crypto.randomUUID(),
          teamId: null,
          scope: "personal",
        },
        {
          id: "author-team",
          ownerId: null,
          teamId: authorTeam.id,
          scope: "team",
        },
        {
          id: "other-team",
          ownerId: null,
          teamId: otherTeam.id,
          scope: "team",
        },
        { id: "org-owned", ownerId: null, teamId: null, scope: "personal" },
      ],
      target: {
        organizationId: organization.id,
        scope: "personal",
        authorId: author.id,
        teamIds: [],
      },
    });

    expect(filtered.map((server) => server.id)).toEqual(["author-team"]);
    expect(getUserTeamIdsSpy).toHaveBeenCalledTimes(1);
    expect(isUserInAnyTeamSpy).not.toHaveBeenCalled();

    getUserTeamIdsSpy.mockRestore();
    isUserInAnyTeamSpy.mockRestore();
  });

  test("includes team-scoped servers when filtering for an org-scoped target", async ({
    makeOrganization,
    makeTeam,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const requester = await makeUser();
    const team = await makeTeam(organization.id, requester.id, {
      name: "Some Team",
    });

    const filtered = await filterMcpServersAssignableToTarget({
      mcpServers: [
        {
          id: "team-server",
          ownerId: requester.id,
          teamId: team.id,
          scope: "team",
        },
      ],
      target: {
        organizationId: organization.id,
        scope: "org",
        authorId: null,
        teamIds: [],
      },
    });

    expect(filtered.map((server) => server.id)).toEqual(["team-server"]);
  });
});

describe("isMcpServerAssignableToTarget", () => {
  test("org-scoped server is assignable to org-scoped target", async () => {
    const assignable = await isMcpServerAssignableToTarget({
      mcpServer: {
        ownerId: "admin-owner",
        teamId: null,
        scope: "org",
      },
      target: {
        organizationId: "org-1",
        scope: "org",
        authorId: null,
        teamIds: [],
      },
    });

    expect(assignable).toBe(true);
  });

  test("org-scoped server is assignable to team-scoped target", async () => {
    const assignable = await isMcpServerAssignableToTarget({
      mcpServer: {
        ownerId: "admin-owner",
        teamId: null,
        scope: "org",
      },
      target: {
        organizationId: "org-1",
        scope: "team",
        authorId: null,
        teamIds: ["team-a"],
      },
    });

    expect(assignable).toBe(true);
  });

  test("team-scoped server is assignable to a team target that includes its team", async () => {
    const assignable = await isMcpServerAssignableToTarget({
      mcpServer: {
        ownerId: "owner-1",
        teamId: "team-a",
        scope: "team",
      },
      target: {
        organizationId: "org-1",
        scope: "team",
        authorId: null,
        teamIds: ["team-a", "team-b"],
      },
    });

    expect(assignable).toBe(true);
  });

  test("team-scoped server is not assignable to a team target that does not include its team", async () => {
    const assignable = await isMcpServerAssignableToTarget({
      mcpServer: {
        ownerId: "owner-1",
        teamId: "team-a",
        scope: "team",
      },
      target: {
        organizationId: "org-1",
        scope: "team",
        authorId: null,
        teamIds: ["team-b"],
      },
    });

    expect(assignable).toBe(false);
  });

  test("team-scoped server is assignable to org-scoped target", async () => {
    const assignable = await isMcpServerAssignableToTarget({
      mcpServer: {
        ownerId: "owner-1",
        teamId: "team-a",
        scope: "team",
      },
      target: {
        organizationId: "org-1",
        scope: "org",
        authorId: null,
        teamIds: [],
      },
    });

    expect(assignable).toBe(true);
  });

  test("team-scoped server with no teamId is not assignable", async () => {
    const assignable = await isMcpServerAssignableToTarget({
      mcpServer: {
        ownerId: "owner-1",
        teamId: null,
        scope: "team",
      },
      target: {
        organizationId: "org-1",
        scope: "team",
        authorId: null,
        teamIds: ["team-a"],
      },
    });

    expect(assignable).toBe(false);
  });
});
