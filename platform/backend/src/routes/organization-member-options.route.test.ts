import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { createFastifyInstance } from "@/fastify-instance";
import organizationRoutes from "@/routes/organization";
import { describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";

type OptionsPage = {
  data: Array<{ id: string; name: string; email: string }>;
  pagination: { nextCursor: string | null };
};

describe("member options with real role authorization", () => {
  const ctx = useRouteTestApp(organizationRoutes);

  async function getOptions(query = "") {
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/organization/member-options${query ? `?${query}` : ""}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as OptionsPage;
  }

  test("a custom log administrator without member:read sees only named teammates", async ({
    makeUser,
    makeMember,
    makeCustomRole,
    makeTeam,
    makeTeamMember,
  }) => {
    const role = await makeCustomRole(ctx.organizationId, {
      permission: { log: ["read", "admin"] },
    });
    await makeMember(ctx.user.id, ctx.organizationId, { role: role.role });
    const teammate = await makeUser({ name: "Named colleague" });
    const stranger = await makeUser({ name: "Unrelated colleague" });
    await makeMember(teammate.id, ctx.organizationId);
    await makeMember(stranger.id, ctx.organizationId);
    const team = await makeTeam(ctx.organizationId, ctx.user.id);
    await makeTeamMember(team.id, ctx.user.id);
    await makeTeamMember(team.id, teammate.id);
    expect((await getOptions()).data).toEqual([
      { id: teammate.id, name: teammate.name, email: teammate.email },
    ]);
    expect((await getOptions(`ids=${stranger.id}`)).data).toEqual([]);
  });

  test("member:read permits directory identities without exposing role metadata", async ({
    makeUser,
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const other = await makeUser();
    await makeMember(other.id, ctx.organizationId);
    const { data } = await getOptions();
    expect(data.map((row) => row.id).sort()).toEqual(
      [ctx.user.id, other.id].sort(),
    );
    for (const row of data)
      expect(Object.keys(row).sort()).toEqual(["email", "id", "name"]);
  });

  test("a member without teams sees nobody", async ({
    makeUser,
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    const other = await makeUser();
    await makeMember(other.id, ctx.organizationId);
    expect((await getOptions()).data).toEqual([]);
  });

  test("a privileged teammate is listed with identity fields only", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    const teammate = await makeUser();
    // A privileged role makes a leak of role fields visible.
    await makeMember(teammate.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const team = await makeTeam(ctx.organizationId, ctx.user.id);
    await makeTeamMember(team.id, ctx.user.id);
    await makeTeamMember(team.id, teammate.id);
    const { data } = await getOptions();
    expect(data).toHaveLength(1);
    expect(Object.keys(data[0]).sort()).toEqual(["email", "id", "name"]);
  });

  test("a team shared only in another organization does not make a teammate", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const orgB = (await makeOrganization()).id;
    const teammate = await makeUser();
    const crossOrg = await makeUser();
    await makeMember(ctx.user.id, ctx.organizationId);
    await makeMember(teammate.id, ctx.organizationId);
    await makeMember(crossOrg.id, ctx.organizationId);
    const teamHere = await makeTeam(ctx.organizationId, ctx.user.id);
    await makeTeamMember(teamHere.id, ctx.user.id);
    await makeTeamMember(teamHere.id, teammate.id);
    // crossOrg is a member of both orgs but shares a team only in orgB.
    await makeMember(ctx.user.id, orgB);
    await makeMember(crossOrg.id, orgB);
    const teamElsewhere = await makeTeam(orgB, ctx.user.id);
    await makeTeamMember(teamElsewhere.id, ctx.user.id);
    await makeTeamMember(teamElsewhere.id, crossOrg.id);
    expect((await getOptions()).data.map((row) => row.id)).toEqual([
      teammate.id,
    ]);
  });

  test("a service account is checked against its own role, not the synthetic user", async ({
    makeUser,
    makeMember,
    makeServiceAccount,
  }) => {
    // The caller user has no member:read and no teams, so it alone would see
    // nobody; the admin service account sees the whole organization.
    await makeMember(ctx.user.id, ctx.organizationId);
    const other = await makeUser();
    await makeMember(other.id, ctx.organizationId);
    const serviceAccount = await makeServiceAccount(ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, {
        user: ctx.user,
        organizationId: ctx.organizationId,
        serviceAccount,
      });
    });
    await app.register(organizationRoutes);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/organization/member-options",
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(
        (response.json() as OptionsPage).data.map((row) => row.id).sort(),
      ).toEqual([ctx.user.id, other.id].sort());
    } finally {
      await app.close();
    }
  });

  for (const canSeeAll of [true, false]) {
    test(`cursor pages preserve directory visibility and name ties (all=${canSeeAll})`, async ({
      makeUser,
      makeMember,
      makeTeam,
      makeTeamMember,
      makeOrganization,
    }) => {
      await makeMember(ctx.user.id, ctx.organizationId, {
        role: canSeeAll ? ADMIN_ROLE_NAME : "member",
      });
      const team = await makeTeam(ctx.organizationId, ctx.user.id);
      await makeTeamMember(team.id, ctx.user.id);
      const teammateIds: string[] = [];
      const allIds = [ctx.user.id];
      for (let index = 0; index < 5; index++) {
        const candidate = await makeUser({
          name: index < 3 ? "Same name" : `Candidate ${index}`,
        });
        await makeMember(candidate.id, ctx.organizationId);
        allIds.push(candidate.id);
        if (index < 4) {
          await makeTeamMember(team.id, candidate.id);
          teammateIds.push(candidate.id);
        }
      }
      const foreign = await makeUser();
      await makeMember(foreign.id, (await makeOrganization()).id);

      const rows: OptionsPage["data"] = [];
      let cursor: string | null = null;
      do {
        const page: OptionsPage = await getOptions(
          `limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        expect(page.data.length).toBeLessThanOrEqual(2);
        rows.push(...page.data);
        cursor = page.pagination.nextCursor;
      } while (cursor);
      const expected = canSeeAll ? allIds : teammateIds;
      expect(rows.map((row) => row.id).sort()).toEqual([...expected].sort());
      expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
      for (const row of rows)
        expect(Object.keys(row).sort()).toEqual(["email", "id", "name"]);
    });
  }

  test("search and exact references stay organization- and teammate-scoped", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeOrganization,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    const teammate = await makeUser({
      name: "Lovelace, Ada M.",
      email: "ada@example.com",
    });
    const privateUser = await makeUser({
      name: "Ada Private",
      email: "private@example.com",
    });
    await makeMember(teammate.id, ctx.organizationId);
    await makeMember(privateUser.id, ctx.organizationId);
    const team = await makeTeam(ctx.organizationId, ctx.user.id);
    await makeTeamMember(team.id, ctx.user.id);
    await makeTeamMember(team.id, teammate.id);
    const elsewhere = await makeOrganization();
    const other = await makeUser({
      name: "Ada Other",
      email: "other@example.com",
    });
    await makeMember(other.id, elsewhere.id);
    const sharedElsewhere = await makeTeam(elsewhere.id, ctx.user.id);
    await makeTeamMember(sharedElsewhere.id, ctx.user.id);
    await makeTeamMember(sharedElsewhere.id, other.id);
    for (const query of [
      "search=Ada%20Lovelace",
      `ids=${[teammate.id, privateUser.id, other.id].join(",")}`,
      "emails=ADA%40EXAMPLE.COM,private%40example.com,other%40example.com",
    ]) {
      expect((await getOptions(query)).data).toEqual([
        { id: teammate.id, name: teammate.name, email: teammate.email },
      ]);
    }
    expect(
      (await getOptions("search=ada%40example.com&searchMode=name")).data,
    ).toEqual([]);
    const invalidLimit = await ctx.app.inject({
      method: "GET",
      url: "/api/organization/member-options?limit=101",
    });
    expect(invalidLimit.statusCode).toBe(400);
  });

  // Behind the full server the auth middleware answers any unregistered
  // /api route with 403 before routing can reply 404.
  test("the full member list route no longer exists", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/organization/members",
    });
    expect(response.statusCode).toBe(404);
  });
});
