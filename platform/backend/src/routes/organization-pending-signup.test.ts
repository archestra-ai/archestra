import { AUTO_PROVISIONED_INVITATION_STATUS } from "@archestra/shared";
import InvitationModel from "@/models/invitation";
import MemberModel from "@/models/member";
import UserModel from "@/models/user";
import UserTokenModel from "@/models/user-token";
import { secretManager } from "@/secrets-manager";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("organization pending signup routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(
    async ({ makeAccount, makeAdmin, makeMember, makeOrganization }) => {
      user = await makeAdmin();
      await makeAccount(user.id);
      const organization = await makeOrganization();
      organizationId = organization.id;
      await makeMember(user.id, organizationId, { role: "admin" });

      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        (request as typeof request & { user: unknown }).user = user;
        (
          request as typeof request & { organizationId: string }
        ).organizationId = organizationId;
      });

      const { default: organizationRoutes } = await import("./organization");
      await app.register(organizationRoutes);
    },
  );

  afterEach(async () => {
    await app.close();
  });

  test("signup status uses auto-provisioned invitation metadata from the current organization", async ({
    makeInvitation,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const otherOrganization = await makeOrganization();
    const pendingUser = await makeUser({
      email: "pending-status@example.com",
      emailVerified: false,
    });
    await makeMember(pendingUser.id, organizationId, { role: "member" });

    const currentOrgInvitation = await makeInvitation(organizationId, user.id, {
      email: pendingUser.email,
      status: `${AUTO_PROVISIONED_INVITATION_STATUS}:slack`,
    });
    await makeInvitation(otherOrganization.id, user.id, {
      email: pendingUser.email,
      status: `${AUTO_PROVISIONED_INVITATION_STATUS}:ms-teams`,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/organization/members/signup-status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().pendingSignupMembers).toEqual([
      expect.objectContaining({
        userId: pendingUser.id,
        provider: "slack",
        invitationId: currentOrgInvitation.id,
      }),
    ]);
  });

  test("deleting a pending signup member only cleans up the current organization", async ({
    makeInvitation,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const otherOrganization = await makeOrganization();
    const pendingUser = await makeUser({
      email: "pending-delete@example.com",
      emailVerified: false,
    });
    await makeMember(pendingUser.id, organizationId, { role: "member" });
    await makeMember(pendingUser.id, otherOrganization.id, { role: "member" });

    const currentOrgInvitation = await makeInvitation(organizationId, user.id, {
      email: pendingUser.email,
      status: `${AUTO_PROVISIONED_INVITATION_STATUS}:slack`,
    });
    const otherOrgInvitation = await makeInvitation(
      otherOrganization.id,
      user.id,
      {
        email: pendingUser.email,
        status: `${AUTO_PROVISIONED_INVITATION_STATUS}:ms-teams`,
      },
    );

    const response = await app.inject({
      method: "DELETE",
      url: `/api/organization/members/${pendingUser.id}/pending-signup`,
    });

    expect(response.statusCode).toBe(200);
    expect(
      await InvitationModel.getById(currentOrgInvitation.id),
    ).toBeUndefined();
    expect(await InvitationModel.getById(otherOrgInvitation.id)).toBeDefined();
    expect(
      await MemberModel.getByUserId(pendingUser.id, organizationId),
    ).toBeUndefined();
    expect(
      await MemberModel.getByUserId(pendingUser.id, otherOrganization.id),
    ).toBeDefined();
    expect(await UserModel.getById(pendingUser.id)).toBeDefined();
  });

  test("deleting a pending signup member without other memberships deletes the user and token secret", async ({
    makeInvitation,
    makeMember,
    makeUser,
  }) => {
    const pendingUser = await makeUser({
      email: "pending-delete-only-org@example.com",
      emailVerified: false,
    });
    await makeMember(pendingUser.id, organizationId, { role: "member" });

    const invitation = await makeInvitation(organizationId, user.id, {
      email: pendingUser.email,
      status: `${AUTO_PROVISIONED_INVITATION_STATUS}:slack`,
    });
    const { token } = await UserTokenModel.create(
      pendingUser.id,
      organizationId,
    );
    expect(await secretManager().getSecret(token.secretId)).not.toBeNull();

    const response = await app.inject({
      method: "DELETE",
      url: `/api/organization/members/${pendingUser.id}/pending-signup`,
    });

    expect(response.statusCode).toBe(200);
    expect(await InvitationModel.getById(invitation.id)).toBeUndefined();
    expect(
      await MemberModel.getByUserId(pendingUser.id, organizationId),
    ).toBeUndefined();
    expect(await UserModel.findByEmail(pendingUser.email)).toBeUndefined();
    expect(
      await UserTokenModel.findByUserAndOrg(pendingUser.id, organizationId),
    ).toBeNull();
    expect(await secretManager().getSecret(token.secretId)).toBeNull();
  });

  test("rejects deleting a member who has completed signup", async ({
    makeAccount,
    makeInvitation,
    makeMember,
    makeUser,
  }) => {
    const signedUpUser = await makeUser({
      email: "signed-up@example.com",
    });
    await makeAccount(signedUpUser.id);
    await makeMember(signedUpUser.id, organizationId, { role: "member" });
    const invitation = await makeInvitation(organizationId, user.id, {
      email: signedUpUser.email,
      status: `${AUTO_PROVISIONED_INVITATION_STATUS}:slack`,
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/organization/members/${signedUpUser.id}/pending-signup`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe(
      "Cannot delete a member who has already completed signup",
    );
    expect(await InvitationModel.getById(invitation.id)).toBeDefined();
    expect(
      await MemberModel.getByUserId(signedUpUser.id, organizationId),
    ).toBeDefined();
    expect(await UserModel.findByEmail(signedUpUser.email)).toBeDefined();
  });

  test("returns 404 when the user is not a member of the current organization", async ({
    makeUser,
  }) => {
    const outsideUser = await makeUser({
      email: "outside-current-org@example.com",
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/organization/members/${outsideUser.id}/pending-signup`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toBe("Member not found");
    expect(await UserModel.findByEmail(outsideUser.email)).toBeDefined();
  });
});
