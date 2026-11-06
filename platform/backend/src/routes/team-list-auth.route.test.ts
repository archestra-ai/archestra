import { vi } from "vitest";
import { auth as betterAuth } from "@/auth/better-auth";
import { authPlugin } from "@/auth/fastify-plugin/plugin";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import MemberModel from "@/models/member";
import ServiceAccountModel from "@/models/service-account";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { recordQueries } from "@/test/query-counter";
import teamRoutes from "./team";

describe("team listing authenticated caller", () => {
  let app: FastifyInstanceWithZod;

  beforeEach(async () => {
    app = createFastifyInstance();
    await app.register(authPlugin);
    await app.register(teamRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("resolves identity once and reads fresh team permissions on the next request", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeSession,
    makeTeam,
    makeTeamMember,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id, { role: "admin" });
    const session = await makeSession(user.id, {
      activeOrganizationId: organization.id,
    });
    const ownTeam = await makeTeam(organization.id, user.id);
    const otherTeam = await makeTeam(organization.id, user.id);
    await makeTeamMember(ownTeam.id, user.id);
    const getSession = vi.spyOn(betterAuth.api, "getSession");
    getSession.mockImplementation(async (options) => {
      const response = { user, session };
      return (
        options?.returnHeaders ? { response, headers: new Headers() } : response
      ) as never;
    });

    const list = () =>
      app.inject({ method: "GET", url: "/api/teams?includeRelations=false" });
    const admin = await recordQueries(list);
    expect(admin.result.statusCode, admin.result.body).toBe(200);
    expect(
      admin.result.json().data.map((team: { id: string }) => team.id),
    ).toEqual(expect.arrayContaining([ownTeam.id, otherTeam.id]));
    expect(identityReads(admin.statements)).toHaveLength(1);
    expect(getSession).toHaveBeenCalledTimes(1);

    const mine = await app.inject({
      method: "GET",
      url: "/api/teams?mine=true&includeRelations=false",
    });
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json().data.map((team: { id: string }) => team.id)).toEqual([
      ownTeam.id,
    ]);

    await MemberModel.updateRole(user.id, organization.id, "member");
    getSession.mockClear();
    const member = await recordQueries(list);
    expect(member.result.statusCode, member.result.body).toBe(200);
    expect(
      member.result.json().data.map((team: { id: string }) => team.id),
    ).toEqual([ownTeam.id]);
    expect(identityReads(member.statements)).toHaveLength(1);
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  test("uses the authenticated service account's organization permissions", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
  }) => {
    const organization = await makeOrganization();
    const creator = await makeUser();
    await makeMember(creator.id, organization.id, { role: "admin" });
    const team = await makeTeam(organization.id, creator.id);
    const account = await ServiceAccountModel.create({
      organizationId: organization.id,
      name: "Team reader",
      role: "admin",
      createdBy: creator.id,
    });
    const token = await ServiceAccountModel.createToken({
      serviceAccountId: account.id,
      organizationId: organization.id,
      name: "Team listing",
    });
    const getSession = vi
      .spyOn(betterAuth.api, "getSession")
      .mockResolvedValue(null);

    const response = await app.inject({
      method: "GET",
      url: "/api/teams?includeRelations=false",
      headers: { authorization: token.token },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.map((item: { id: string }) => item.id)).toEqual(
      [team.id],
    );
    expect(getSession).toHaveBeenCalledTimes(1);
  });
});

function identityReads(statements: string[]) {
  return statements.filter((statement) =>
    statement.includes('from "user" inner join "member"'),
  );
}
