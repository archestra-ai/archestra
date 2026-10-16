import { vi } from "vitest";
import { betterAuth } from "@/auth";
import TeamModel from "@/models/team";
import TeamLabelModel from "@/models/team-label";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import teamRoutes from "./team";

describe("single team and team member pages", () => {
  const ctx = useRouteTestApp(teamRoutes);
  beforeEach(() => {
    vi.spyOn(betterAuth.api, "getSession").mockResolvedValue({
      user: { id: ctx.user.id },
    } as never);
  });
  afterEach(() => vi.restoreAllMocks());

  test("pages members by name, searches name and email, and filters by user ids", async ({
    makeMember,
    makeUser,
    makeTeam,
    makeTeamMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const team = await makeTeam(ctx.organizationId, ctx.user.id);
    const names = ["Dana Fox", "Ada Lovelace", "Carl Gauss", "Bea Noether"];
    const users = [];
    for (const name of names) {
      const user = await makeUser({
        name,
        email: `${name.split(" ")[0].toLowerCase()}@example.com`,
      });
      await makeTeamMember(team.id, user.id);
      users.push(user);
    }
    const outsider = await makeUser({ name: "Eve Outside" });
    const loadAllMembers = vi.spyOn(TeamModel, "getTeamMembers");

    const first = await ctx.app.inject({
      method: "GET",
      url: `/api/teams/${team.id}/members/page?limit=2&offset=0`,
    });
    const second = await ctx.app.inject({
      method: "GET",
      url: `/api/teams/${team.id}/members/page?limit=2&offset=2`,
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().data.map((m: { name: string }) => m.name)).toEqual([
      "Ada Lovelace",
      "Bea Noether",
    ]);
    expect(first.json().pagination).toMatchObject({
      total: 4,
      totalPages: 2,
      hasNext: true,
    });
    expect(second.json().data.map((m: { name: string }) => m.name)).toEqual([
      "Carl Gauss",
      "Dana Fox",
    ]);
    expect(first.json().data[0]).toMatchObject({
      teamId: team.id,
      role: "member",
      email: "ada@example.com",
    });

    const search = await ctx.app.inject({
      method: "GET",
      url: `/api/teams/${team.id}/members/page?search=${encodeURIComponent("LOVELACE ada")}`,
    });
    expect(search.json().data.map((m: { name: string }) => m.name)).toEqual([
      "Ada Lovelace",
    ]);
    const byEmail = await ctx.app.inject({
      method: "GET",
      url: `/api/teams/${team.id}/members/page?search=carl%40`,
    });
    expect(byEmail.json().pagination.total).toBe(1);

    const byIds = await ctx.app.inject({
      method: "GET",
      url: `/api/teams/${team.id}/members/page?userIds=${users[0].id},${outsider.id}`,
    });
    expect(byIds.json().data.map((m: { userId: string }) => m.userId)).toEqual([
      users[0].id,
    ]);
    expect(loadAllMembers).not.toHaveBeenCalled();
  });

  test("hides another organization's team and a team the member cannot read", async ({
    makeMember,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "member" });
    const other = await makeUser();
    const own = await makeTeam(ctx.organizationId, other.id);
    const notMine = await makeTeam(ctx.organizationId, other.id);
    await makeTeamMember(own.id, ctx.user.id);
    const foreign = await makeOrganization();
    const foreignTeam = await makeTeam(foreign.id, other.id);

    const readable = await ctx.app.inject({
      method: "GET",
      url: `/api/teams/${own.id}/members/page`,
    });
    expect(readable.statusCode, readable.body).toBe(200);
    for (const teamId of [notMine.id, foreignTeam.id]) {
      const response = await ctx.app.inject({
        method: "GET",
        url: `/api/teams/${teamId}/members/page`,
      });
      expect(response.statusCode).toBe(404);
    }
  });

  test("returns a single team without members on request, with the caller's role", async ({
    makeMember,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const other = await makeUser();
    const team = await makeTeam(ctx.organizationId, other.id, {
      name: "Platform",
    });
    const notJoined = await makeTeam(ctx.organizationId, other.id);
    await makeTeamMember(team.id, ctx.user.id, { role: "admin" });
    await makeTeamMember(team.id, other.id);
    await TeamLabelModel.syncTeamLabels(team.id, [
      { key: "area", value: "engineering" },
    ]);

    const full = await ctx.app.inject({
      method: "GET",
      url: `/api/teams/${team.id}`,
    });
    expect(full.statusCode, full.body).toBe(200);
    expect(full.json().members).toHaveLength(2);
    expect(full.json().myRole).toBe("admin");

    const loadAllMembers = vi.spyOn(TeamModel, "getTeamMembers");
    const compact = await ctx.app.inject({
      method: "GET",
      url: `/api/teams/${team.id}?includeMembers=false`,
    });
    expect(compact.statusCode, compact.body).toBe(200);
    expect(compact.json()).not.toHaveProperty("members");
    expect(compact.json()).toMatchObject({
      id: team.id,
      name: "Platform",
      myRole: "admin",
      labels: [expect.objectContaining({ key: "area", value: "engineering" })],
    });
    expect(loadAllMembers).not.toHaveBeenCalled();

    // An organization team manager who is not in the team has no team role.
    const managerOnly = await ctx.app.inject({
      method: "GET",
      url: `/api/teams/${notJoined.id}?includeMembers=false`,
    });
    expect(managerOnly.statusCode, managerOnly.body).toBe(200);
    expect(managerOnly.json()).not.toHaveProperty("myRole");
  });

  test("keeps the full member list route unchanged", async ({
    makeMember,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const team = await makeTeam(ctx.organizationId, ctx.user.id);
    for (const name of ["Zed", "Amy", "Max"]) {
      await makeTeamMember(team.id, (await makeUser({ name })).id);
    }

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/teams/${team.id}/members`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().map((m: { name: string }) => m.name)).toEqual([
      "Amy",
      "Max",
      "Zed",
    ]);
  });
});
