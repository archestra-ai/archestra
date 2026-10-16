import organizationRoutes from "@/routes/organization";
import { describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";

describe("member options with real role authorization", () => {
  const ctx = useRouteTestApp(organizationRoutes);
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
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/organization/member-options",
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toEqual([
      { id: teammate.id, name: teammate.name, email: teammate.email },
    ]);
    const selected = await ctx.app.inject({
      method: "GET",
      url: `/api/organization/member-options?ids=${stranger.id}`,
    });
    expect(selected.json().data).toEqual([]);
  });
  test("member:read permits directory identities without exposing role metadata", async ({
    makeUser,
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const other = await makeUser();
    await makeMember(other.id, ctx.organizationId);
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/organization/member-options",
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      response
        .json()
        .data.map((row: { id: string }) => row.id)
        .sort(),
    ).toEqual([ctx.user.id, other.id].sort());
    for (const row of response.json().data)
      expect(Object.keys(row).sort()).toEqual(["email", "id", "name"]);
  });
});
