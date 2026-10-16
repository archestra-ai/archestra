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
});
