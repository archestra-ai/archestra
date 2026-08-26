import { AUTO_PROVISIONED_INVITATION_STATUS } from "@archestra/shared";
import {
  InvitationModel,
  MemberModel,
  UserModel,
  UserTokenModel,
} from "@/models";
import { describe, expect, test } from "@/test";
import { removeMemberTarget } from "./member-removal";

describe("removeMemberTarget", () => {
  test("withdraws only this organization's pending invitation and retains a user with another membership", async ({
    makeInvitation,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const otherOrganization = await makeOrganization();
    const actor = await makeUser();
    const pendingUser = await makeUser({ email: "pending@example.com" });
    await makeMember(pendingUser.id, organization.id);
    await makeMember(pendingUser.id, otherOrganization.id);
    const invitation = await makeInvitation(organization.id, actor.id, {
      email: pendingUser.email,
      status: `${AUTO_PROVISIONED_INVITATION_STATUS}:slack`,
    });
    const otherInvitation = await makeInvitation(
      otherOrganization.id,
      actor.id,
      {
        email: pendingUser.email,
        status: `${AUTO_PROVISIONED_INVITATION_STATUS}:slack`,
      },
    );

    await expect(
      removeMemberTarget({
        organizationId: organization.id,
        actorUserId: actor.id,
        target: { kind: "pendingSignup", id: pendingUser.id },
      }),
    ).resolves.toEqual({ status: "removed" });

    expect(
      await MemberModel.getByUserId(pendingUser.id, organization.id),
    ).toBeUndefined();
    expect(
      await MemberModel.getByUserId(pendingUser.id, otherOrganization.id),
    ).toBeDefined();
    expect(await InvitationModel.getById(invitation.id)).toBeUndefined();
    expect(await InvitationModel.getById(otherInvitation.id)).toBeDefined();
    expect(await UserModel.getById(pendingUser.id)).toBeDefined();
  });

  test("runs accepted-member cleanup after removing a last membership", async ({
    makeAccount,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const actor = await makeUser();
    const acceptedUser = await makeUser();
    const member = await makeMember(acceptedUser.id, organization.id);
    const duplicate = await makeMember(acceptedUser.id, organization.id);
    await makeAccount(acceptedUser.id);

    await expect(
      removeMemberTarget({
        organizationId: organization.id,
        actorUserId: actor.id,
        target: { kind: "member", id: member.id },
      }),
    ).resolves.toEqual({ status: "removed" });

    expect(await MemberModel.getById(member.id)).toBeUndefined();
    expect(await MemberModel.getById(duplicate.id)).toBeUndefined();
    expect(await UserModel.getById(acceptedUser.id)).toBeUndefined();
  });

  test("revokes only the removed organization's token for a multi-org member", async ({
    makeAccount,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const otherOrganization = await makeOrganization();
    const actor = await makeUser();
    const acceptedUser = await makeUser();
    const member = await makeMember(acceptedUser.id, organization.id);
    await makeMember(acceptedUser.id, otherOrganization.id);
    await makeAccount(acceptedUser.id);
    await UserTokenModel.create(acceptedUser.id, organization.id);
    await UserTokenModel.create(acceptedUser.id, otherOrganization.id);

    await expect(
      removeMemberTarget({
        organizationId: organization.id,
        actorUserId: actor.id,
        target: { kind: "member", id: member.id },
      }),
    ).resolves.toEqual({ status: "removed" });

    expect(
      await UserTokenModel.findByUserAndOrg(acceptedUser.id, organization.id),
    ).toBeNull();
    expect(
      await UserTokenModel.findByUserAndOrg(
        acceptedUser.id,
        otherOrganization.id,
      ),
    ).toBeDefined();
    expect(await UserModel.getById(acceptedUser.id)).toBeDefined();
  });
});
