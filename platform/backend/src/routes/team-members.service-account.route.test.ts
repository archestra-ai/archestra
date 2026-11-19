import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { TeamModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { SelectServiceAccount } from "@/types";

// A service-account token (what infrastructure as code uses) is authorized by
// the service account's role, not by a session: there is none.
describe("team membership with a service-account token", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let teamId: string;
  let memberUserId: string;
  let serviceAccount: SelectServiceAccount;

  beforeEach(async ({ makeOrganization, makeUser, makeMember, makeTeam }) => {
    organizationId = (await makeOrganization()).id;
    const creator = await makeUser();
    await makeMember(creator.id, organizationId, { role: ADMIN_ROLE_NAME });
    teamId = (await makeTeam(organizationId, creator.id)).id;
    const member = await makeUser();
    await makeMember(member.id, organizationId);
    memberUserId = member.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      // As the auth middleware does for a service-account token.
      Object.assign(request, {
        organizationId,
        serviceAccount,
        authMethod: "service_account",
        user: {
          id: `service-account:${serviceAccount.id}`,
          name: serviceAccount.name,
          email: `${serviceAccount.id}@service-account.local`,
          emailVerified: true,
          image: null,
          createdAt: serviceAccount.createdAt,
          updatedAt: serviceAccount.updatedAt,
          role: null,
          banned: false,
          banReason: null,
          banExpires: null,
          twoFactorEnabled: false,
        },
      });
    });
    const { default: teamRoutes } = await import("./team");
    await app.register(teamRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("an admin service account adds a member to a team it does not belong to", async ({
    makeServiceAccount,
  }) => {
    serviceAccount = await makeServiceAccount(organizationId, {
      role: ADMIN_ROLE_NAME,
    });

    const response = await addMember();

    expect(response.statusCode, response.body).toBe(200);
    expect(await TeamModel.isUserInTeam(teamId, memberUserId)).toBe(true);
  });

  test("an admin service account reads the members of a team it does not belong to", async ({
    makeServiceAccount,
  }) => {
    serviceAccount = await makeServiceAccount(organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    await addMember();

    const response = await app.inject({
      method: "GET",
      url: `/api/teams/${teamId}/members`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().map((m: { userId: string }) => m.userId)).toContain(
      memberUserId,
    );
  });

  test("a member service account cannot", async ({ makeServiceAccount }) => {
    serviceAccount = await makeServiceAccount(organizationId, {
      role: MEMBER_ROLE_NAME,
    });

    const response = await addMember();

    expect(response.statusCode).toBe(403);
    expect(await TeamModel.isUserInTeam(teamId, memberUserId)).toBe(false);
  });

  function addMember() {
    return app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/members`,
      payload: { userId: memberUserId, role: MEMBER_ROLE_NAME },
    });
  }
});
