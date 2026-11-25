import { ADMIN_ROLE_NAME, RouteId } from "@archestra/shared";
import { requiredEndpointPermissionsMap } from "@archestra/shared/access-control";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import memberRoutes from "./member";

describe("GET /api/members/:userId/owned-resources", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeAdmin, makeMember, makeOrganization }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { organizationId, user });
    });
    await app.register(memberRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("lists what moves to a new owner, with who uses it, and counts what is deleted", async ({
    makeInternalAgent,
    makeMember,
    makeSkill,
    makeTeam,
    makeUser,
  }) => {
    const member = await makeUser();
    await makeMember(member.id, organizationId);
    const colleague = await makeUser();
    await makeMember(colleague.id, organizationId);
    const team = await makeTeam(organizationId, user.id, {
      name: "Support team",
    });
    const teamAgent = await makeInternalAgent({
      organizationId,
      authorId: member.id,
      name: "Support triage",
      access: { teams: [team.id] },
    });
    const sharedSkill = await makeSkill(organizationId, {
      authorId: member.id,
      access: { users: [colleague.id] },
    });
    await makeInternalAgent({
      organizationId,
      authorId: member.id,
      access: "personal",
    });
    await makeInternalAgent({
      organizationId,
      authorId: member.id,
      access: "personal",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/members/${member.id}/owned-resources`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.shared).toEqual(
      expect.arrayContaining([
        {
          id: teamAgent.id,
          kind: "agent",
          name: "Support triage",
          sharedWith: {
            organization: false,
            teams: ["Support team"],
            people: 0,
          },
        },
        {
          id: sharedSkill.id,
          kind: "skill",
          name: sharedSkill.name,
          sharedWith: { organization: false, teams: [], people: 1 },
        },
      ]),
    );
    expect(body.shared).toHaveLength(2);
    expect(body.personal).toEqual([{ kind: "agent", count: 2 }]);
  });

  test("answers 404 for someone outside the organization", async ({
    makeUser,
  }) => {
    const outsider = await makeUser();
    const response = await app.inject({
      method: "GET",
      url: `/api/members/${outsider.id}/owned-resources`,
    });
    expect(response.statusCode).toBe(404);
  });

  test("requires member delete permission", () => {
    expect(
      requiredEndpointPermissionsMap[RouteId.GetMemberOwnedResources],
    ).toEqual({ member: ["delete"] });
  });
});
