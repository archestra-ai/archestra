import { PGlite } from "@electric-sql/pglite";
import { vi } from "vitest";
import { betterAuth } from "@/auth";
import TeamLabelModel from "@/models/team-label";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import teamRoutes from "./team";

describe("team metadata lists", () => {
  const ctx = useRouteTestApp(teamRoutes);
  beforeEach(() => {
    vi.spyOn(betterAuth.api, "getSession").mockResolvedValue({
      user: { id: ctx.user.id },
    } as never);
  });
  afterEach(() => vi.restoreAllMocks());

  for (const role of ["admin", "member"] as const) {
    test(`matches % and _ in a ${role}'s name filter literally`, async ({
      makeMember,
      makeTeam,
      makeTeamMember,
    }) => {
      await makeMember(ctx.user.id, ctx.organizationId, { role });
      for (const name of ["Sales 100%", "Ops_Team", "OpsXTeam", "Design"]) {
        const team = await makeTeam(ctx.organizationId, ctx.user.id, { name });
        await makeTeamMember(team.id, ctx.user.id);
      }

      const names = async (filter: string) => {
        const response = await ctx.app.inject({
          method: "GET",
          url: `/api/teams?includeMembers=false&name=${encodeURIComponent(filter)}`,
        });
        expect(response.statusCode, response.body).toBe(200);
        return response
          .json()
          .data.map((team: { name: string }) => team.name)
          .sort();
      };

      expect(await names("%")).toEqual(["Sales 100%"]);
      expect(await names("ops_")).toEqual(["Ops_Team"]);
    });
  }

  for (const role of ["admin", "member"] as const) {
    test(`preserves ${role} visibility, filters, pagination and membership role`, async ({
      makeMember,
      makeUser,
      makeOrganization,
      makeTeam,
      makeTeamMember,
    }) => {
      await makeMember(ctx.user.id, ctx.organizationId, { role });
      const other = await makeUser();
      const parent = await makeTeam(ctx.organizationId, other.id, {
        name: "Alpha",
        description: "Parent team",
      });
      const child = await makeTeam(ctx.organizationId, other.id, {
        name: "Beta",
        parentId: parent.id,
      });
      await makeTeam(ctx.organizationId, other.id, { name: "Gamma" });
      await makeTeamMember(parent.id, ctx.user.id, { role: "admin" });
      await makeTeamMember(child.id, ctx.user.id, { role: "member" });
      await makeTeamMember(parent.id, other.id);
      await TeamLabelModel.syncTeamLabels(parent.id, [
        { key: "tier", value: "one" },
      ]);
      const foreign = await makeOrganization();
      const foreignTeam = await makeTeam(foreign.id, other.id, {
        name: "Foreign",
      });

      for (const query of [
        "limit=100&offset=0",
        "limit=1&offset=1",
        "name=ALP",
        "labels=tier:one",
        "labels=tier:missing",
        "mine=true",
      ]) {
        const full = await ctx.app.inject({
          method: "GET",
          url: `/api/teams?${query}`,
        });
        const light = await ctx.app.inject({
          method: "GET",
          url: `/api/teams?${query}&includeRelations=false`,
        });
        expect(full.statusCode, full.body).toBe(200);
        expect(light.statusCode, light.body).toBe(200);
        const expected = full.json();
        expected.data = expected.data.map(
          ({
            members: _members,
            labels: _labels,
            descendantTeams: _descendants,
            ...team
          }: Record<string, unknown>) => team,
        );
        expect(light.json()).toEqual(expected);
        expect(
          light.json().data.map((team: { id: string }) => team.id),
        ).not.toContain(foreignTeam.id);
        if (query === "mine=true" || role === "member") {
          expect(
            light
              .json()
              .data.every(
                (team: { myRole?: string }) => team.myRole !== undefined,
              ),
          ).toBe(true);
        }
      }
      const full = (
        await ctx.app.inject({ method: "GET", url: "/api/teams?name=Alpha" })
      ).json();
      expect(full.data[0].members).toHaveLength(2);
      expect(full.data[0].labels).toEqual([
        expect.objectContaining({ key: "tier", value: "one" }),
      ]);
      expect(full.data[0].descendantTeams).toEqual([
        { id: child.id, name: child.name },
      ]);
    });
  }

  for (const role of ["admin", "member"] as const) {
    test(`returns memberCount in every mode and omits only members with includeMembers=false for ${role}`, async ({
      makeMember,
      makeUser,
      makeTeam,
      makeTeamMember,
    }) => {
      await makeMember(ctx.user.id, ctx.organizationId, { role });
      const other = await makeUser();
      const third = await makeUser();
      const parent = await makeTeam(ctx.organizationId, other.id, {
        name: "Alpha",
      });
      const child = await makeTeam(ctx.organizationId, other.id, {
        name: "Beta",
        parentId: parent.id,
      });
      await makeTeamMember(parent.id, ctx.user.id, { role: "admin" });
      await makeTeamMember(parent.id, other.id);
      await makeTeamMember(parent.id, third.id);
      await makeTeamMember(child.id, ctx.user.id);
      await TeamLabelModel.syncTeamLabels(parent.id, [
        { key: "tier", value: "one" },
      ]);
      const expectedCounts = { Alpha: 3, Beta: 1 };

      for (const base of [
        "limit=100&offset=0",
        "limit=1&offset=1",
        "name=ALP",
        "labels=tier:one",
        "mine=true",
      ]) {
        const [full, withoutMembers, light] = await Promise.all(
          ["", "&includeMembers=false", "&includeRelations=false"].map(
            async (suffix) => {
              const response = await ctx.app.inject({
                method: "GET",
                url: `/api/teams?${base}${suffix}`,
              });
              expect(response.statusCode, response.body).toBe(200);
              return response.json();
            },
          ),
        );
        for (const body of [full, withoutMembers, light]) {
          expect(body.data.length).toBeGreaterThan(0);
          for (const team of body.data as Array<{
            name: keyof typeof expectedCounts;
            memberCount: number;
          }>) {
            expect(team.memberCount).toBe(expectedCounts[team.name]);
          }
        }
        for (const team of full.data) {
          expect(team.members).toHaveLength(team.memberCount);
        }
        expect(withoutMembers.pagination).toEqual(full.pagination);
        expect(withoutMembers.data).toEqual(
          full.data.map(
            ({ members: _members, ...team }: Record<string, unknown>) => team,
          ),
        );
      }

      const alpha = (
        await ctx.app.inject({
          method: "GET",
          url: "/api/teams?name=Alpha&includeMembers=false",
        })
      ).json().data[0];
      expect(alpha).not.toHaveProperty("members");
      expect(alpha.labels).toEqual([
        expect.objectContaining({ key: "tier", value: "one" }),
      ]);
      expect(alpha.descendantTeams).toEqual([
        { id: child.id, name: child.name },
      ]);
    });
  }

  test("counts members with a fixed number of queries per page", async ({
    makeMember,
    makeUser,
    makeTeam,
    makeTeamMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const users = await Promise.all([makeUser(), makeUser(), makeUser()]);
    const teams = [];
    for (const name of ["A1", "A2", "A3", "A4", "A5", "A6"]) {
      const team = await makeTeam(ctx.organizationId, users[0].id, { name });
      teams.push(team);
      for (const user of users) await makeTeamMember(team.id, user.id);
    }

    const countQueries = async (url: string) => {
      const query = vi.spyOn(PGlite.prototype, "query");
      const response = await ctx.app.inject({ method: "GET", url });
      const calls = query.mock.calls.length;
      query.mockRestore();
      expect(response.statusCode, response.body).toBe(200);
      return { calls, data: response.json().data };
    };

    for (const suffix of ["&includeRelations=false", "&includeMembers=false"]) {
      const onePage = await countQueries(`/api/teams?limit=1${suffix}`);
      const sixPage = await countQueries(`/api/teams?limit=6${suffix}`);
      expect(onePage.data).toHaveLength(1);
      expect(sixPage.data).toHaveLength(6);
      expect(
        sixPage.data.map((team: { memberCount: number }) => team.memberCount),
      ).toEqual([3, 3, 3, 3, 3, 3]);
      expect(onePage.calls).toBeGreaterThan(0);
      expect(sixPage.calls).toBe(onePage.calls);
    }
  });
});
